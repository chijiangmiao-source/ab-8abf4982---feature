'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { audit, weakTargets, normalize, TAU, traceCheck } = require('../src/bisimulation');
const { samples } = require('../src/samples');

test('仅以 tau 环重命名而等价：关系包含两个初始状态对', () => {
  const r = audit(samples.equivalent.procA, samples.equivalent.procB);
  assert.equal(r.ok, true);
  assert.equal(r.equivalent, true);
  assert.deepEqual(r.initialPairs, [['S0', 'P0'], ['P0', 'S0']]);
  assert.ok(r.initialAlive.every(Boolean));
  assert.ok(r.finalRelation.some((p) => p[0] === 'S0' && p[1] === 'P0'));
  assert.ok(r.finalRelation.some((p) => p[0] === 'P0' && p[1] === 'S0'));
  // 行为不同的配对（如 S0 与终态 P1）被淘汰属正常；初始对存活即等价
  assert.ok(!r.eliminatedPairs.some((p) => p.pair[0] === 'S0' && p.pair[1] === 'P0'));
});

test('缺失匹配动作：不等价，首个失败义务是缺失侧无法承接的动作', () => {
  const r = audit(samples.missing.procA, samples.missing.procB);
  assert.equal(r.equivalent, false);
  const f = r.firstEliminated;
  assert.equal(f.action, 'x'); // 有 x 的 A 方挑战，B 方无法承接
  assert.equal(f.challenger, 'A');
  assert.ok(f.transitions.some((t) => t.reason === 'NO_MATCHING_ACTION'));
  // 四个跨侧对中三个无法匹配（死态对 (a1,b1) 存活）
  assert.equal(r.rounds[0].eliminated.length, 3);
  const initPair = r.eliminatedPairs.find((p) => p.pair[0] === 'a0' && p.pair[1] === 'b0');
  assert.equal(initPair.round, 1);
});

test('多轮级联：初始对第 2 轮淘汰，失败义务只引用第 1 轮淘汰对', () => {
  const r = audit(samples.cascade.procA, samples.cascade.procB);
  assert.equal(r.equivalent, false);

  const p11 = r.eliminatedPairs.find((p) => p.pair[0] === 'a1' && p.pair[1] === 'b1');
  assert.equal(p11.round, 1);
  assert.equal(p11.action, 'y');

  const p00 = r.eliminatedPairs.find((p) => p.pair[0] === 'a0' && p.pair[1] === 'b0');
  assert.equal(p00.round, 2);
  assert.equal(p00.action, 'x');
  assert.equal(p00.challenger, 'A');

  const fail = p00.transitions.find((t) => t.source === 'a1');
  assert.equal(fail.reason, 'ALL_RESPONSES_ELIMINATED');
  assert.equal(fail.responses.length, 1);
  assert.deepEqual(fail.responses[0].pair, ['a1', 'b1']);
  assert.equal(fail.responses[0].eliminatedRound, 1);

  // 每条失败义务的依据都来自严格更早的轮次（自底向上可复算）
  for (const ep of r.eliminatedPairs) {
    for (const t of ep.transitions) {
      if (t.reason === 'ALL_RESPONSES_ELIMINATED') {
        for (const w of t.responses) {
          assert.ok(typeof w.eliminatedRound === 'number');
          assert.ok(w.eliminatedRound < ep.round, `依据轮次应更早: ${JSON.stringify(w)} in round ${ep.round}`);
        }
        // 依据按轮次递减排序
        const rounds = t.responses.map((w) => w.eliminatedRound);
        assert.deepEqual(rounds, [...rounds].sort((x, y) => y - x));
      }
    }
  }
});

test('tau 链上的弱转移：静默前缀后承接动作', () => {
  const proc = normalize({
    states: [{ name: 's' }, { name: 'u' }, { name: 'p' }, { name: 'v' }],
    initial: 's',
    transitions: [
      { id: '1', from: 's', action: 'tau', to: 'u' },
      { id: '2', from: 'u', action: 'tau', to: 'p' },
      { id: '3', from: 'p', action: 'a', to: 'v' },
    ],
  });
  assert.deepEqual([...weakTargets(proc, 's', 'a')], ['v']);
  assert.deepEqual([...weakTargets(proc, 's', TAU)].sort(), ['p', 's', 'u']);
});

