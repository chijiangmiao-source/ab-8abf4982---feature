'use strict';

// 弱互模拟（weak bisimulation）核心：校验、解析、按轮次淘汰，
// 并为每项失败义务仅引用更早轮次已淘汰的状态对，支持自底向上复算。
//
// 弱转移约定（静默前缀后承接同动作，不吸收动作后的尾部 tau）：
//   s ==tau=>  p 当且仅当 s ==epsilon=> p
//   s ==a===>  p 当且仅当存在 u：s ==epsilon=> u 且 u --a--> p   （a 可观察）

const TAU = 'tau';
const MAX_STATES = 18;
const MAX_VISIBLE_ACTIONS = 4;
const TOKEN_RE = /^[!-~]+$/; // 非空白可见 ASCII
const DIRECTIONS = ['A-to-B', 'B-to-A']; // 可选的方向性轨迹承接检查

// ---------- 校验：一次收集全部问题 ----------

function validateSpec(spec, side) {
  const errors = [];
  const push = (code, field, message) => errors.push({ code, field, side, message });

  const states = Array.isArray(spec && spec.states) ? spec.states : [];
  const transitions = Array.isArray(spec && spec.transitions) ? spec.transitions : [];
  const initial = spec && typeof spec.initial === 'string' ? spec.initial : '';

  const seenNames = new Set();
  for (const raw of states) {
    const name = typeof raw === 'string' ? raw : raw && raw.name;
    if (typeof name !== 'string' || name.length === 0) {
      push('STATE_NAME_MISSING', 'states', '存在缺少名称的状态');
      continue;
    }
    if (!TOKEN_RE.test(name)) push('STATE_NAME_INVALID', 'states', `状态名必须为非空白可见 ASCII：${JSON.stringify(name)}`);
    if (seenNames.has(name)) push('STATE_DUPLICATE', 'states', `状态名重复：${name}`);
    seenNames.add(name);
  }
  if (states.length > MAX_STATES) {
    push('STATE_LIMIT', 'states', `状态数 ${states.length} 超出上限 ${MAX_STATES}`);
  }

  const visibleActions = new Set();
  const seenTids = new Set();
  for (const t of transitions) {
    if (!t || typeof t !== 'object') {
      push('TRANSITION_INVALID', 'transitions', '存在不是对象的迁移');
      continue;
    }
    const { id, from, action, to } = t;
    if (typeof id !== 'string' || id.length === 0) {
      push('TID_MISSING', 'transitions', '存在缺少唯一标识的迁移');
    } else if (!TOKEN_RE.test(id)) {
      push('TID_INVALID', 'transitions', `迁移标识必须为非空白可见 ASCII：${JSON.stringify(id)}`);
    } else if (seenTids.has(id)) {
      push('TID_DUPLICATE', 'transitions', `迁移标识重复：${id}`);
    } else {
      seenTids.add(id);
    }
    for (const key of ['from', 'to']) {
      const v = t[key];
      if (typeof v !== 'string' || v.length === 0) {
        push('ENDPOINT_MISSING', 'transitions', `迁移 ${id || '?'} 缺少 ${key} 端点`);
      } else if (!seenNames.has(v)) {
        push('ENDPOINT_UNKNOWN', 'transitions', `迁移 ${id || '?'} 的 ${key} 端点未声明：${v}`);
      }
    }
    if (typeof action !== 'string' || action.length === 0) {
      push('ACTION_MISSING', 'transitions', `迁移 ${id || '?'} 缺少动作`);
    } else if (action === TAU) {
      // 静默内部动作
    } else if (!TOKEN_RE.test(action)) {
      push('ACTION_INVALID', 'transitions', `迁移 ${id || '?'} 的动作必须为 tau 或非空白可见 ASCII：${JSON.stringify(action)}`);
    } else {
      visibleActions.add(action);
    }
  }
  if (visibleActions.size > MAX_VISIBLE_ACTIONS) {
    push('ACTION_LIMIT', 'actions', `可观察动作种类 ${visibleActions.size} 超出上限 ${MAX_VISIBLE_ACTIONS}`);
  }

  if (!initial) {
    push('INITIAL_MISSING', 'initial', '未设置初始状态');
  } else if (!seenNames.has(initial)) {
    push('INITIAL_UNKNOWN', 'initial', `初始状态未声明：${initial}`);
  }

  return errors;
}

