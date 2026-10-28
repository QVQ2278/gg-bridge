/**
 * OneBot 适配器的纯函数测试：不连网、不起进程，只验消息解析和触发判断。
 * 跑法：npm test
 */
import assert from 'node:assert/strict';
import { extractText, OneBotAdapter } from '../src/adapters/onebot.js';

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

// ── extractText ──────────────────────────────────────────────
check('纯文本段', () => {
  assert.equal(extractText([{ type: 'text', data: { text: '在吗' } }]), '在吗');
});

check('@ 被剥掉，文本保留', () => {
  const msg = [
    { type: 'at', data: { qq: '123' } },
    { type: 'text', data: { text: ' 看看这个' } },
  ];
  assert.equal(extractText(msg), '看看这个');
});

check('图片/表情占位', () => {
  const msg = [
    { type: 'image', data: { file: 'a.jpg' } },
    { type: 'face', data: { id: '1' } },
  ];
  assert.equal(extractText(msg), '[图片][表情]');
});

check('CQ 码字符串被清掉', () => {
  assert.equal(extractText('[CQ:at,qq=123] 你好'), '你好');
});

// ── stripTrigger ─────────────────────────────────────────────
const groupPkt = (text, extra = []) => ({
  message_type: 'group',
  group_id: 999,
  user_id: 42,
  message: [{ type: 'text', data: { text } }, ...extra],
});

check('私聊一律接', () => {
  const a = new OneBotAdapter({ groupReply: 'mention' });
  const out = a.stripTrigger({ message_type: 'private', message: [] }, '随便说啥', { type: 'private' });
  assert.equal(out, '随便说啥');
});

check('群里 @ 了才接', () => {
  const a = new OneBotAdapter({ groupReply: 'mention' });
  a.selfId = 123;
  const ctx = { type: 'group' };
  assert.equal(a.stripTrigger(groupPkt('今天吃啥'), '今天吃啥', ctx), null);
  const mentioned = groupPkt('今天吃啥', [{ type: 'at', data: { qq: '123' } }]);
  assert.equal(a.stripTrigger(mentioned, '今天吃啥', ctx), '今天吃啥');
});

check('群里前缀触发，前缀被剥掉', () => {
  const a = new OneBotAdapter({ groupReply: 'prefix', prefixes: ['gg'] });
  const ctx = { type: 'group' };
  assert.equal(a.stripTrigger(groupPkt('gg 你好'), 'gg 你好', ctx), '你好');
  assert.equal(a.stripTrigger(groupPkt('你好'), '你好', ctx), null);
});

check('always 模式群里全接', () => {
  const a = new OneBotAdapter({ groupReply: 'always' });
  assert.equal(a.stripTrigger(groupPkt('嗯'), '嗯', { type: 'group' }), '嗯');
});

console.log(`\n${passed} 项通过`);
