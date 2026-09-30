'use strict';

// 页面内置示例：
//  1. equivalent —— 仅差一个可观察上不可见的 tau 自环（状态重命名），应判定等价
//  2. missing    —— 一侧可观察动作另一侧无法承接，应判定不等价
//  3. cascade    —— 多轮淘汰：初始对在第 2 轮因引用第 1 轮淘汰结果而失败
//  4. oneway     —— 方向性边界：A 仅能 x，B 能 x 或 y；弱互模拟不等价，
//                   但 A→B 轨迹全部可承接，B→A 存在最短反例 [y]

const samples = {
  equivalent: {
    label: 'tau 自环 + 重命名（应等价）',
    procA: {
      states: [{ name: 'S0' }, { name: 'S1' }],
      initial: 'S0',
      transitions: [
        { id: 'a-tau-loop', from: 'S0', action: 'tau', to: 'S0' },
        { id: 'a-x', from: 'S0', action: 'x', to: 'S1' },
      ],
    },
    procB: {
      states: [{ name: 'P0' }, { name: 'P1' }],
      initial: 'P0',
      transitions: [{ id: 'b-x', from: 'P0', action: 'x', to: 'P1' }],
    },
  },
  missing: {
    label: '缺失匹配动作（应不等价）',
    procA: {
      states: [{ name: 'a0' }, { name: 'a1' }],
      initial: 'a0',
      transitions: [{ id: 'ax', from: 'a0', action: 'x', to: 'a1' }],
    },
    procB: {
      states: [{ name: 'b0' }, { name: 'b1' }],
      initial: 'b0',
      transitions: [{ id: 'by', from: 'b0', action: 'y', to: 'b1' }],
    },
  },
  cascade: {
    label: '多轮级联淘汰（初始对第 2 轮失败）',
    procA: {
      states: [{ name: 'a0' }, { name: 'a1' }, { name: 'a2' }],
      initial: 'a0',
      transitions: [
        { id: 'ax', from: 'a0', action: 'x', to: 'a1' },
        { id: 'ay', from: 'a1', action: 'y', to: 'a2' },
      ],
    },
    procB: {
      states: [{ name: 'b0' }, { name: 'b1' }],
      initial: 'b0',
      transitions: [{ id: 'bx', from: 'b0', action: 'x', to: 'b1' }],
    },
  },
  oneway: {
    label: '单向包含边界（A→B 承接，B→A 反例 [y]）',
    procA: {
      states: [{ name: 'a0' }, { name: 'a1' }],
      initial: 'a0',
      transitions: [{ id: 'ax', from: 'a0', action: 'x', to: 'a1' }],
    },
    procB: {
      states: [{ name: 'b0' }, { name: 'b1' }, { name: 'b2' }],
      initial: 'b0',
      transitions: [
        { id: 'bx', from: 'b0', action: 'x', to: 'b1' },
        { id: 'by', from: 'b0', action: 'y', to: 'b2' },
      ],
    },
  },
};

module.exports = { samples };