// ---------- 规范化 ----------

function normalize(spec) {
  const names = spec.states.map((s) => (typeof s === 'string' ? s : s.name)).sort();
  const stateSet = new Set(names);
  const actions = new Set();
  const out = new Map(names.map((n) => [n, new Map()]));
  for (const t of spec.transitions) {
    if (!stateSet.has(t.from) || !stateSet.has(t.to) || typeof t.action !== 'string' || !t.action) continue;
    actions.add(t.action);
    if (!out.get(t.from).has(t.action)) out.get(t.from).set(t.action, new Set());
    out.get(t.from).get(t.action).add(t.to);
  }
  return { names, stateSet, actions, out, initial: spec.initial };
}

// ---------- 弱转移 ----------

function epsilonClosure(proc, src) {
  const seen = new Set([src]);
  const stack = [src];
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
  return seen;
}

function weakTargets(proc, src, action) {
  const result = new Set();
  if (action === TAU) {
    for (const p of epsilonClosure(proc, src)) result.add(p);
    return result;
  }
  for (const u of epsilonClosure(proc, src)) {
    const ts = proc.out.get(u).get(action);
    if (ts) for (const p of ts) result.add(p);
  }
  return result;
}

// ---------- 方向性轨迹承接检查 ----------
//
// 工程师完成普通复核后可选一个方向：检查攻方（左侧）所有可观察动作轨迹
// 是否均能由守方（右侧）承接，而不改变原有弱互模拟结论（普通审计照常输出）。
//
// 引擎沿左侧的一条存在性路径推进（左侧当前位置为单个状态；同一动作有多个落点
// 时分别分支），同时把“右侧在已读动作前仍可能停留的状态集合”做全集子集构造：
//   - 静默前缀仍按既有语义展开：动作前可经任意条 tau；动作后不吸收尾部 tau；
//   - 一旦守方集合对下一动作无任何静默前缀后的同动作响应（空响应），
//     而左侧存在该弱迁移，即得到反例轨迹。
//
// 反例按长度最短、同长度按动作 ASCII 序最小选取（分层 BFS，动作按 ASCII 序展开）。
//
// 为避免十八状态规程的子集搜索失控：守方集合以 18 位位集表示，并按动作预计算
// 各子集的静默前缀并集、可承接状态与响应落点子集表（子集 DP，每步 O(1)）；
// 再按左侧位置维护不可互相替代的守方状态集合（前沿）：集合间有严格包含关系时，
// 更小的集合能导致更强失败结论（可响应集合对起始集合单调），仅在其前驱动作序列
// 不更大时剪枝以保 ASCII 最小性。每一步以稳定前驱链复算左侧迁移与右侧可响应集合。

