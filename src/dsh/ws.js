/**
 * 极简 WebSocket 客户端（RFC 6455），只做桥接需要的那点事：
 * 带 Cookie 头握手、发文本帧、收文本帧、处理分片和 ping。
 *
 * 为什么不用现成的：Node 自带的 WebSocket 是 undici 实现，**不接受自定义请求头**，
 * 而 DSH 的 `/api/remote.mux` 只认 Cookie 鉴权。装 `ws` 又要多一个依赖，
 * 所以这里自己拿 net/tls 撸一个——协议本身不复杂，代码比依赖树更好审。
 */
import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export class MiniWebSocket {
  /**
   * @param {string} url  ws:// 或 wss:// 地址
   * @param {object} options
   * @param {Record<string,string>} options.headers 握手时附加的头（Cookie 放这里）
   */
  constructor(url, options = {}) {
    this.url = new URL(url);
    this.headers = options.headers ?? {};
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.open = false;
    this.closed = false;
    this.onOpen = null;
    this.onMessage = null;
    this.onClose = null;
    this.onError = null;
  }

  connect() {
    const isSecure = this.url.protocol === 'wss:';
    const port = Number(this.url.port || (isSecure ? 443 : 80));
    const host = this.url.hostname;

    const socket = isSecure
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });
    this.socket = socket;

    socket.on(isSecure ? 'secureConnect' : 'connect', () => this.handshake());
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (err) => this.fail(err));
    socket.on('close', () => this.finish(1006, 'socket closed'));

    return new Promise((resolve, reject) => {
      this.onOpen = resolve;
      this.onError = reject;
    });
  }

  handshake() {
    const key = randomBytes(16).toString('base64');
    const lines = [
      `GET ${this.url.pathname}${this.url.search} HTTP/1.1`,
      `Host: ${this.url.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
    ];
    for (const [name, value] of Object.entries(this.headers)) lines.push(`${name}: ${value}`);
    this.socket.write(lines.join('\r\n') + '\r\n\r\n');
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    // 第一包是 HTTP 响应头
    if (!this.open) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      const head = this.buffer.subarray(0, end).toString('latin1');
      this.buffer = this.buffer.subarray(end + 4);
      const status = Number(head.split(' ')[1]);
      if (status !== 101) {
        this.fail(new Error(`WebSocket 握手失败：HTTP ${status}`));
        return;
      }
      this.open = true;
      this.onOpen?.();
      this.onOpen = null;
    }

    // 之后是帧
    while (this.parseFrame()) { /* 一帧一帧啃 */ }
  }

  parseFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return false;

    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buf.length < offset + 2) return false;
      length = buf.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buf.length < offset + 8) return false;
      length = Number(buf.readBigUInt64BE(offset));
      offset += 8;
    }

    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return false;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + length) return false;

    let payload = buf.subarray(offset, offset + length);
    if (maskKey) payload = unmask(payload, maskKey);
    this.buffer = buf.subarray(offset + length);

    if (opcode === OP_PING) {
      this.sendFrame(OP_PONG, payload);
      return true;
    }
    if (opcode === OP_PONG) return true;
    if (opcode === OP_CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      this.finish(code, payload.subarray(2).toString('utf8'));
      return false;
    }
    if (opcode === OP_CONT) {
      this.fragments.push(payload);
    } else {
      this.fragments = [payload];
      this.fragmentOpcode = opcode;
    }
    if (fin) {
      const whole = Buffer.concat(this.fragments);
      this.fragments = [];
      if (this.fragmentOpcode === OP_TEXT) this.onMessage?.(whole.toString('utf8'));
      else if (this.fragmentOpcode === OP_BINARY) this.onMessage?.(whole);
    }
    return true;
  }

  send(text) {
    this.sendFrame(OP_TEXT, Buffer.from(text, 'utf8'));
  }

  sendFrame(opcode, payload) {
    if (!this.socket || this.closed) return;
    const mask = randomBytes(4);
    const len = payload.length;

    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN + opcode

    this.socket.write(Buffer.concat([header, mask, mask ? maskPayload(payload, mask) : payload]));
  }

  close(code = 1000) {
    if (this.closed) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this.sendFrame(OP_CLOSE, payload);
    this.finish(code, 'client close');
  }

  finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    try { this.socket?.destroy(); } catch { /* 已经没了 */ }
    this.onClose?.({ code, reason });
  }

  fail(err) {
    this.onError?.(err);
    this.finish(1006, err?.message ?? 'error');
  }
}

function maskPayload(payload, mask) {
  const out = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i += 1) out[i] = payload[i] ^ mask[i & 3];
  return out;
}

const unmask = maskPayload;