test('静默前缀 + 可观察承接的典型等价：tau 前缀进程与直接动作进程', () => {
  const A = {
    states: [{ name: 's' }, { name: 'u' }, { name: 'p' }],
    initial: 's',
    transitions: [
      { id: '1', from: 's', action: 'tau', to: 'u' },
      { id: '2', from: 'u', action: 'tau', to: 'u' }, // tau 自环
      { id: '3', from: 'u', action: 'a', to: 'p' },
    ],
  };
  const B = {
    states: [{ name: 'q' }, { name: 'r' }],
    initial: 'q',
    transitions: [{ id: '1', from: 'q', action: 'a', to: 'r' }],
  };
  const r = audit(A, B);
  assert.equal(r.equivalent, true);
});

test('输入无效：一次显示所有问题并清除旧结论', () => {
  const bad = {
    states: [{ name: 'x' }, { name: 'x' }, {}, { name: 'bad name' }],
    initial: 'ghost',
    transitions: [
      { id: 't', from: 'x', action: '', to: 'nope' },
      { id: 't', from: 'x', action: 'foo', to: 'x' },
      { id: 'a1', from: 'x', action: 'a', to: 'x' },
      { id: 'a2', from: 'x', action: 'b', to: 'x' },
      { id: 'a3', from: 'x', action: 'c', to: 'x' },
      { id: 'a4', from: 'x', action: 'd', to: 'x' },
      { id: 'a5', from: 'x', action: 'e', to: 'x' },
    ],
  };
  const r = audit(bad, { states: [], initial: '', transitions: [] });
  assert.equal(r.ok, false);
  assert.equal(r.equivalent, null);
  const codes = r.errors.map((e) => e.code);
  for (const code of [
    'STATE_DUPLICATE',
    'STATE_NAME_INVALID',
    'STATE_NAME_MISSING',
    'INITIAL_UNKNOWN',
    'ENDPOINT_UNKNOWN',
    'ACTION_MISSING',
    'TID_DUPLICATE',
    'INITIAL_MISSING',
    'ACTION_LIMIT',
  ]) {
    assert.ok(codes.includes(code), `应报告 ${code}；实际 ${JSON.stringify(codes)}`);
  }
  // 两侧问题都要收集
  assert.ok(r.errors.some((e) => e.side === 'A'));
  assert.ok(r.errors.some((e) => e.side === 'B'));
  // 清除旧结论：无轮次、无淘汰对、无初始对
  assert.equal(r.rounds.length, 0);
  assert.equal(r.eliminatedPairs.length, 0);
  assert.equal(r.firstEliminated, null);
  assert.equal(r.initialPairs.length, 0);
});

test('稳定排序：首个失败动作按动作字典序（tau 最后），轮次内状态对稳定排序', () => {
  const A = {
    states: [{ name: 's' }, { name: 'p' }],
    initial: 's',
    transitions: [
      { id: 'z', from: 's', action: 'z', to: 'p' },
      { id: 'b', from: 's', action: 'b', to: 'p' },
    ],
  };
  const B = {
    states: [{ name: 'q' }, { name: 'r' }],
    initial: 'q',
    transitions: [{ id: 'c', from: 'q', action: 'c', to: 'r' }],
  };
  const r = audit(A, B);
  // 首个淘汰对按状态对字典序为 (p,q)：p 为死态，q 可做 c，首个失败动作为 c（B 挑战）
  assert.deepEqual(r.firstEliminated.pair, ['p', 'q']);
  assert.equal(r.firstEliminated.action, 'c');
  assert.equal(r.firstEliminated.challenger, 'B');
  // (s,q) 的首个失败义务才是动作 b（A 挑战，字典序早于 z）
  const sq = r.eliminatedPairs.find((p) => p.pair[0] === 's' && p.pair[1] === 'q');
  assert.equal(sq.action, 'b');
  assert.equal(sq.challenger, 'A');
  for (const rd of r.rounds) {
    const pairs = rd.eliminated.map((e) => e.pair.join(','));
    assert.deepEqual(pairs, [...pairs].sort());
  }
});