// 动作序列字典序（动作均为可见 ASCII token，按 ASCII 码序比较）
function cmpWord(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

// 位集按状态索引（names 已排序）展开为名称数组，天然有序
function namesOf(mask, names) {
  const out = [];
  let m = mask;
  while (m) {
    const b = m & -m;
    out.push(names[31 - Math.clz32(b)]);
    m ^= b;
  }
  return out;
}

// 守方位集表：闭包并集、每动作的可承接状态并集、响应落点并集。
// 全量分配 2^n 位集数组（零填充分配廉价），但按探索到的子集惰性填充（子集 DP）。
function buildResponderTables(R, actions) {
  const n = R.names.length;
  const idx = new Map(R.names.map((name, i) => [name, i]));
  const closure = new Uint32Array(n);
  for (let i = 0; i < n; i++) for (const s of epsilonClosure(R, R.names[i])) closure[i] |= 1 << idx.get(s);

  const size = 1 << n;
  const closureUnion = new Uint32Array(size);
  const enUnion = new Map();
  const tgtUnion = new Map();
  for (const a of actions) {
    enUnion.set(a, new Uint32Array(size));
    tgtUnion.set(a, new Uint32Array(size));
  }
  const singleEn = new Map();
  const singleTgt = new Map();
  for (const a of actions) {
    singleEn.set(a, new Uint32Array(n));
    singleTgt.set(a, new Uint32Array(n));
  }
  for (let i = 0; i < n; i++) {
    for (const a of actions) {
      let en = 0;
      let tgt = 0;
      let cm = closure[i];
      while (cm) {
        const b = cm & -cm;
        const u = 31 - Math.clz32(b);
        const ts = R.out.get(R.names[u]).get(a);
        if (ts) {
          en |= b;
          for (const p of ts) tgt |= 1 << idx.get(p);
        }
        cm ^= b;
      }
      singleEn.get(a)[i] = en;
      singleTgt.get(a)[i] = tgt;
    }
  }
  // 惰性 DP：闭包并集对非空子集必非 0，可作为“已计算”标记
  const ensure = (m) => {
    if (m && !closureUnion[m]) {
      const b = m & -m;
      const i = 31 - Math.clz32(b);
      const rest = m ^ b;
      ensure(rest);
      closureUnion[m] = closure[i] | closureUnion[rest];
      for (const a of actions) {
        enUnion.get(a)[m] = singleEn.get(a)[i] | enUnion.get(a)[rest];
        tgtUnion.get(a)[m] = singleTgt.get(a)[i] | tgtUnion.get(a)[rest];
      }
    }
  };
  return { n, idx, closureUnion, enUnion, tgtUnion, ensure };
}

// 左侧位集表：每个状态对每动作的可发起源状态与落点（已含静默前缀）
function buildLeftTables(L, actions) {
  const n = L.names.length;
  const idx = new Map(L.names.map((name, i) => [name, i]));
  const src = new Map();
  const tgt = new Map();
  for (const a of actions) {
    src.set(a, new Uint32Array(n));
    tgt.set(a, new Uint32Array(n));
  }
  for (let i = 0; i < n; i++) {
    const closure = [...epsilonClosure(L, L.names[i])].map((s) => idx.get(s));
    for (const a of actions) {
      let sm = 0;
      let tm = 0;
      for (const u of closure) {
        const ts = L.out.get(L.names[u]).get(a);
        if (ts) {
          sm |= 1 << u;
          for (const p of ts) tm |= 1 << idx.get(p);
        }
      }
      src.get(a)[i] = sm;
      tgt.get(a)[i] = tm;
    }
  }
  return { n, idx, src, tgt };
}

function traceCheck(specL, specR, L, R, direction) {
  const actions = [...L.actions].filter((a) => a !== TAU).sort(); // 仅左侧可观察动作，ASCII 序
  const tabs = buildResponderTables(R, actions);
  const ltabs = buildLeftTables(L, actions);
  const lInit = ltabs.idx.get(specL.initial);
  const rInit = tabs.idx.get(specR.initial);
  const configKey = (left, setMask) => setMask * tabs.n + left; // 同一 (左侧位置, 守方集合) 配置

  let frontier = []; // 当前层节点：{ left, set, prev, action, step, word }
  const seen = new Map(); // configKey -> 到达该配置的最短动作序列
  let frontierPeak = 0;

  const root = { left: lInit, set: 1 << rInit, prev: null, action: null, step: 0, word: [] };
  seen.set(configKey(root.left, root.set), root.word);
  frontier.push(root);

  while (frontier.length) {
    frontierPeak = Math.max(frontierPeak, frontier.length);
    // 词优先的分层 BFS：同一动作序列可对应左侧不同分支配置，故按动作序列分组，
    // 序列按 ASCII 序处理；对每个序列再按动作 ASCII 序，只要该序列下任一配置
    // 出现“左侧能走而右侧空响应”，该序列即为反例（首个即最短/ASCII 最小）。
    frontier.sort((x, y) => cmpWord(x.word, y.word) || x.left - y.left);
    const groups = []; // [{ word, nodes }]
    for (const n of frontier) {
      const g = groups.length && cmpWord(groups[groups.length - 1].word, n.word) === 0
        ? groups[groups.length - 1]
        : (groups.push({ word: n.word, nodes: [] }), groups[groups.length - 1]);
      g.nodes.push(n);
    }

    const next = [];
    const layerIndex = new Map(); // 本层 configKey -> 在 next 中的位置，同配置只留最小序列

    for (const g of groups) {
      for (const action of actions) {
        // 先求该序列下每个配置的左侧落点与右侧可响应集合
        const steps = [];
        for (const node of g.nodes) {
          const leftTgtMask = ltabs.tgt.get(action)[node.left];
          if (!leftTgtMask) continue; // 该分支在此动作不可走，不构成挑战
          tabs.ensure(node.set);
          steps.push({ node, leftTgtMask, targetsMask: tabs.tgtUnion.get(action)[node.set] });
        }
        if (!steps.length) continue;

        // 该动作序列下若任一配置空响应，则 [word·action] 即反例；
        // 多个分支空响应时取左侧位置最小者，保证首个空响应稳定可复现
        const fail = steps.filter((x) => !x.targetsMask).sort((x, y) => x.node.left - y.node.left)[0];
        if (fail) {
          const node = fail.node;
          const leaf = { left: node.left, set: node.set, prev: node, action, step: node.step + 1, word: [...node.word, action] };
          return buildTraceResult(direction, leaf, L, R, ltabs, tabs, frontierPeak);
        }

        // 全部配置都已承接：左侧每个落点分别分支（存在性路径），右侧承接为全集子集
        const word = [...g.word, action];
        for (const { node, leftTgtMask, targetsMask } of steps) {
          let tm = leftTgtMask;
          while (tm) {
            const b = tm & -tm;
            const t = 31 - Math.clz32(b);
            const key = configKey(t, targetsMask);
            const li = layerIndex.get(key);
            if (li !== undefined) {
              if (cmpWord(word, next[li].word) < 0) {
                seen.set(key, word);
                next[li] = { left: t, set: targetsMask, prev: node, action, step: node.step + 1, word };
              }
            } else if (!seen.has(key)) {
              seen.set(key, word);
              layerIndex.set(key, next.length);
              next.push({ left: t, set: targetsMask, prev: node, action, step: node.step + 1, word });
            }
            tm ^= b;
          }
        }
      }
    }

    frontier = pruneFrontier(next);
  }

  return {
    direction,
    leftSide: direction === 'A-to-B' ? 'A' : 'B',
    rightSide: direction === 'A-to-B' ? 'B' : 'A',
    contained: true,
    trace: null,
    length: 0,
    rounds: [],
    firstEmptyResponse: null,
    frontierPeak,
  };
}

// 按左侧位置维护前沿：同一左侧位置下，守方集合有严格包含关系时，更小的集合
// 可响应能力更弱、能导致更强失败结论（可响应对起始集合单调），删除被其包含的
// 更大集合；仅当更强集合的前驱动作序列不更大时才剪枝，保证反例仍为 ASCII 最小。
function pruneFrontier(nodes) {
  const byLeft = new Map();
  for (const n of nodes) {
    if (!byLeft.has(n.left)) byLeft.set(n.left, []);
    byLeft.get(n.left).push(n);
  }
  const kept = [];
  for (const group of byLeft.values()) {
    // 集合大小升序：更可能成为“更强失败”的小集合先作为支配者
    const ordered = [...group].sort((x, y) => popcount(x.set) - popcount(y.set));
    for (let i = 0; i < ordered.length; i++) {
      const n = ordered[i];
      let dominated = false;
      for (let j = 0; j < i; j++) { // 仅严格更小（j 在前）的集合可能支配 n
        const m = ordered[j];
        if (cmpWord(m.word, n.word) <= 0 && (m.set | n.set) === n.set) {
          dominated = true; // m 的集合严格更小（更强失败）且前驱序列不更大
          break;
        }
      }
      if (!dominated) kept.push(n);
    }
  }
  return kept;
}

function popcount(m) {
  m = m - ((m >>> 1) & 0x55555555);
  m = (m & 0x33333333) + ((m >>> 2) & 0x33333333);
  return (((m + (m >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function buildRound(action, index, preLeft, preSet, postSetMask, L, R, ltabs, tabs, isFail) {
  tabs.ensure(preSet);
  const leftSrcMask = ltabs.src.get(action)[preLeft];
  const leftTgtMask = ltabs.tgt.get(action)[preLeft];
  const beforeMask = tabs.closureUnion[preSet];
  const enabledMask = tabs.enUnion.get(action)[preSet];
  const round = {
    index,
    action,
    leftState: L.names[preLeft],
    rightSet: namesOf(preSet, R.names),
    rightBeforeSet: namesOf(beforeMask, R.names),
    leftSources: namesOf(leftSrcMask, L.names),
    leftTargets: namesOf(leftTgtMask, L.names),
    responderEnabled: namesOf(enabledMask, R.names),
    responderTargets: namesOf(postSetMask, R.names),
    emptyResponse: null,
  };
  if (isFail) {
    round.emptyResponse = {
      leftState: L.names[preLeft],
      action,
      rightSet: namesOf(preSet, R.names),
      rightBeforeSet: namesOf(beforeMask, R.names),
      responderEnabled: [],
      responderTargets: [],
    };
  }
  return round;
}

// 沿稳定前驱链由位集表复算每一轮的动作、左侧位置、右侧集合与首个空响应
function buildTraceResult(direction, leaf, L, R, ltabs, tabs, frontierPeak) {
  const succ = []; // 成功承接的步节点（leaf.prev 向上至第 1 步）
  for (let n = leaf.prev; n && n.prev; n = n.prev) succ.push(n);
  succ.reverse();

  const rounds = [];
  const trace = [];
  succ.forEach((n, i) => {
    rounds.push(buildRound(n.action, i + 1, n.prev.left, n.prev.set, n.set, L, R, ltabs, tabs, false));
    trace.push(n.action);
  });
  // 末轮：守方集合首个空响应
  rounds.push(buildRound(leaf.action, leaf.step, leaf.left, leaf.set, 0, L, R, ltabs, tabs, true));
  trace.push(leaf.action);

  return {
    direction,
    leftSide: direction === 'A-to-B' ? 'A' : 'B',
    rightSide: direction === 'A-to-B' ? 'B' : 'A',
    contained: false,
    trace,
    length: trace.length,
    rounds,
    firstEmptyResponse: rounds[rounds.length - 1].emptyResponse,
    frontierPeak,
  };
}

// ---------- 按轮次淘汰 ----------
//
// R_0 为全部跨侧状态对；第 k 轮用上一轮存活集 R_{k-1} 检查每个存活对的
// 全部义务（对双方每个有弱转移的动作，挑战方每条弱转移都须由被挑战方
// 以静默前缀后承接同动作，且落点对仍存活）。无法履行义务的对在本轮淘汰。
// 因检查时 alive 尚未写入本轮淘汰，失败义务引用的落点对必然来自更早轮次。

function pairKey(a, b) {
  return `${a} ${b}`;
}
function splitKey(k) {
  const i = k.indexOf(' ');
  return [k.slice(0, i), k.slice(i + 1)];
}
function cmpPair(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return 0;
}
function asAB(challenger, pk) {
  const [p, q] = splitKey(pk);
  // 统一以 [A 侧状态, B 侧状态] 展示
  return challenger === 'A' ? [p, q] : [q, p];
}

function sortedActions(A, B) {
  const actions = new Set([...A.actions, ...B.actions]);
  return [...actions].sort((x, y) => {
    if (x === TAU) return 1;
    if (y === TAU) return -1;
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

function audit(specA, specB, opts = {}) {
  const wantDirs = Array.isArray(opts.directions)
    ? [...new Set(opts.directions)].filter((d) => DIRECTIONS.includes(d))
    : [];
  const errors = [...validateSpec(specA, 'A'), ...validateSpec(specB, 'B')];
  if (errors.length) {
    // 输入无效：一次显示所有问题并清除旧结论（无等价判定、无轮次、无方向性反例）
    return { ok: false, equivalent: null, errors, rounds: [], eliminatedPairs: [], firstEliminated: null, initialPairs: [], traceChecks: [] };
  }

  const A = normalize(specA);
  const B = normalize(specB);
  const actionList = sortedActions(A, B);

  const allPairs = [];
  for (const x of A.names) for (const y of B.names) allPairs.push(pairKey(x, y));

  // 预计算每个状态对的全部义务（与轮次无关）：
  // 动作顺序固定；同一动作 A 方挑战排在 B 方挑战之前。
  const duties = new Map();
  for (const x of A.names) {
    for (const y of B.names) {
      const list = [];
      for (const action of actionList) {
        const aSrc = weakTargets(A, x, action);
        const bSrc = weakTargets(B, y, action);
        if (aSrc.size) list.push({ action, challenger: 'A', responder: 'B', sources: [...aSrc].sort() });
        if (bSrc.size) list.push({ action, challenger: 'B', responder: 'A', sources: [...bSrc].sort() });
      }
      duties.set(pairKey(x, y), list);
    }
  }

  const alive = new Set(allPairs); // R_0
  const eliminateRound = new Map(); // pairKey -> 淘汰轮次
  const elimination = new Map(); // pairKey -> 详情
  const rounds = [];
  let roundNo = 0;

  while (true) {
    roundNo += 1;
    const removed = [];

    for (const key of allPairs) {
      if (!alive.has(key)) continue;
      let firstFailure = null;

      for (const d of duties.get(key)) {
        const responderProc = d.responder === 'A' ? A : B;
        const responderState = d.challenger === 'A' ? splitKey(key)[1] : splitKey(key)[0];
        const responderTargets = weakTargets(responderProc, responderState, d.action);
        const failedTransitions = [];

        if (responderTargets.size === 0) {
          // 该侧完全无法承接此动作
          for (const src of d.sources) {
            failedTransitions.push({ source: src, reason: 'NO_MATCHING_ACTION', responses: [] });
          }
        } else {
          const targetsSorted = [...responderTargets].sort();
          for (const src of d.sources) {
            const responses = [];
            let matched = false;
            for (const tgt of targetsSorted) {
              const pk = d.challenger === 'A' ? pairKey(src, tgt) : pairKey(tgt, src);
              if (alive.has(pk)) {
                matched = true; // 存在仍存活的候选响应即履行义务
              } else {
                responses.push({ target: tgt, pair: asAB(d.challenger, pk), eliminatedRound: eliminateRound.get(pk) });
              }
            }
            if (!matched) {
              // 依据按轮次递减、再按状态对稳定排序；只引用更早轮次的淘汰结果
              responses.sort((u, v) => v.eliminatedRound - u.eliminatedRound || cmpPair(u.pair, v.pair));
              failedTransitions.push({ source: src, reason: 'ALL_RESPONSES_ELIMINATED', responses });
            }
          }
        }

        if (failedTransitions.length && firstFailure === null) {
          firstFailure = {
            action: d.action,
            challenger: d.challenger,
            responder: d.responder,
            // 挑战转移按源状态稳定排序
            transitions: failedTransitions.sort((u, v) => (u.source < v.source ? -1 : u.source > v.source ? 1 : 0)),
          };
        }
      }

      if (firstFailure) {
        const pair = splitKey(key);
        removed.push({ key, detail: { pair, round: roundNo, ...firstFailure } });
      }
    }

    removed.sort((r1, r2) => cmpPair(r1.detail.pair, r2.detail.pair));
    rounds.push({
      round: roundNo,
      eliminated: removed.map((r) => ({ pair: r.detail.pair, action: r.detail.action, challenger: r.detail.challenger })),
    });

    if (removed.length === 0) break; // 到达不动点
    for (const r of removed) {
      alive.delete(r.key);
      eliminateRound.set(r.key, roundNo);
      elimination.set(r.key, r.detail);
    }
  }

  // 关系按对称二元关系呈现：同时包含 (A态,B态) 与 (B态,A态) 两个方向，
  // 因而初始状态在关系中产生两个初始状态对。
  const keyAB = pairKey(specA.initial, specB.initial);
  const initSurvives = alive.has(keyAB);
  const equivalent = initSurvives;

  const eliminatedPairs = [...elimination.values()].sort((x, y) => x.round - y.round || cmpPair(x.pair, y.pair));
  const canonicalRelation = [...alive].map(splitKey).sort(cmpPair);
  const finalRelation = [
    ...canonicalRelation.map(([a, b]) => [a, b]),
    ...canonicalRelation.map(([a, b]) => [b, a]),
  ].sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0));

  // 可选的方向性轨迹承接检查：不改变弱互模拟结论，普通审计字段照常输出
  const traceChecks = wantDirs.map((dir) =>
    (dir === 'A-to-B')
      ? traceCheck(specA, specB, A, B, dir)
      : traceCheck(specB, specA, B, A, dir),
  );

  return {
    ok: true,
    equivalent,
    errors: [],
    rounds,
    finalRelation,
    eliminatedPairs,
    firstEliminated: eliminatedPairs.length ? eliminatedPairs[0] : null,
    initialPairs: [
      [specA.initial, specB.initial],
      [specB.initial, specA.initial],
    ],
    initialAlive: [initSurvives, initSurvives],
    traceChecks,
  };
}

module.exports = {
  TAU,
  MAX_STATES,
  MAX_VISIBLE_ACTIONS,
  DIRECTIONS,
  validateSpec,
  normalize,
  epsilonClosure,
  weakTargets,
  traceCheck,
  audit,
};
