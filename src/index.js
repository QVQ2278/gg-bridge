/**
 * 入口：读配置 → 装一个适配器 → 把两侧接起来。
 *
 * 这一层做的事情就三件：
 *   1. 把平台消息喂给 DSH，把回复发回去
 *   2. DSH 要审批/提问时，把它翻成人话发到聊里
 *   3. 下一条消息如果是在回答审批，就答复 DSH，而不是开新回合
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConsoleAdapter } from './adapters/console.js';
import { OneBotAdapter } from './adapters/onebot.js';
import { DshClient } from './dsh/client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const APPROVE_WORDS = new Set(['同意', '可以', '行', '准', '过', 'y', 'yes', 'ok', 'okay', 'allow']);
const REJECT_WORDS = new Set(['拒绝', '不行', '不', '别', 'no', 'n', 'reject', 'deny']);

function loadConfig() {
  const real = path.join(ROOT, 'config.json');
  const example = path.join(ROOT, 'config.example.json');
  const file = fs.existsSync(real) ? real : example;
  if (!fs.existsSync(file)) throw new Error('找不到 config.json，也没有 config.example.json');
  return { file, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

const ADAPTERS = {
  console: ConsoleAdapter,
  onebot: OneBotAdapter, // QQ，走 OneBot v11 正向 WebSocket
};

function createAdapter(type, options) {
  const Ctor = ADAPTERS[type];
  if (!Ctor) throw new Error(`未知的适配器 "${type}"，可选：${Object.keys(ADAPTERS).join(', ')}`);
  return new Ctor(options);
}

const keyOf = (ctx) => `${ctx?.type ?? 'console'}:${ctx?.groupId ?? ctx?.userId ?? 'local'}`;

async function main() {
  const { file, data } = loadConfig();
  console.log(`[gg-bridge] 配置：${path.relative(ROOT, file)}`);

  const dsh = new DshClient({
    ...(data.dsh ?? {}),
    workspacePath: data.dsh?.workspacePath || process.cwd(),
  });
  const adapter = createAdapter(data.adapter?.type ?? 'console', data.adapter ?? {});
  console.log(`[gg-bridge] DSH：${dsh.baseUrl}`);

  const ctxByKey = new Map();      // 会话键 -> 最近一次的 ctx（用来把审批/提问发回去）
  const pending = new Map();       // 会话键 -> { kind:'approval'|'question', info }

  /** 从 sessionId 反查是哪个聊天，审批事件只带 sessionId。 */
  const keyOfSession = (sessionId) => {
    for (const [key, sid] of dsh.sessions) if (sid === sessionId) return key;
    return null;
  };

  dsh.on('approval', async (req) => {
    const key = keyOfSession(req.sessionId);
    const ctx = key && ctxByKey.get(key);
    if (!ctx) {
      // 不知道发给谁就先拒掉，别让回合一直挂着
      dsh.approve(req, 'rejected').catch(() => {});
      return;
    }
    pending.set(key, { kind: 'approval', info: req });
    const why = req.reason ? `：${req.reason}` : '';
    await adapter.send(ctx, `【要审批】${req.toolName ?? '未知工具'}${why}\n回「同意」或「拒绝」`);
  });

  dsh.on('question', async (req) => {
    const key = keyOfSession(req.sessionId);
    const ctx = key && ctxByKey.get(key);
    if (!ctx) {
      dsh.answer(req, (req.questions ?? []).map((q) => ({ id: q.id, selected: [], custom: '' }))).catch(() => {});
      return;
    }
    pending.set(key, { kind: 'question', info: req });
    const lines = (req.questions ?? []).map((q, i) => `${i + 1}. ${q.prompt ?? q.title ?? q.id}`);
    await adapter.send(ctx, `【要你拍板】\n${lines.join('\n')}\n直接回一段话就行`);
  });

  const inflight = new Set();

  adapter.on('message', ({ text, ctx }) => {
    const task = handleMessage(text, ctx).finally(() => inflight.delete(task));
    inflight.add(task);
  });

  async function handleMessage(text, ctx) {
    const key = keyOf(ctx);
    ctxByKey.set(key, ctx);

    // 这条是在回答审批/提问
    const waiting = pending.get(key);
    if (waiting) {
      pending.delete(key);
      try {
        if (waiting.kind === 'approval') {
          const word = text.trim().toLowerCase();
          const value = APPROVE_WORDS.has(word) ? 'allowed-once' : 'rejected';
          await dsh.approve(waiting.info, value);
          await adapter.send(ctx, value === 'allowed-once' ? '过了。' : '拒了。');
        } else {
          const answers = (waiting.info.questions ?? []).map((q, i) => ({
            id: q.id,
            selected: [],
            custom: i === 0 ? text : '',
          }));
          await dsh.answer(waiting.info, answers);
          await adapter.send(ctx, '收到，接着跑。');
        }
      } catch (err) {
        await adapter.send(ctx, `答复没送进去：${err.message}`);
      }
      return;
    }

    try {
      const reply = await dsh.prompt(ctx, text);
      if (reply) await adapter.send(ctx, reply);
      else await adapter.send(ctx, '（这回合没说话）');
    } catch (err) {
      console.error('[gg-bridge] 回合失败：', err instanceof Error ? err.message : err);
      try { await adapter.send(ctx, '这条没跑通，等下再试。'); } catch { /* 平台也发不出去就算了 */ }
    }
  }

  adapter.on('quit', async () => {
    // 还有回合在跑就先等它说完，别把回复掐了
    if (inflight.size) await Promise.allSettled([...inflight]);
    console.log('\n[gg-bridge] 收工。');
    await dsh.close();
    await adapter.disconnect();
    process.exit(0);
  });

  await dsh.start();
  await adapter.connect();
  console.log('[gg-bridge] 已连上，开始收发。');
}

main().catch((err) => {
  console.error('[gg-bridge] 启动失败：', err);
  process.exit(1);
});