test('同构进程（仅状态重命名）等价', () => {
  const mk = (prefix) => ({
    states: [{ name: `${prefix}0` }, { name: `${prefix}1` }, { name: `${prefix}2` }],
    initial: `${prefix}0`,
    transitions: [
      { id: `${prefix}a`, from: `${prefix}0`, action: 'a', to: `${prefix}1` },
      { id: `${prefix}b`, from: `${prefix}1`, action: 'b', to: `${prefix}2` },
      { id: `${prefix}t`, from: `${prefix}2`, action: 'tau', to: `${prefix}0` },
    ],
  });
  const r = audit(mk('s'), mk('q'));
  assert.equal(r.equivalent, true);
  // 静默环使各状态经 tau 弱可达彼此：行为相同的非初始配对也可在关系中，
  // 关键是两个初始状态对均存活、初始对未被淘汰
  assert.ok(!r.eliminatedPairs.some((p) => p.pair[0] === 's0' && p.pair[1] === 'q0'));
});

test('状态数与可观察动作种类上限', () => {
  const tooMany = {
    states: Array.from({ length: 19 }, (_, i) => ({ name: `s${i}` })),
    initial: 's0',
    transitions: [],
  };
  const r1 = audit(tooMany, { states: [{ name: 'q' }], initial: 'q', transitions: [] });
  assert.ok(r1.errors.some((e) => e.code === 'STATE_LIMIT'));

  const fiveActions = {
    states: [{ name: 's' }],
    initial: 's',
    transitions: ['a', 'b', 'c', 'd', 'e'].map((a) => ({ id: a, from: 's', action: a, to: 's' })),
  };
  const r2 = audit(fiveActions, { states: [{ name: 'q' }], initial: 'q', transitions: [] });
  assert.ok(r2.errors.some((e) => e.code === 'ACTION_LIMIT'));
});

test('18 状态 4 动作的上限边界可正常计算', () => {
  const mk = (prefix) => ({
    states: Array.from({ length: 18 }, (_, i) => ({ name: `${prefix}${i}` })),
    initial: `${prefix}0`,
    transitions: [
      ...['a', 'b', 'c', 'd'].map((act, i) => ({ id: `${prefix}${act}`, from: `${prefix}0`, action: act, to: `${prefix}${i + 1}` })),
      { id: `${prefix}tau`, from: `${prefix}0`, action: 'tau', to: `${prefix}0` },
    ],
  });
  const r = audit(mk('s'), mk('q'));
  assert.equal(r.ok, true);
  assert.equal(r.equivalent, true);
});

// ---------- 方向性轨迹承接检查 ----------

test('轨迹检查：不含方向参数时普通审计字段不变且无 traceChecks 以外改动', () => {
  const r = audit(samples.missing.procA, samples.missing.procB);
  assert.deepEqual(r.traceChecks, []);
  assert.equal(r.equivalent, false);
});

test('轨迹检查：含静默环的轨迹包含（双向均承接，不改变等价结论）', () => {
  const r = audit(samples.equivalent.procA, samples.equivalent.procB, { directions: ['A-to-B', 'B-to-A'] });
  assert.equal(r.equivalent, true);
  assert.equal(r.traceChecks.length, 2);
  for (const t of r.traceChecks) {
    assert.equal(t.contained, true);
    assert.equal(t.trace, null);
    assert.deepEqual(t.rounds, []);
    assert.equal(t.firstEmptyResponse, null);
  }
});

test('轨迹检查：缺失动作的最短反例长度为 1 且按 ASCII 序选最小动作', () => {
  const A = {
    states: [{ name: 's' }, { name: 'p' }],
    initial: 's',
    transitions: [
      { id: 'b', from: 's', action: 'b', to: 'p' },
      { id: 'a', from: 's', action: 'a', to: 'p' },
    ],
  };
  const B = { states: [{ name: 'q' }], initial: 'q', transitions: [] };
  const r = audit(A, B, { directions: ['A-to-B'] });
  const t = r.traceChecks[0];
  assert.equal(t.contained, false);
  assert.deepEqual(t.trace, ['a']); // 同长度 ASCII 最小
  assert.equal(t.length, 1);
  assert.equal(t.rounds.length, 1);
  assert.equal(t.rounds[0].action, 'a');
  assert.equal(t.rounds[0].leftState, 's');
  assert.deepEqual(t.rounds[0].rightSet, ['q']);
  assert.deepEqual(t.rounds[0].rightBeforeSet, ['q']);
  assert.deepEqual(t.rounds[0].responderTargets, []);
  assert.ok(t.rounds[0].emptyResponse);
  assert.deepEqual(t.firstEmptyResponse.rightSet, ['q']);
});

