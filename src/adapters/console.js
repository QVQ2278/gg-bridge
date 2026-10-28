/**
 * console 适配器：从 stdin 读一行，当成一条平台消息发出去。
 *
 * 它存在的意义只有一个——在没有真实平台接入时，让整条链路能跑、能测。
 * 换掉它不需要改 index.js 之外的任何东西。
 */
import readline from 'node:readline';
import { BaseAdapter } from './base.js';

export class ConsoleAdapter extends BaseAdapter {
  async connect() {
    this.connected = true;
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    this.rl.setPrompt('你 > ');
    this.rl.prompt();

    this.rl.on('line', (line) => {
      const text = line.trim();
      if (!text) {
        this.rl.prompt();
        return;
      }
      if (text === '/quit' || text === '/exit') {
        this.emit('quit');
        return;
      }
      // ctx 是“这条消息从哪来”。console 里就是当前进程，占位即可。
      this.emit('message', {
        text,
        ctx: { channel: 'console' },
      });
    });
    return this;
  }

  /** 回复打印到终端，然后重新给提示符。 */
  async send(ctx, text) {
    process.stdout.write(`\n鱼 > ${text}\n\n`);
    this.rl?.prompt();
  }

  async disconnect() {
    this.rl?.close();
    this.connected = false;
  }
}
