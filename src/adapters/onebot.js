/**
 * OneBot v11 适配器 —— 接 QQ。
 *
 * 走的是 OneBot v11 的**正向 WebSocket**（NapCat / Lagrange / SnowLuma 都支持这个）：
 * 连上 `ws://127.0.0.1:3001`，服务端把消息事件推给客户端，客户端用 `send_msg` 动作发出去。
 *
 * 刻意不引第三方 SDK：OneBot v11 的协议就三种包（事件 / 动作 / 动作回执），
 * 自己写反而更好调、也少一层依赖。Node 22 自带 WebSocket，够用。
 *
 * 群里默认只在被 @ 或带前缀时才搭理，否则一个群几十号人说话，桥会被打爆。
 */
import { BaseAdapter } from './base.js';

const ACTION_TIMEOUT_MS = 15_000;

export class OneBotAdapter extends BaseAdapter {
  constructor(options = {}) {
    super(options);
    this.url = options.url ?? 'ws://127.0.0.1:3001';
    this.accessToken = options.accessToken ?? '';
    this.groupReply = options.groupReply ?? 'mention'; // mention | prefix | always
    this.prefixes = options.prefixes ?? ['gg'];
    this.selfId = Number(options.selfId ?? 0);
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.closing = false;
    this.reconnectDelay = 1_000;
  }

  /** 带上 access_token（如果有），拼成最终连接地址。 */
  get endpoint() {
    const token = this.accessToken ? `access_token=${encodeURIComponent(this.accessToken)}` : '';
    return token ? `${this.url}${this.url.includes('?') ? '&' : '?'}${token}` : this.url;
  }

  async connect() {
    this.closing = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.endpoint);

      ws.addEventListener('open', async () => {
        this.ws = ws;
        this.connected = true;
        this.reconnectDelay = 1_000;
        try {
          const info = await this.action('get_login_info', {});
          if (info && info.user_id) this.selfId = Number(info.user_id);
          this.emit('ready', { selfId: this.selfId });
        } catch {
          // 拿不到 self_id 也能跑，只是分不清自己发的消息
        }
        if (!settled) {
          settled = true;
          resolve(this);
        }
      });

      ws.addEventListener('message', (event) => this.onPacket(event.data));

      ws.addEventListener('error', () => {
        if (!settled) {
          settled = true;
          reject(new Error(`连不上 OneBot：${this.url}`));
        }
      });

      ws.addEventListener('close', () => {
        this.connected = false;
        this.ws = null;
        for (const [, inflight] of this.pending) inflight.reject(new Error('连接已断开'));
        this.pending.clear();
        if (!this.closing) this.scheduleReconnect();
      });
    });
  }

  scheduleReconnect() {
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    console.warn(`[onebot] ${delay}ms 后重连`);
    setTimeout(() => {
      if (this.closing) return;
      this.connect().catch((err) => console.warn('[onebot] 重连失败：', err.message));
    }, delay);
  }

  onPacket(raw) {
    let pkt;
    try {
      pkt = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch {
      return;
    }

    // 动作回执
    if (pkt.echo !== undefined && this.pending.has(pkt.echo)) {
      const { resolve, reject, timer } = this.pending.get(pkt.echo);
      clearTimeout(timer);
      this.pending.delete(pkt.echo);
      if (pkt.status === 'ok' || pkt.retcode === 0) resolve(pkt.data ?? {});
      else reject(new Error(`OneBot 动作失败：${pkt.wording ?? pkt.retcode ?? 'unknown'}`));
      return;
    }

    if (pkt.post_type !== 'message') return;
    if (Number(pkt.user_id) === this.selfId) return; // 自己说的话不接

    const text = extractText(pkt.message ?? pkt.raw_message ?? '');
    if (!text) return;

    const ctx = {
      type: pkt.message_type, // private | group
      userId: pkt.user_id,
      groupId: pkt.group_id,
      messageId: pkt.message_id,
      sender: pkt.sender?.card || pkt.sender?.nickname || String(pkt.user_id),
    };

    const body = this.stripTrigger(pkt, text, ctx);
    if (body === null) return; // 群里没点我，装没看见
    this.emit('message', { text: body, ctx });
  }

  /**
   * 判断这条消息该不该接，该接的话把触发词剥掉。
   * 私聊一律接；群聊看 groupReply。
   */
  stripTrigger(pkt, text, ctx) {
    if (ctx.type === 'private') return text;
    if (this.groupReply === 'always') return text;

    const selfId = String(this.selfId);
    const mentioned = Array.isArray(pkt.message)
      && pkt.message.some((seg) => seg.type === 'at' && String(seg.data?.qq) === selfId);
    if (mentioned) return text.replace(/\[CQ:at,qq=\d+\]/g, '').trim() || text;

    if (this.groupReply === 'prefix') {
      for (const prefix of this.prefixes) {
        if (text.startsWith(prefix)) return text.slice(prefix.length).trim();
      }
      return null;
    }
    return null;
  }

  /** 发一个 OneBot 动作，等回执。 */
  action(action, params) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('OneBot 还没连上'));
    }
    const echo = `gg-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot 动作超时：${action}`));
      }, ACTION_TIMEOUT_MS);
      this.pending.set(echo, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  async send(ctx, text) {
    if (ctx.type === 'group') {
      await this.action('send_msg', {
        message_type: 'group',
        group_id: ctx.groupId,
        message: [{ type: 'text', data: { text } }],
      });
    } else {
      await this.action('send_msg', {
        message_type: 'private',
        user_id: ctx.userId,
        message: [{ type: 'text', data: { text } }],
      });
    }
  }

  async disconnect() {
    this.closing = true;
    this.ws?.close();
    super.disconnect();
  }
}

/** 把 OneBot 消息段拼成纯文本。图片、表情先占个位，别让它们把内容吞掉。 */
export function extractText(message) {
  if (typeof message === 'string') {
    return message.replace(/\[CQ:[^\]]*\]/g, '').trim();
  }
  if (!Array.isArray(message)) return '';
  const parts = [];
  for (const seg of message) {
    if (seg.type === 'text') parts.push(seg.data?.text ?? '');
    else if (seg.type === 'at') continue;
    else if (seg.type === 'image') parts.push('[图片]');
    else if (seg.type === 'face') parts.push('[表情]');
    else if (seg.type === 'record') parts.push('[语音]');
    else if (seg.type === 'reply') continue;
  }
  return parts.join('').trim();
}