test('轨迹检查：长度优先于 ASCII，输出长度 2 的最短反例并逐轮展开', () => {
  // b 在初始即可被承接（长度 1 成功），但其后 B 无 z；a 立即失败不可能发生——
  // 这里让 a、b 都可走，b 后接 z 失败，而 a 自环后 B 仍可匹配 a（不失败），
  // 故最短失败为 [b,z]；额外保证 [a,...] 不产生更短失败。
  const A = {
    states: [{ name: 's0' }, { name: 's1' }],
    initial: 's0',
    transitions: [
      { id: 'a', from: 's0', action: 'a', to: 's0' },
      { id: 'b', from: 's0', action: 'b', to: 's1' },
      { id: 'z', from: 's1', action: 'z', to: 's1' },
    ],
  };
  const B = {
    states: [{ name: 'q0' }, { name: 'q1' }],
    initial: 'q0',
    transitions: [{ id: 'a', from: 'q0', action: 'a', to: 'q0' }, { id: 'b', from: 'q0', action: 'b', to: 'q1' }],
  };
  const t = audit(A, B, { directions: ['A-to-B'] }).traceChecks[0];
  assert.equal(t.contained, false);
  assert.deepEqual(t.trace, ['b', 'z']);
  assert.equal(t.rounds.length, 2);
  assert.deepEqual(t.rounds.map((x) => x.action), ['b', 'z']);
  assert.deepEqual(t.rounds.map((x) => x.leftState), ['s0', 's1']);
  assert.deepEqual(t.rounds[0].responderTargets, ['q1']);
  assert.deepEqual(t.rounds[1].rightSet, ['q1']);
  assert.deepEqual(t.rounds[1].responderTargets, []);
  assert.ok(t.rounds[1].emptyResponse);
  assert.equal(t.firstEmptyResponse.action, 'z');
});

test('轨迹检查：静默前缀必须在动作前展开（tau 环不吸收动作后尾部 tau）', () => {
  // L: s -tau-> u（u 有 tau 自环），u -a-> p；R: q -a-> r。双向包含。
  const L = {
    states: [{ name: 's' }, { name: 'u' }, { name: 'p' }],
    initial: 's',
    transitions: [
      { id: '1', from: 's', action: 'tau', to: 'u' },
      { id: '2', from: 'u', action: 'tau', to: 'u' },
      { id: '3', from: 'u', action: 'a', to: 'p' },
    ],
  };
  const R = {
    states: [{ name: 'q' }, { name: 'r' }],
    initial: 'q',
    transitions: [{ id: '1', from: 'q', action: 'a', to: 'r' }],
  };
  for (const dir of ['A-to-B', 'B-to-A']) {
    const t = audit(L, R, { directions: [dir] }).traceChecks[0];
    assert.equal(t.contained, true, dir);
  }
});

test('轨迹检查：守方不确定性下子集存在性承接（tau 分叉后仍有一个落点可续接）', () => {
  // R 初始经 tau 分叉到 q1/q2，x 后集合 {q3,q4}；仅 q3 能续 y。
  // 存在性承接下 x·y 应可承接；再加只有 L 能做的 z 才在 [x,z] 失败。
  const L = {
    states: [{ name: 's0' }, { name: 's1' }, { name: 's2' }],
    initial: 's0',
    transitions: [
      { id: 'x', from: 's0', action: 'x', to: 's1' },
      { id: 'y', from: 's1', action: 'y', to: 's2' },
      { id: 'z', from: 's1', action: 'z', to: 's2' },
    ],
  };
  const R = {
    states: [{ name: 'q0' }, { name: 'q1' }, { name: 'q2' }, { name: 'q3' }, { name: 'q4' }, { name: 'q5' }],
    initial: 'q0',
    transitions: [
      { id: 't1', from: 'q0', action: 'tau', to: 'q1' },
      { id: 't2', from: 'q0', action: 'tau', to: 'q2' },
      { id: 'x1', from: 'q1', action: 'x', to: 'q3' },
      { id: 'x2', from: 'q2', action: 'x', to: 'q4' },
      { id: 'y', from: 'q3', action: 'y', to: 'q5' },
    ],
  };
  const ok = audit(L, R, { directions: ['A-to-B'] }).traceChecks[0];
  assert.equal(ok.contained, false);
  assert.deepEqual(ok.trace, ['x', 'z']);
  assert.deepEqual(ok.rounds[1].rightSet, ['q3', 'q4']);
  // 去掉 z 后双向包含（L 的 x·y 与 R 可承接轨迹一致）
  const L2 = JSON.parse(JSON.stringify(L));
  L2.transitions = L2.transitions.filter((x) => x.action !== 'z');
  assert.equal(audit(L2, R, { directions: ['A-to-B'] }).traceChecks[0].contained, true);
});

