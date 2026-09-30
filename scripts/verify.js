#!/usr/bin/env node
'use strict';

// Compose verify 服务入口：
//   1) 构建检查：全部源码/脚本语法检查（node --check）
//   2) 代码测试：node --test
//   3) 接口 / HTTP 冒烟：健康路径、页面、审计接口
//      - 静默环等价规程：审计必须判定等价，关系含两个初始状态对
//      - 缺失匹配动作规程：审计必须判定不等价，且失败依据只引用更早轮次
//      - 无效输入：一次返回全部问题并清除旧结论
//      - 单向轨迹包含：静默环包含成立；缺失动作给出最短反例；
//        双向结果不同的边界；无效输入时轨迹结果被清除
// 完成后退出：全部通过 0，任一失败 1。

const { spawnSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { samples } = require('../src/samples');

const BASE = process.env.WEB_BASE_URL || 'http://127.0.0.1:8080';
const ROOT = path.join(__dirname, '..');

let failures = 0;
function step(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  ✗ ${name}`);
    console.error(String(e && e.stack || e).split('\n').map((l) => `      ${l}`).join('\n'));
  }
}
async function astep(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  ✗ ${name}`);
    console.error(String(e && e.stack || e).split('\n').map((l) => `      ${l}`).join('\n'));
  }
}

function listJs(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? listJs(p) : d.name.endsWith('.js') ? [p] : [];
  });
}

// ---------- 1) 构建检查 ----------
console.log('[1/3] 构建检查（node --check）');
for (const file of [...listJs(path.join(ROOT, 'src')), ...listJs(path.join(ROOT, 'scripts')), ...listJs(path.join(ROOT, 'test'))]) {
  step(`语法检查 ${path.relative(ROOT, file)}`, () => {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || 'node --check 失败');
  });
}

// ---------- 2) 代码测试 ----------
console.log('[2/3] 代码测试（node --test）');
step('node --test 全部通过', () => {
  const r = spawnSync(process.execPath, ['--test'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) {
    const tail = (r.stdout || '').split('\n').slice(-25).join('\n');
    throw new Error(`测试失败（退出码 ${r.status}）:\n${tail}`);
  }
});

// ---------- 3) 接口 / HTTP 冒烟 ----------
console.log(`[3/3] 接口 / HTTP 冒烟（${BASE}）`);

async function waitReady(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.ok) return;
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`服务在 ${timeoutMs}ms 内未就绪：${lastErr && lastErr.message}`);
}

