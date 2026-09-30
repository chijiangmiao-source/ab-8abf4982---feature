'use strict';

// 单向可观察轨迹包含检查：左侧（守方挑战侧）的每一条可观察动作轨迹，
// 右侧是否都能以“静默前缀后承接同动作”逐步承接。不改变弱互模拟审计本身。
//
// 与既有弱转移约定一致：
//   - 轨迹中只出现可观察动作，tau 仅作为动作前的静默前缀按 epsilonClosure 展开；
//   - 承接一个可观察动作后落在强迁移目标，下一步动作前再展开静默前缀
//     （不吸收动作后的尾部 tau，尾部 tau 在下一轮的静默前缀中展开）。
//
// 前沿组织：BFS 节点为 (左侧当前位置 l, 右侧动作前可能停留集合 T)，
// T 在入队时即展开静默前缀。按左侧位置 l 维护“不可互相替代”的集合前沿：
//   - 若更早深度已有 T0 ⊆ T，则 T 必然只能导致更弱（不更早失败）的结论，直接剪枝
//     （更小集合能导致更强失败结论：T0 承接不了的后继，T 也承接不了，且轨迹更短）；
//   - 同深度仅保留首次到达者（生成顺序即轨迹 ASCII 字典序），
//     新集合若是旧集合的严格超集才可能并存；严格子集即使“失败更强”，
//     若来自字典序更晚的轨迹也不淘汰早先节点，否则会丢失同长度下 ASCII 序更小的反例；
//   - 相同 (l, T) 只保留最早（最短、同长度字典序最小）的稳定前驱链。
// 状态数上限 18，集合前沿按位置分桶并做包含剪枝，避免子集空间失控。

const { TAU, normalize } = require('./bisimulation');

function visibleActionList(L, R) {
  const all = new Set();
  for (const a of L.actions) if (a !== TAU) all.add(a);
  for (const a of R.actions) if (a !== TAU) all.add(a);
  return [...all].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)); // ASCII 序
}

function isSubset(smallArr, bigArr) {
  if (smallArr.length > bigArr.length) return false;
  const big = new Set(bigArr);
  for (const s of smallArr) if (!big.has(s)) return false;
  return true;
}

