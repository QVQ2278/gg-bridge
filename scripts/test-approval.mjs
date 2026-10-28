/**
 * 审批/提问通道的测试：不连 DSH，只验「事件怎么解析」和「答复怎么发」。
 */
import assert from 'node:assert/strict';
import { DshClient } from '../src/dsh/client.js';

let passed = 0;
const checks = [];
const check = (name, fn) => { checks.push({ name, fn }); };

/** 造一个不连网、只记录 RPC 的客户端。 */
function stubClient() {
  const client = new DshClient({ baseUrl: 'http://127.0.0.1:1', cookie: 'fake' });
  client.calls = [];
  client.callUnary = async (method, payload) => {
    client.calls.push({ method, payload });
    return { ok: true };
  };
  return client;
}

check('ready 帧拿到 clientId', () => {
  const c = stubClient();
  c.onEventFrame({ type: 'ready', clientId: 'client-1' });
  assert.equal(c.eventClientId, 'client-1');
});

check('approval/request 解析成 approval 事件', () => {
  const c = stubClient();
  c.onEventFrame({ type: 'ready', clientId: 'client-1' });
  let got = null;
  c.on('approval', (req) => { got = req; });
  c.onEventFrame({
    type: 'waterfall',
    event: 'approval/request',
    eventId: 'evt-1',
    agentId: 'session-1',
    request: { toolName: 'shell', callId: 'call-1', reason: '要跑命令' },
  });
  assert.deepEqual(got, {
    sessionId: 'session-1',
    clientId: 'client-1',
    eventId: 'evt-1',
    toolName: 'shell',
    callId: 'call-1',
    reason: '要跑命令',
  });
});

check('user-questions/request 解析成 question 事件', () => {
  const c = stubClient();
  c.onEventFrame({ type: 'ready', clientId: 'client-1' });
  let got = null;
  c.on('question', (req) => { got = req; });
  c.onEventFrame({
    type: 'waterfall',
    event: 'user-questions/request',
    eventId: 'evt-2',
    agentId: 'session-1',
    request: { questions: [{ id: 'q1', prompt: '选哪个' }] },
  });
  assert.equal(got.eventId, 'evt-2');
  assert.equal(got.questions.length, 1);
});

check('approve 发出 $events/result，outcome 是 allowed-once', async () => {
  const c = stubClient();
  await c.approve({ clientId: 'client-1', eventId: 'evt-1' }, 'allowed-once');
  assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0].method, '$events/result');
  assert.deepEqual(c.calls[0].payload, {
    clientId: 'client-1',
    eventId: 'evt-1',
    outcome: { kind: 'result', value: 'allowed-once' },
  });
});

check('answer 把回答塞进 custom', async () => {
  const c = stubClient();
  await c.answer({ clientId: 'c', eventId: 'e', questions: [{ id: 'q1' }] }, [{ id: 'q1', selected: [], custom: '选第一个' }]);
  assert.deepEqual(c.calls[0].payload.outcome, {
    kind: 'result',
    value: { answers: [{ id: 'q1', selected: [], custom: '选第一个' }] },
  });
});

check('answer 不给答案时每题填空', async () => {
  const c = stubClient();
  await c.answer({ clientId: 'c', eventId: 'e', questions: [{ id: 'q1' }, { id: 'q2' }] });
  const answers = c.calls[0].payload.outcome.value.answers;
  assert.equal(answers.length, 2);
  assert.deepEqual(answers[0], { id: 'q1', selected: [], custom: '' });
});

for (const { name, fn } of checks) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}
console.log(`\n${passed} 项通过`);
