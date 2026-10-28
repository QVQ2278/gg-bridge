/**
 * 入口：读配置 → 装一个适配器 → 把两侧接起来。
 *
 * 这一层故意写得很薄。真正的东西在 src/adapters/ 和 src/dsh/ 里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConsoleAdapter } from './adapters/console.js';
import { OneBotAdapter } from './adapters/onebot.js';
import { DshClient } from './dsh/client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** 有 config.json 用它，没有就用 config.example.json，方便先跑起来。 */
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
  // 再接新平台时在这里登记：telegram: TelegramAdapter, ...
};

function createAdapter(type, options) {
  const Ctor = ADAPTERS[type];
  if (!Ctor) {
    throw new Error(`未知的适配器 "${type}"，可选：${Object.keys(ADAPTERS).join(', ')}`);
  }
  return new Ctor(options);
}

async function main() {
  const { file, data } = loadConfig();
  console.log(`[gg-bridge] 配置：${path.relative(ROOT, file)}`);

  const dsh = new DshClient(data.dsh ?? {});
  const adapter = createAdapter(data.adapter?.type ?? 'console', data.adapter ?? {});

  // 平台消息 → DSH 回合 → 回复发回去。
  // 一个事件处理不完不影响下一句，所以逐个 await，但出错只记日志。
  adapter.on('message', async ({ text, ctx }) => {
    try {
      const reply = await dsh.prompt(ctx, text);
      if (reply) await adapter.send(ctx, reply);
    } catch (err) {
      console.error('[gg-bridge] 回合失败：', err instanceof Error ? err.message : err);
      try {
        await adapter.send(ctx, '这条没跑通，等下再试。');
      } catch {
        // 平台也发不出去就算了，别把进程弄崩
      }
    }
  });

  adapter.on('quit', async () => {
    console.log('\n[gg-bridge] 收工。');
    await adapter.disconnect();
    process.exit(0);
  });

  await adapter.connect();
  console.log('[gg-bridge] 已连上，开始收发。');
}

main().catch((err) => {
  console.error('[gg-bridge] 启动失败：', err);
  process.exit(1);
});
