'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runTraceDirection, checkTraceInclusion } = require('../src/trace-inclusion');
const { samples } = require('../src/samples');

test('静默环 + 重命名：双向轨迹包含均成立', () => {
  const ab = runTraceDirection(samples.equivalent.procA, samples.equivalent.procB, 'A');
  assert.equal(ab.included, true);
  assert.deepEqual(ab.trace, []);
  const ba = runTraceDirection(samples.equivalent.procA, samples.equivalent.procB, 'B');
  assert.equal(ba.included, true);
});

test('右侧经静默前缀即可承接动作，包含成立', () => {
  const L = {
    states: [{ name: 'l0' }, { name: 'l1' }],
    initial: 'l0',
    transitions: [{ id: 'x', from: 'l0', action: 'x', to: 'l1' }],
  };
  const R = {
    states: [{ name: 'r0' }, { name: 'r1' }, { name: 'r2' }],
    initial: 'r0',
    transitions: [
      { id: 't', from: 'r0', action: 'tau', to: 'r1' },
      { id: 'x', from: 'r1', action: 'x', to: 'r2' },
    ],
  };
  assert.equal(checkTraceInclusion(L, R).included, true);
});

test('缺失动作：最短反例为单动作轨迹 x', () => {
  const r = runTraceDirection(samples.missing.procA, samples.missing.procB, 'A');
  assert.equal(r.included, false);
  assert.deepEqual(r.trace, ['x']);
  assert.equal(r.rounds.length, 1);
  const rd = r.rounds[0];
  assert.equal(rd.action, 'x');
  assert.equal(rd.leftPosition, 'a0');
  assert.deepEqual(rd.leftTargets, ['a1']);
  assert.deepEqual(rd.rightBefore, ['b0']);
  assert.deepEqual(rd.rightResponses, []);
  assert.equal(rd.firstEmpty, true);
});

test('反向缺失动作：B⊑A 的最短反例为 y', () => {
  const r = runTraceDirection(samples.missing.procA, samples.missing.procB, 'B');
  assert.equal(r.included, false);
  assert.deepEqual(r.trace, ['y']);
  assert.equal(r.leftSide, 'B');
  assert.equal(r.rightSide, 'A');
});

test('双向结果不同的边界：A⊑B 成立而 B⊑A 反例为 y', () => {
  const ab = runTraceDirection(samples.oneway.procA, samples.oneway.procB, 'A');
  assert.equal(ab.included, true, 'A 只有 x，B 静默环外可承接 x');
  const ba = runTraceDirection(samples.oneway.procA, samples.oneway.procB, 'B');
  assert.equal(ba.included, false);
  assert.deepEqual(ba.trace, ['y']);
  // 反例轮：B 初始可经静默环停留于 b0，A 侧初始集合 {a0} 无 y 响应
  const rd = ba.rounds[0];
  assert.equal(rd.leftPosition, 'b0');
  assert.deepEqual(rd.rightBefore, ['a0']);
  assert.deepEqual(rd.rightResponses, []);
});

test('最短反例：首轮均承接时继续推进，在第二轮给出空响应', () => {
  const L = {
    states: [{ name: 'l0' }, { name: 'l1' }, { name: 'l2' }],
    initial: 'l0',
    transitions: [
      { id: 'x', from: 'l0', action: 'x', to: 'l1' },
      { id: 'y', from: 'l1', action: 'y', to: 'l2' },
    ],
  };
  const R = {
    states: [{ name: 'r0' }, { name: 'r1' }],
    initial: 'r0',
    transitions: [{ id: 'x', from: 'r0', action: 'x', to: 'r1' }],
  };
  const r = checkTraceInclusion(L, R);
  assert.equal(r.included, false);
  assert.deepEqual(r.trace, ['x', 'y']);
  assert.equal(r.rounds.length, 2);
  assert.equal(r.rounds[0].firstEmpty, false);
  assert.equal(r.rounds[0].nextLeft, 'l1');
  assert.deepEqual(r.rounds[0].nextRight, ['r1']);
  const last = r.rounds[1];
  assert.equal(last.leftPosition, 'l1');
  assert.deepEqual(last.rightBefore, ['r1']);
  assert.deepEqual(last.rightResponses, []);
  assert.equal(last.firstEmpty, true);
});

test('同长度按动作 ASCII 序最小：可选动作 a 与 z 均失败时反例取 a', () => {
  const L = {
    states: [{ name: 'l0' }, { name: 'l1' }],
    initial: 'l0',
    transitions: [
      { id: 'z', from: 'l0', action: 'z', to: 'l1' },
      { id: 'a', from: 'l0', action: 'a', to: 'l1' },
    ],
  };
  const R = {
    states: [{ name: 'r0' }],
    initial: 'r0',
    transitions: [],
  };
  const r = checkTraceInclusion(L, R);
  assert.equal(r.included, false);
  assert.deepEqual(r.trace, ['a']);
});