function checkTraceInclusion(specL, specR) {
  const L = normalize(specL);
  const R = normalize(specR);
  const actions = visibleActionList(L, R);

  // 闭包与直连迁移按 (规程, 状态) 记忆，复算结果稳定。
  const closureCache = new Map();
  const closureOf = (proc, cache, s) => {
    let byProc = cache.get(proc);
    if (!byProc) {
      byProc = new Map();
      cache.set(proc, byProc);
    }
    let c = byProc.get(s);
    if (c) return c;
    const seen = new Set([s]);
    const stack = [s];
    while (stack.length) {
      const u = stack.pop();
      const tauTargets = proc.out.get(u) && proc.out.get(u).get(TAU);
      if (tauTargets) {
        for (const v of tauTargets) {
          if (!seen.has(v)) {
            seen.add(v);
            stack.push(v);
          }
        }
      }
    }
    c = seen;
    byProc.set(s, c);
    return c;
  };

  const closureL = (s) => closureOf(L, closureCache, s);
  const closureR = (s) => closureOf(R, closureCache, s);

  const directTargets = (proc, s, action) => {
    const m = proc.out.get(s);
    return (m && m.get(action)) || null;
  };

  // 某状态经静默前缀后承接 action 的全部强落点（左侧迁移用）。
  const weakLandings = (proc, closure, s, action) => {
    const out = new Set();
    for (const u of closure(s)) {
      const ts = directTargets(proc, u, action);
      if (ts) for (const p of ts) out.add(p);
    }
    return out;
  };

  // 右侧集合（动作前已展开静默前缀）承接 action 后的强响应落点。
  const respond = (rightSet, action) => {
    const out = new Set();
    for (const t of rightSet) {
      const ts = directTargets(R, t, action);
      if (ts) for (const p of ts) out.add(p);
    }
    return out;
  };

  // 动作落点集合在下一动作前展开静默前缀，输出稳定排序数组。
  const expandRight = (states) => {
    const out = new Set();
    for (const s of states) for (const u of closureR(s)) out.add(u);
    return [...out].sort();
  };

  const rootRight = expandRight([R.initial]);
  const root = {
    left: L.initial,
    right: rootRight, // 动作前可能停留集合（已展开静默前缀）
    parent: null,
    action: null, // 从上一节点到本节点承接的可观察动作
    depth: 0,
  };

  // 按左侧位置维护已接纳前沿：{ set:排序状态数组, depth:首次接纳深度 } 数组。
  const frontier = new Map();
  const admit = (left, setArr, depth) => {
    let list = frontier.get(left);
    if (!list) {
      list = [];
      frontier.set(left, list);
    }
    for (const e of list) {
      // 同位置且旧集合包含新集合：旧节点轨迹更短，或同深度但字典序更早
      // （同深度节点严格按生成顺序入队），新节点不可能给出更强结论。
      if (e.depth <= depth && isSubset(e.set, setArr)) return false;
    }
    list.push({ set: setArr, depth });
    return true;
  };
  admit(root.left, root.right, 0);

  let level = [root];
  let explored = 1;

  while (level.length) {
    const next = [];
    // level 内节点顺序即“父轨迹 ASCII 序 × 动作 ASCII 序 × 落点排序”，
    // 故扫描到的首个空响应就是最短且同长度 ASCII 序最小的反例。
    for (const node of level) {
      for (const action of actions) {
        const leftTargets = weakLandings(L, closureL, node.left, action);
        if (leftTargets.size === 0) continue; // 左侧在此动作前无此可观察承诺

        const responses = respond(node.right, action);
        if (responses.size === 0) {
          return buildFailure(node, action);
        }

        const nextRight = expandRight(responses);
        for (const lp of [...leftTargets].sort()) {
          if (admit(lp, nextRight, node.depth + 1)) {
            next.push({ left: lp, right: nextRight, parent: node, action, depth: node.depth + 1 });
            explored += 1;
          }
        }
      }
    }
    level = next;
  }

  return {
    included: true,
    trace: [],
    rounds: [],
    exploredEntries: explored,
    frontierEntries: [...frontier.values()].reduce((n, l) => n + l.length, 0),
  };

  // ---------- 稳定前驱链：逐轮复算左侧迁移与右侧可响应集合 ----------

  function buildFailure(failNode, failAction) {
    // 稳定前驱链：root -> ... -> failNode；actions[i] 为从 chain[i] 发起的动作。
    const chainRev = [];
    for (let n = failNode; n; n = n.parent) chainRev.push(n);
    const chain = chainRev.reverse();
    const actions = chain.slice(1).map((n) => n.action);
    actions.push(failAction);

    const trace = [];
    const rounds = actions.map((action, i) => {
      const node = chain[i];
      const leftClosure = [...closureL(node.left)].sort();
      const leftTargets = [...weakLandings(L, closureL, node.left, action)].sort();
      const rightResponses = [...respond(node.right, action)].sort();
      const firstEmpty = rightResponses.length === 0;
      const nextNode = chain[i + 1] || null;
      // 下一轮右侧集合由本轮响应落点重新展开静默前缀复算，
      // 应与前驱链上存储的集合逐元素一致（自底向上可复算）。
      const nextRight = firstEmpty ? [] : expandRight(rightResponses);
      if (nextNode && nextNode.right.length !== nextRight.length) {
        throw new Error('trace-inclusion invariant violated');
      }
      if (nextNode && !isSubset(nextNode.right, nextRight)) {
        throw new Error('trace-inclusion invariant violated');
      }
      trace.push(action);
      return {
        step: i + 1,
        action,
        leftPosition: node.left,
        leftClosure,
        rightBefore: [...node.right].sort(),
        leftTargets,
        rightResponses,
        nextLeft: nextNode ? nextNode.left : null,
        nextRight: firstEmpty ? [] : nextNode ? nextNode.right : nextRight,
        firstEmpty,
      };
    });

    // 校验：失败轮左侧确实可发起该动作，而右侧集合无任何响应。
    const last = rounds[rounds.length - 1];
    if (!(last.firstEmpty && last.leftTargets.length > 0)) {
      throw new Error('trace-inclusion invariant violated');
    }

    return {
      included: false,
      trace,
      rounds,
      exploredEntries: explored,
      frontierEntries: [...frontier.values()].reduce((n, l) => n + l.length, 0),
    };
  }
}

// 方向：'A' 表示检查 A 的全部可观察轨迹能否由 B 承接（A ⊑ B）。
function runTraceDirection(specA, specB, direction) {
  if (direction === 'A') {
    return { direction, leftSide: 'A', rightSide: 'B', ...checkTraceInclusion(specA, specB) };
  }
  if (direction === 'B') {
    return { direction, leftSide: 'B', rightSide: 'A', ...checkTraceInclusion(specB, specA) };
  }
  throw new Error('TRACE_DIRECTION_INVALID');
}

module.exports = { checkTraceInclusion, runTraceDirection };
