/**
 * 适配器接口。
 *
 * 桥的两侧是对称的：一边是聊天平台（QQ / 群 / 别的软件），一边是 DSH。
 * 平台侧千差万别，DSH 侧只需要一套；所以把差异全关在这个接口里。
 *
 * 一个适配器只需要做四件事：
 *   1. connect()     连上平台，开始收消息
 *   2. send(ctx, text) 把 DSH 的回复发回对应的会话
 *   3. disconnect()  干净地断开
 *   4. 收到消息时调用 this.emit('message', { text, ctx, reply })
 *
 * 约定：适配器不碰 DSH 的任何东西，也不知道 DSH 存在。它只管“收发文本”。
 */
import { EventEmitter } from 'node:events';

export class BaseAdapter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.connected = false;
  }

  /** 连上平台。失败就抛错，别静默重试到死。 */
  async connect() {
    throw new Error(`${this.constructor.name}.connect() 未实现`);
  }

  /**
   * 把一段文本发回平台。
   * @param {object} ctx  收到消息时随事件给出的上下文（会话 id、群号等，适配器自己定义）
   * @param {string} text 要发出去的文本（已经是纯文本，桥不保证 Markdown 可用）
   */
  async send(ctx, text) {
    throw new Error(`${this.constructor.name}.send() 未实现`);
  }

  async disconnect() {
    this.connected = false;
  }
}