test('左侧须经静默前缀（含静默环）才能发起的动作仍被检查', () => {
  const L = {
    states: [{ name: 'l0' }, { name: 'l1' }, { name: 'l2' }],
    initial: 'l0',
    transitions: [
      { id: 'loop', from: 'l0', action: 'tau', to: 'l0' },
      { id: 't', from: 'l0', action: 'tau', to: 'l1' },
      { id: 'x', from: 'l1', action: 'x', to: 'l2' },
    ],
  };
  const R = {
    states: [{ name: 'r0' }],
    initial: 'r0',
    transitions: [{ id: 't', from: 'r0', action: 'tau', to: 'r0' }],
  };
  const r = checkTraceInclusion(L, R);
  assert.equal(r.included, false);
  assert.deepEqual(r.trace, ['x']);
  assert.deepEqual(r.rounds[0].leftClosure.sort(), ['l0', 'l1']);
});

test('右侧非确定性响应集合：某一可能落点可承接即包含成立', () => {
  const L = {
    states: [{ name: 'l0' }, { name: 'l1' }, { name: 'l2' }],
    initial: 'l0',
    transitions: [
      { id: 'x', from: 'l0', action: 'x', to: 'l1' },
      { id: 'y', from: 'l1', action: 'y', to: 'l2' },
    ],
  };
  const R = {
    states: [{ name: 'r0' }, { name: 'r1' }, { name: 'r2' }, { name: 'r3' }],
    initial: 'r0',
    transitions: [
      { id: 'x1', from: 'r0', action: 'x', to: 'r1' },
      { id: 'x2', from: 'r0', action: 'x', to: 'r2' },
      { id: 'y', from: 'r1', action: 'y', to: 'r3' }, // r2 为无 y 的死分支
    ],
  };
  const r = checkTraceInclusion(L, R);
  assert.equal(r.included, true);
});

test('非确定性中唯一可行分支随后失败：反例沿可行分支复算右侧集合', () => {
  const L = {
    states: [{ name: 'l0' }, { name: 'l1' }, { name: 'l2' }, { name: 'l3' }],
    initial: 'l0',
    transitions: [
      { id: 'x', from: 'l0', action: 'x', to: 'l1' },
      { id: 'y', from: 'l1', action: 'y', to: 'l2' },
      { id: 'z', from: 'l2', action: 'z', to: 'l3' },
    ],
  };
  const R = {
    states: [{ name: 'r0' }, { name: 'r1' }, { name: 'r2' }, { name: 'r3' }, { name: 'r4' }],
    initial: 'r0',
    transitions: [
      { id: 'x1', from: 'r0', action: 'x', to: 'r1' },
      { id: 'x2', from: 'r0', action: 'x', to: 'r2' }, // 死分支
      { id: 'y', from: 'r1', action: 'y', to: 'r3' },
      // r3 无 z
    ],
  };
  const r = checkTraceInclusion(L, R);
  assert.equal(r.included, false);
  assert.deepEqual(r.trace, ['x', 'y', 'z']);
  // 每轮右侧集合沿前驱链复算，非失败轮均有非空响应
  assert.deepEqual(r.rounds[0].rightResponses.sort(), ['r1', 'r2']);
  assert.deepEqual(r.rounds[0].nextRight.sort(), ['r1', 'r2']);
  assert.deepEqual(r.rounds[1].rightResponses, ['r3']);
  assert.deepEqual(r.rounds[2].rightResponses, []);
  for (const rd of r.rounds.slice(0, -1)) assert.ok(rd.rightResponses.length > 0);
});

test('前沿包含剪枝不改变最短反例结论（更长伪分支不掩盖短失败）', () => {
  const L = {
    states: [{ name: 'l0' }, { name: 'l1' }, { name: 'l2' }, { name: 'l3' }],
    initial: 'l0',
    transitions: [
      // x 进入长链；a 立刻失败
      { id: 'x', from: 'l0', action: 'x', to: 'l1' },
      { id: 'a', from: 'l0', action: 'a', to: 'l3' },
      { id: 'y', from: 'l1', action: 'y', to: 'l2' },
      { id: 'z', from: 'l2', action: 'z', to: 'l3' },
    ],
  };
  const R = {
    states: [{ name: 'r0' }, { name: 'r1' }],
    initial: 'r0',
    transitions: [
      { id: 'x', from: 'r0', action: 'x', to: 'r1' },
      { id: 'y', from: 'r1', action: 'y', to: 'r0' },
    ],
  };
  const r = checkTraceInclusion(L, R);
  assert.equal(r.included, false);
  assert.deepEqual(r.trace, ['a']); // 长度 1 优先于长度 3
});

test('18 状态链式规程可终止并给出正确包含结论', () => {
  const n = 18;
  const chain = (prefix) => ({
    states: Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i}` })),
    initial: `${prefix}0`,
    transitions: Array.from({ length: n - 1 }, (_, i) => ({ id: `${prefix}a${i}`, from: `${prefix}${i}`, action: 'a', to: `${prefix}${i + 1}` })),
  });
  const withTail = (p) => {
    const c = chain(p);
    const last = `${p}${n - 1}`;
    c.transitions.push({ id: `${p}b`, from: last, action: 'b', to: last });
    return c;
  };
  assert.equal(checkTraceInclusion(chain('l'), chain('r')).included, true);
  const leftExtra = checkTraceInclusion(withTail('l'), chain('r'));
  assert.equal(leftExtra.included, false);
  assert.deepEqual(leftExtra.trace, [...Array(n - 1).fill('a'), 'b']);
  // 右侧多出的承诺不影响左侧包含
  assert.equal(checkTraceInclusion(chain('l'), withTail('r')).included, true);
});