test('轨迹检查：双向结果不同的边界（A→B 包含，B→A 反例 [y]）', () => {
  const r = audit(samples.oneway.procA, samples.oneway.procB, { directions: ['A-to-B', 'B-to-A'] });
  assert.equal(r.equivalent, false); // 弱互模拟仍不等价
  assert.equal(r.traceChecks[0].direction, 'A-to-B');
  assert.equal(r.traceChecks[0].contained, true);
  assert.equal(r.traceChecks[1].direction, 'B-to-A');
  assert.equal(r.traceChecks[1].contained, false);
  assert.deepEqual(r.traceChecks[1].trace, ['y']);
});

test('轨迹检查：反例左侧多落点时只沿失败落点展开且右侧集合为全集子集', () => {
  // s --a--> p1,p2；B: q --a--> r（单落点）。p1 死、p2 能 b；B 的 r 死。
  // 最短失败：a 后选 p2 分支 -> b 失败，反例 [a,b]；p1 分支无后续动作不构成更长失败。
  const A = {
    states: [{ name: 's' }, { name: 'p1' }, { name: 'p2' }],
    initial: 's',
    transitions: [
      { id: 'a1', from: 's', action: 'a', to: 'p1' },
      { id: 'a2', from: 's', action: 'a', to: 'p2' },
      { id: 'b', from: 'p2', action: 'b', to: 'p2' },
    ],
  };
  const B = {
    states: [{ name: 'q' }, { name: 'r' }],
    initial: 'q',
    transitions: [{ id: 'a', from: 'q', action: 'a', to: 'r' }],
  };
  const t = audit(A, B, { directions: ['A-to-B'] }).traceChecks[0];
  assert.deepEqual(t.trace, ['a', 'b']);
  assert.equal(t.rounds[1].leftState, 'p2');
  assert.deepEqual(t.rounds[1].rightSet, ['r']);
});

test('轨迹检查：无效输入不执行方向性检查并清除结论', () => {
  const bad = { states: [{ name: 's' }, { name: 's' }], initial: 's', transitions: [] };
  const good = { states: [{ name: 'q' }], initial: 'q', transitions: [] };
  const r = audit(bad, good, { directions: ['A-to-B'] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.traceChecks, []);
});

test('轨迹检查：18 状态稠密规程可终止且前沿远小于子集总数', () => {
  function rnd(seed) {
    return () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
  }
  const mk = (prefix, seed) => {
    const r = rnd(seed);
    const states = Array.from({ length: 18 }, (_, i) => ({ name: `${prefix}${i}` }));
    const transitions = [];
    let k = 0;
    for (let i = 0; i < 18; i++) {
      if (r() < 0.4) transitions.push({ id: `${prefix}t${k++}`, from: `${prefix}${i}`, action: 'tau', to: `${prefix}${Math.floor(r() * 18)}` });
      for (const a of ['a', 'b', 'c', 'd']) {
        for (let d = 0; d < 3; d++) {
          if (r() < 0.6) transitions.push({ id: `${prefix}${a}${k++}`, from: `${prefix}${i}`, action: a, to: `${prefix}${Math.floor(r() * 18)}` });
        }
      }
    }
    return { states, initial: `${prefix}0`, transitions };
  };
  const t = traceCheck(mk('s', 14), mk('q', 102), normalize(mk('s', 14)), normalize(mk('q', 102)), 'A-to-B');
  assert.ok(typeof t.contained === 'boolean');
  assert.ok(t.frontierPeak < 1 << 17);
});
