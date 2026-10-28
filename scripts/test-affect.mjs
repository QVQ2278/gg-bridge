/**
 * 情绪状态机的测试：衰减公式、标签插值、增量方向、持久化。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AffectStore, analyze, computeDecay } from '../src/persona/affect.js';
import { affectionLevel, getEmotionDescription } from '../src/persona/emotion.js';

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

// ── 衰减 ────────────────────────────────────────────────
check('衰减：时间到就回到基线', () => {
  assert.equal(computeDecay(2, 10, 2), -10);
  assert.equal(computeDecay(5, 10, 2), -10);
});

check('衰减：半程只回四分之一（二次曲线）', () => {
  assert.equal(computeDecay(1, 8, 2), -8 * 0.25);
});

check('衰减：偏离为负时反向回补', () => {
  assert.ok(computeDecay(1, -8, 2) > 0);
});

// ── 标签 ────────────────────────────────────────────────
check('好感度分档', () => {
  assert.equal(affectionLevel(0), 0);
  assert.equal(affectionLevel(20), 25);
  assert.equal(affectionLevel(50), 50);
  assert.equal(affectionLevel(80), 75);
  assert.equal(affectionLevel(99), 100);
});

check('落在档位上时是单一标签', () => {
  const d = getEmotionDescription({
    affection: 75, libidoOther: 50, aggressionOther: 0,
    libidoSelf: 25, aggressionSelf: 0,
  });
  assert.equal(d.towardsUser, '痴迷');
  assert.equal(d.selfState, '自信');
});

check('落在档位之间时是混合标签', () => {
  const d = getEmotionDescription({
    affection: 75, libidoOther: 31.25, aggressionOther: 0,
    libidoSelf: 25, aggressionSelf: 0,
  });
  assert.ok(/[（(]/.test(d.towardsUser), `期望混合标签，得到 ${d.towardsUser}`);
});

check('数值都夹在 0~50 的档位里不炸', () => {
  const d = getEmotionDescription({
    affection: 0, libidoOther: 0, aggressionOther: 50,
    libidoSelf: 0, aggressionSelf: 50,
  });
  assert.equal(d.towardsUser, '湮灭');
  assert.equal(d.selfState, '湮灭');
});

// ── 规则打分 ─────────────────────────────────────────────
check('夸一句：力比多升、攻击性降、好感升', () => {
  const d = analyze('谢谢你，你真好', { turn: 1, affection: 50 });
  assert.ok(d.libidoOtherDelta > 0);
  assert.ok(d.aggressionOtherDelta < 0);
  assert.ok(d.affectionDelta > 0);
});

check('骂一句：力比多降、攻击性升、好感降', () => {
  const d = analyze('滚，烦死了，闭嘴', { turn: 5, affection: 50 });
  assert.ok(d.libidoOtherDelta < 0);
  assert.ok(d.aggressionOtherDelta > 0);
  assert.ok(d.affectionDelta < 0);
});

check('撒娇求安慰：力比多升、攻击性降', () => {
  const d = analyze('今天好累，有点想哭', { turn: 3, affection: 50 });
  assert.ok(d.libidoOtherDelta > 0);
  assert.ok(d.aggressionOtherDelta < 0);
});

check('增量被钳在 ±1', () => {
  const d = analyze('滚 烦 笨 讨厌 垃圾 闭嘴 恶心 废物', { turn: 50, affection: 50 });
  assert.ok(d.libidoOtherDelta >= -1 && d.libidoOtherDelta <= 1);
  assert.ok(d.aggressionOtherDelta >= -1 && d.aggressionOtherDelta <= 1);
});

// ── 状态机 ───────────────────────────────────────────────
check('一轮之后轮次 +1、数值变化、能落盘', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'affect-'));
  const file = path.join(dir, 'state.json');
  try {
    const store = new AffectStore({ file });
    const before = store.user('qq:1').affection;
    store.updateTurn('qq:1', '谢谢你');
    const after = store.user('qq:1').affection;
    assert.equal(store.user('qq:1').turn, 1);
    assert.ok(after > before);
    assert.ok(fs.existsSync(file));

    const reloaded = new AffectStore({ file });
    assert.equal(reloaded.user('qq:1').turn, 1);
    assert.equal(reloaded.user('qq:1').affection.toFixed(2), after.toFixed(2));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('情绪提示包含标签且不含小数面板以外的内容', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'affect-'));
  try {
    const store = new AffectStore({ file: path.join(dir, 's.json') });
    const prompt = store.promptFor('qq:2');
    assert.match(prompt, /【当前情绪状态】/);
    assert.match(prompt, /好感 \d/);
    assert.match(prompt, /不要提及任何数值/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const { name, fn } of checks) {
  await fn();
  console.log(`  ok  ${name}`);
}
console.log(`\n${checks.length} 项通过`);