async function postAudit(body) {
  const res = await fetch(`${BASE}/api/audit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, `审计接口 HTTP 状态应为 200，实际 ${res.status}`);
  return res.json();
}

async function postTrace(body, direction) {
  return postAudit({ ...body, traceDirection: direction });
}

(async () => {
  await astep('服务健康检查就绪 GET /healthz', async () => {
    await waitReady(BASE);
    const res = await fetch(`${BASE}/healthz`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.status, 'ok');
  });

  await astep('页面 GET / 返回 HTML', async () => {
    const res = await fetch(`${BASE}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    const html = await res.text();
    assert.ok(html.includes('弱互模拟审计'));
  });

  await astep('示例接口 GET /api/samples 包含等价、缺失与单向边界规程', async () => {
    const res = await fetch(`${BASE}/api/samples`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.ok(j.equivalent && j.missing && j.oneway);
  });

  await astep('静默环等价规程：判定等价且关系含两个初始状态对', async () => {
    const j = await postAudit(samples.equivalent);
    assert.equal(j.ok, true);
    assert.equal(j.equivalent, true, JSON.stringify(j.eliminatedPairs));
    assert.equal(j.initialPairs.length, 2);
    assert.deepEqual(j.initialPairs, [['S0', 'P0'], ['P0', 'S0']]);
    assert.ok(j.initialAlive.every(Boolean));
  });

  await astep('缺失匹配动作规程：判定不等价，首个失败动作为 x', async () => {
    const j = await postAudit(samples.missing);
    assert.equal(j.equivalent, false);
    assert.ok(j.firstEliminated, '应给出首个淘汰状态对');
    assert.equal(j.firstEliminated.action, 'x');
    assert.ok(j.firstEliminated.transitions.some((t) => t.reason === 'NO_MATCHING_ACTION'));
    assert.equal(j.initialAlive[0], false);
  });

  await astep('多轮级联规程：失败义务只引用更早轮次淘汰结果且按轮次递减', async () => {
    const j = await postAudit(samples.cascade);
    assert.equal(j.equivalent, false);
    for (const ep of j.eliminatedPairs) {
      for (const t of ep.transitions) {
        if (t.reason === 'ALL_RESPONSES_ELIMINATED') {
          for (const w of t.responses) {
            assert.ok(Number.isInteger(w.eliminatedRound) && w.eliminatedRound < ep.round);
          }
          const rounds = t.responses.map((w) => w.eliminatedRound);
          assert.deepEqual(rounds, [...rounds].sort((a, b) => b - a), '依据应按轮次递减');
        }
      }
    }
  });

  await astep('无效输入：一次返回全部问题并清除旧结论', async () => {
    const bad = {
      procA: { states: [{ name: 's' }, { name: 's' }], initial: 'ghost', transitions: [{ id: 't1', from: 's', action: '', to: 'x' }] },
      procB: { states: [], initial: '', transitions: [] },
    };
    const j = await postAudit(bad);
    assert.equal(j.ok, false);
    assert.equal(j.equivalent, null);
    assert.ok(j.errors.length >= 4, () => `应一次报告所有问题，实际 ${j.errors.length}`);
    assert.deepEqual(j.rounds, []);
    assert.deepEqual(j.eliminatedPairs, []);
    assert.equal(j.firstEliminated, null);
  });

  await astep('非 JSON 请求体返回 400', async () => {
    const res = await fetch(`${BASE}/api/audit`, { method: 'POST', body: 'not-json' });
    assert.equal(res.status, 400);
  });

  // ---------- 单向轨迹包含检查 ----------

  await astep('普通审计（无 traceDirection）不输出轨迹检查结果', async () => {
    const j = await postAudit(samples.equivalent);
    assert.equal(j.traceInclusion, null);
  });

  await astep('静默环轨迹包含：A⊑B 与 B⊑A 均成立且不改变弱互模拟结论', async () => {
    const ab = await postTrace(samples.equivalent, 'A');
    assert.equal(ab.equivalent, true); // 原结论不变
    assert.ok(ab.traceInclusion);
    assert.equal(ab.traceInclusion.included, true);
    assert.deepEqual(ab.traceInclusion.trace, []);
    const ba = await postTrace(samples.equivalent, 'B');
    assert.equal(ba.traceInclusion.included, true);
  });

  await astep('缺失动作：A⊑B 最短反例为单动作 x，展开首个空响应', async () => {
    const j = await postTrace(samples.missing, 'A');
    const t = j.traceInclusion;
    assert.equal(t.included, false);
    assert.equal(t.leftSide, 'A');
    assert.equal(t.rightSide, 'B');
    assert.deepEqual(t.trace, ['x']);
    assert.equal(t.rounds.length, 1);
    const rd = t.rounds[0];
    assert.equal(rd.action, 'x');
    assert.equal(rd.leftPosition, 'a0');
    assert.deepEqual(rd.leftTargets, ['a1']);
    assert.deepEqual(rd.rightBefore, ['b0']);
    assert.deepEqual(rd.rightResponses, []);
    assert.equal(rd.firstEmpty, true);
  });

  await astep('双向结果不同的边界：A⊑B 成立、B⊑A 反例为 y', async () => {
    const ab = await postTrace(samples.oneway, 'A');
    assert.equal(ab.traceInclusion.included, true);
    const ba = await postTrace(samples.oneway, 'B');
    assert.equal(ba.traceInclusion.included, false);
    assert.deepEqual(ba.traceInclusion.trace, ['y']);
    assert.equal(ba.traceInclusion.rounds[0].firstEmpty, true);
  });

  await astep('多轮反例：每轮给出动作、左侧位置、右侧集合与推进链', async () => {
    const j = await postTrace(samples.cascade, 'A');
    const t = j.traceInclusion;
    assert.equal(t.included, false);
    assert.deepEqual(t.trace, ['x', 'y']);
    assert.equal(t.rounds[0].rightResponses.length > 0, true);
    assert.equal(t.rounds[0].nextLeft, 'a1');
    assert.deepEqual(t.rounds[0].nextRight, ['b1']);
    assert.deepEqual(t.rounds[1].rightResponses, []);
    // 推进后的右侧集合沿前驱链复算一致
    assert.deepEqual(t.rounds[1].rightBefore, t.rounds[0].nextRight);
  });

  await astep('无效输入执行轨迹检查：结论清除且 traceInclusion 为 null', async () => {
    const bad = {
      procA: { states: [{ name: 's' }, { name: 's' }], initial: 'ghost', transitions: [] },
      procB: { states: [], initial: '', transitions: [] },
    };
    const j = await postTrace(bad, 'A');
    assert.equal(j.ok, false);
    assert.equal(j.equivalent, null);
    assert.equal(j.traceInclusion, null);
    assert.ok(j.errors.length >= 2);
  });

  await astep('非法 traceDirection 被拒绝且清除结论', async () => {
    const j = await postAudit({ ...samples.equivalent, traceDirection: 'Z' });
    assert.equal(j.ok, false);
    assert.equal(j.equivalent, null);
    assert.equal(j.traceInclusion, null);
    assert.ok(j.errors.some((e) => e.code === 'TRACE_DIRECTION_INVALID'));
  });

  console.log(failures === 0 ? '\nVERIFY RESULT: PASS' : `\nVERIFY RESULT: FAIL（${failures} 项）`);
  process.exit(failures === 0 ? 0 : 1);
})();
