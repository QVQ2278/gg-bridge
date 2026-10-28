/**
 * 情绪状态机：数值持久化、时间衰减、每轮更新、提示词生成。
 *
 * 模型（与 astrbot_plugin_affection 一致）：
 *   · 对他：好感度 0~100 + 他力比多 / 他攻击性 0~50（各有基线 + 当前值）
 *   · 对己：自力比多 / 自攻击性 0~50（全局一份，不分会话）
 *   · 偏离基线后按二次曲线衰减，duration 小时回到基线
 *   · 每轮由「潜意识分析」给出一组增量；这里先用规则打分，之后可换成 LLM
 */
import fs from 'node:fs';
import path from 'node:path';
import { getEmotionDescription } from './emotion.js';

const DEFAULTS = {
  initialAffection: 50,
  initialLibidoOther: 25,
  initialAggressionOther: 25,
  initialLibidoSelf: 25,
  initialAggressionSelf: 25,
  decayDurationHours: 2,
  emotionLockTurns: 1,
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * 二次衰减：从 event 开始经过 elapsedHours，应向基线靠拢多少。
 * y(x) = deviation * (1 - (x/n)^2)，所以 delta = -deviation * (x/n)^2。
 */
export function computeDecay(elapsedHours, deviation, durationHours) {
  const duration = durationHours > 0 ? durationHours : 0.5;
  if (elapsedHours >= duration) return -deviation;
  return -(deviation * (elapsedHours / duration) ** 2);
}

// ── 潜意识分析（规则版）────────────────────────────────────
// 真正的实现是让 LLM 输出 JSON 增量；这里先用词表打分，够用且零成本。
const POSITIVE = ['谢谢', '谢啦', '喜欢', '爱你', '想你', '乖', '好棒', '厉害', '加油', '辛苦',
  '可爱', '真好', '么么', '抱抱', '在等你', '陪你', '开心', '厉害呀', '牛'];
const NEGATIVE = ['滚', '烦', '闭嘴', '笨', '蠢', '讨厌', '垃圾', '废物', '傻子', '恶心', '别烦我', '走开'];
const SAD = ['难过', '累', '不开心', '想哭', '委屈', '崩溃', '孤独', '睡不着', '难受', 'emo'];
const PLAYFUL = ['哈哈', '草', '笑死', '乐', '嘿嘿', '233'];

const hits = (text, words) => words.filter((w) => text.includes(w)).length;

/**
 * 分析一句话对情绪的影响，返回增量（形状与插件一致）。
 * @param {string} text 用户说的话
 * @param {{turn: number, affection: number}} ctx
 */
export function analyze(text, ctx = {}) {
  const t = String(text ?? '');
  const pos = hits(t, POSITIVE);
  const neg = hits(t, NEGATIVE);
  const sad = hits(t, SAD);
  const fun = hits(t, PLAYFUL);

  let libido = 0;
  let aggression = 0;
  let affection = 0;
  let intensity = 1;

  if (neg > 0) {
    libido -= 0.8 * Math.min(neg, 2);
    aggression += 0.7 * Math.min(neg, 2);
    affection -= 0.4;
    intensity = 1.5;
  }
  if (pos > 0) {
    libido += 0.6 * Math.min(pos, 2);
    aggression -= 0.3 * Math.min(pos, 2);
    affection += 0.3;
    intensity = 1;
  }
  if (sad > 0) {
    libido += 0.4;
    aggression -= 0.15;
    affection += 0.1;
  }
  if (fun > 0 && neg === 0) {
    libido += 0.2;
    aggression += 0.1;
  }
  if (!pos && !neg && !sad && !fun) {
    // 中性闲聊也给一丁点方向，避免数值永远不动（插件里的 default_response 同款思路）
    const bias = (ctx.affection ?? 50) > 60 ? 0.05 : ((ctx.affection ?? 50) < 40 ? -0.05 : 0.02);
    libido += bias;
    aggression += bias;
  }

  // 句子越长，情绪波动越强（但封顶）
  intensity = clamp(intensity * (1 + Math.min(t.length, 120) / 400), 0.5, 2);

  // 基线随初印象微调：前 10 轮可以明显一点，之后就很难改
  const turn = ctx.turn ?? 1;
  const baseCap = turn <= 10 ? 1.5 : 0.2;

  return {
    libidoOtherDelta: clamp(libido * intensity, -1, 1),
    aggressionOtherDelta: clamp(aggression * intensity, -1, 1),
    libidoSelfDelta: clamp(libido * 0.1, -1, 1),
    aggressionSelfDelta: clamp(aggression * 0.1, -1, 1),
    affectionDelta: clamp(affection, -1, 1),
    baseLibidoOtherDelta: clamp(libido * 0.15 * intensity, -baseCap, baseCap),
    baseAggressionOtherDelta: clamp(aggression * 0.15 * intensity, -baseCap, baseCap),
    baseLibidoSelfDelta: clamp(libido * 0.02, -0.2, 0.2),
    baseAggressionSelfDelta: clamp(aggression * 0.02, -0.2, 0.2),
    intensity,
  };
}

// ── 状态机 ────────────────────────────────────────────────

export class AffectStore {
  constructor({ file, config = {} } = {}) {
    this.config = { ...DEFAULTS, ...config };
    this.file = file;
    this.data = this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && raw.self && raw.users) return raw;
    } catch {
      // 文件不存在/坏了就用初始值
    }
    return {
      self: {
        baseLibidoSelf: this.config.initialLibidoSelf,
        baseAggressionSelf: this.config.initialAggressionSelf,
        currentLibidoSelf: this.config.initialLibidoSelf,
        currentAggressionSelf: this.config.initialAggressionSelf,
        lastUpdate: Date.now(),
      },
      users: {},
    };
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      // 存不下去也不该把桥弄挂
      console.warn('[affect] 状态存不下来：', err.message);
    }
  }

  user(key) {
    if (!this.data.users[key]) {
      this.data.users[key] = {
        affection: this.config.initialAffection,
        baseLibidoOther: this.config.initialLibidoOther,
        baseAggressionOther: this.config.initialAggressionOther,
        currentLibidoOther: this.config.initialLibidoOther,
        currentAggressionOther: this.config.initialAggressionOther,
        turn: 0,
        lastInteraction: Date.now(),
        lastUpdate: Date.now(),
      };
    }
    return this.data.users[key];
  }

  /** 把某一组「当前值与基线」按经过时间拉回基线。 */
  decayGroup(group, currentField, baseField, now) {
    const elapsed = (now - (group.lastUpdate ?? now)) / 3600_000;
    if (elapsed <= 0) return false;
    const deviation = group[currentField] - group[baseField];
    if (Math.abs(deviation) < 0.001) return false;
    const next = clamp(
      group[currentField] + computeDecay(elapsed, deviation, this.config.decayDurationHours),
      0, 50,
    );
    if (Math.abs(next - group[currentField]) < 0.0001) return false;
    group[currentField] = next;
    return true;
  }

  decayAll() {
    const now = Date.now();
    let changed = false;
    if (this.decayGroup(this.data.self, 'currentLibidoSelf', 'baseLibidoSelf', now)) changed = true;
    if (this.decayGroup(this.data.self, 'currentAggressionSelf', 'baseAggressionSelf', now)) changed = true;
    if (changed) this.data.self.lastUpdate = now;

    for (const key of Object.keys(this.data.users)) {
      const u = this.data.users[key];
      const dirtyA = this.decayGroup(u, 'currentLibidoOther', 'baseLibidoOther', now);
      const dirtyB = this.decayGroup(u, 'currentAggressionOther', 'baseAggressionOther', now);
      if (dirtyA || dirtyB) {
        u.lastUpdate = now;
        changed = true;
      }
    }
    return changed;
  }

  describe(key) {
    const u = this.user(key);
    const s = this.data.self;
    return getEmotionDescription({
      affection: u.affection,
      libidoOther: u.currentLibidoOther,
      aggressionOther: u.currentAggressionOther,
      libidoSelf: s.currentLibidoSelf,
      aggressionSelf: s.currentAggressionSelf,
    });
  }

  /** 生成注入给 agent 的情绪提示；按 emotion_lock_turns 控制频率。 */
  promptFor(key) {
    this.decayAll(); // 读之前先按时间衰减，别让隔夜的余温还在
    const u = this.user(key);
    const s = this.data.self;
    const lock = Math.max(1, this.config.emotionLockTurns);
    const shouldInject = (u.turn % lock) === 0 || u.turn === 0;
    if (!shouldInject) return '';

    const emo = this.describe(key);
    const sign = (v) => (v > 0.1 ? '↑' : (v < -0.1 ? '↓' : '→'));

    const libOther = emo.libidoOther - u.baseLibidoOther;
    const aggOther = emo.aggressionOther - u.baseAggressionOther;
    const libSelf = emo.libidoSelf - s.baseLibidoSelf;
    const aggSelf = emo.aggressionSelf - s.baseAggressionSelf;

    const towards = emo.towardsInfo?.labels
      ? `对你（${emo.towardsUser}） [${emo.towardsInfo.labels}]`
      : `对你（${emo.towardsUser}）`;
    const self = emo.selfInfo?.labels
      ? `自身状态（${emo.selfState}） [${emo.selfInfo.labels}]`
      : `自身状态（${emo.selfState}）`;

    return [
      '【当前情绪状态】',
      towards,
      self,
      `【数值参考】好感 ${emo.affection}/100 | `
      + `他力比多 ${emo.libidoOther} 基线${u.baseLibidoOther}(${sign(libOther)}${Math.abs(round2(libOther))}) / `
      + `他攻击性 ${emo.aggressionOther} 基线${u.baseAggressionOther}(${sign(aggOther)}${Math.abs(round2(aggOther))}) | `
      + `自力比多 ${emo.libidoSelf} 基线${s.baseLibidoSelf}(${sign(libSelf)}${Math.abs(round2(libSelf))}) / `
      + `自攻击性 ${emo.aggressionSelf} 基线${s.baseAggressionSelf}(${sign(aggSelf)}${Math.abs(round2(aggSelf))})`,
      '请根据上述状态演绎角色，不要提及任何数值。',
    ].join('\n');
  }

  /** 一轮结束后更新数值。 */
  updateTurn(key, userText) {
    const u = this.user(key);
    const s = this.data.self;
    const now = Date.now();

    this.decayAll();

    u.turn += 1;
    const deltas = analyze(userText, { turn: u.turn, affection: u.affection });

    u.currentLibidoOther = clamp(u.currentLibidoOther + deltas.libidoOtherDelta, 0, 50);
    u.currentAggressionOther = clamp(u.currentAggressionOther + deltas.aggressionOtherDelta, 0, 50);
    u.baseLibidoOther = clamp(u.baseLibidoOther + deltas.baseLibidoOtherDelta, 0, 50);
    u.baseAggressionOther = clamp(u.baseAggressionOther + deltas.baseAggressionOtherDelta, 0, 50);
    u.affection = clamp(u.affection + deltas.affectionDelta, 0, 100);

    s.currentLibidoSelf = clamp(s.currentLibidoSelf + deltas.libidoSelfDelta, 0, 50);
    s.currentAggressionSelf = clamp(s.currentAggressionSelf + deltas.aggressionSelfDelta, 0, 50);
    s.baseLibidoSelf = clamp(s.baseLibidoSelf + deltas.baseLibidoSelfDelta, 0, 50);
    s.baseAggressionSelf = clamp(s.baseAggressionSelf + deltas.baseAggressionSelfDelta, 0, 50);

    u.lastInteraction = now;
    u.lastUpdate = now;
    s.lastUpdate = now;

    this.save();
    return deltas;
  }

  /** `/情绪` 这类调试指令的输出。 */
  statusText(key) {
    const u = this.user(key);
    const s = this.data.self;
    const emo = this.describe(key);
    return [
      '【情绪档案】',
      `好感度：${round2(u.affection)}/100`,
      `对他：力比多 ${round2(u.currentLibidoOther)}（基线 ${round2(u.baseLibidoOther)}）| 攻击性 ${round2(u.currentAggressionOther)}（基线 ${round2(u.baseAggressionOther)}）`,
      `对己：力比多 ${round2(s.currentLibidoSelf)}（基线 ${round2(s.baseLibidoSelf)}）| 攻击性 ${round2(s.currentAggressionSelf)}（基线 ${round2(s.baseAggressionSelf)}）`,
      `轮次：${u.turn}`,
      `对你情感：${emo.towardsUser}`,
      `自身状态：${emo.selfState}`,
    ].join('\n');
  }
}
