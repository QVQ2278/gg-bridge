/**
 * 情绪标签表 + 双线性插值。
 *
 * 这套模型照搬 astrbot_plugin_affection（Python 版），表数据是从它的
 * emotion_tables.py 用 ast 直接转出来的 JSON，没有手抄，避免抄错。
 *
 * 三个维度：
 *   · 好感度 0~100 —— 分 5 档（0/25/50/75/100），决定「对他」用哪张表
 *   · 他力比多 / 他攻击性 0~50 —— 各分 5 档（0/12.5/25/37.5/50）
 *   · 自力比多 / 自攻击性 0~50 —— 共用一张 SELF_TABLE
 *
 * 落在档位之间时做双线性插值，把四个角的标签按权重混成一个说法。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW = JSON.parse(fs.readFileSync(path.join(HERE, 'emotion-tables.json'), 'utf8'));

// Python 那边键是 "50.0,0.0"，这里统一成 "50,0"，免得每次查表拼接对不上
const normKey = (key) => key.split(',').map((part) => String(Number(part))).join(',');

const TABLES = {
  SELF_TABLE: Object.fromEntries(
    Object.entries(RAW.SELF_TABLE).map(([k, v]) => [normKey(k), v]),
  ),
  TOWARDS_USER_TABLE: Object.fromEntries(
    Object.entries(RAW.TOWARDS_USER_TABLE).map(([level, inner]) => [
      String(Number(level)),
      Object.fromEntries(Object.entries(inner).map(([k, v]) => [normKey(k), v])),
    ]),
  ),
};

const BRACKETS = [0, 12.5, 25, 37.5, 50];

/** 好感度 -> 档位（0/25/50/75/100）。 */
export function affectionLevel(affection) {
  if (affection < 12.5) return 0;
  if (affection < 37.5) return 25;
  if (affection < 62.5) return 50;
  if (affection < 87.5) return 75;
  return 100;
}

/** 找到值所在的档位区间与两侧权重。 */
function bracketInfo(value) {
  for (let i = 0; i < BRACKETS.length; i += 1) {
    const b = BRACKETS[i];
    if (value <= b) {
      if (value === b || i === 0) return { lower: b, upper: b, wLower: 1, wUpper: 0 };
      const lower = BRACKETS[i - 1];
      const gap = b - lower;
      const wUpper = gap === 0 ? 0 : (value - lower) / gap;
      return { lower, upper: b, wLower: 1 - wUpper, wUpper };
    }
  }
  const last = BRACKETS[BRACKETS.length - 1];
  return { lower: last, upper: last, wLower: 1, wUpper: 0 };
}

/** 两个标签混成一个说法。 */
function formatBlend(label1, pct1, label2) {
  const pct2 = 100 - pct1;
  if (label1 === label2) return label1;
  if (pct1 < 15) return `${label2}（偏${label1}）`;
  if (pct1 > 85) return `${label1}（偏${label2}）`;
  if (pct1 >= 40 && pct2 >= 40) return `${label1}(${pct1}%)/${label2}(${pct2}%)`;
  if (pct1 >= pct2) return `${label1}（偏${label2}）`;
  return `${label2}（偏${label1}）`;
}

/** 双线性插值：四个角的标签按权重混合。 */
function bilinear(table, lib, agg) {
  const libInfo = bracketInfo(lib);
  const aggInfo = bracketInfo(agg);

  const corners = [
    [table[`${libInfo.lower},${aggInfo.lower}`], libInfo.wLower * aggInfo.wLower],
    [table[`${libInfo.lower},${aggInfo.upper}`], libInfo.wLower * aggInfo.wUpper],
    [table[`${libInfo.upper},${aggInfo.lower}`], libInfo.wUpper * aggInfo.wLower],
    [table[`${libInfo.upper},${aggInfo.upper}`], libInfo.wUpper * aggInfo.wUpper],
  ].filter(([label]) => label);

  const range = {
    libRange: `${libInfo.lower}-${libInfo.upper}`,
    aggRange: `${aggInfo.lower}-${aggInfo.upper}`,
  };

  if (corners.length === 0) return { label: '平淡', info: { note: '无匹配标签', ...range } };
  if (corners.length === 1) {
    return { label: corners[0][0], info: { labels: `${corners[0][0]} (精确匹配)`, ...range } };
  }

  const total = corners.reduce((sum, [, w]) => sum + w, 0) || 1;
  const sorted = corners
    .map(([label, w]) => [label, w / total])
    .sort((a, b) => b[1] - a[1]);

  const label1 = sorted[0][0];
  const label2 = sorted[1][0];
  const pct1 = Math.floor(sorted[0][1] * 100);

  return {
    label: formatBlend(label1, pct1, label2),
    info: { labels: `${label1}(${pct1}%)/${label2}(${100 - pct1}%)`, ...range },
  };
}

/**
 * 把五个数值翻成人话。
 * @returns {{towardsUser: string, selfState: string, towardsInfo: object, selfInfo: object, affection: number, ...}}
 */
export function getEmotionDescription({
  affection,
  libidoOther,
  aggressionOther,
  libidoSelf,
  aggressionSelf,
}) {
  const level = affectionLevel(affection);
  const table = TABLES.TOWARDS_USER_TABLE[String(level)] ?? {};
  const towards = bilinear(table, libidoOther, aggressionOther);
  const self = bilinear(TABLES.SELF_TABLE, libidoSelf, aggressionSelf);

  return {
    towardsUser: towards.label,
    selfState: self.label,
    towardsInfo: towards.info,
    selfInfo: self.info,
    affection: round2(affection),
    libidoOther: round2(libidoOther),
    aggressionOther: round2(aggressionOther),
    libidoSelf: round2(libidoSelf),
    aggressionSelf: round2(aggressionSelf),
    affLevel: level,
  };
}

const round2 = (n) => Math.round(n * 100) / 100;
