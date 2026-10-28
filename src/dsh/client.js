/**
 * DSH 客户端：走 DSH Web API，把「一句话」变成一个回合，返回 agent 的回复文本。
 *
 * 协议要点（照 qq-bridge 的实测记录，不是猜的）：
 *
 *  1. **鉴权是 Cookie**。Cookie 名 = `dsh-auth-` + base64url(sha256(authority))，
 *     值是 `v1.<payload>.<hmac>`，payload 里绑定 authority 与起止时间，用
 *     `~/.dsh/.credentials.yaml` 里持久化的 `client-connection/browser-session` 密钥
 *     （32 字节）做 HMAC-SHA256。这是纯本地计算，不需要进程启动 token。
 *
 *  2. **RPC 是 POST /api/<斜杠方法>**，信封是
 *     `{ type:'client-request', rpcId, method, payload:{ args:{...} } }`，
 *     回包是 `{ type:'server-response', rpcId, result:{ ok, value|error } }`。
 *     多数方法把参数包在 `args.request` 里，`session/list` 例外，用 `args._request`。
 *
 *  3. **事件流在 `/api/remote.mux`**（WebSocket）。先发
 *     `{type:'open', streamId, endpoint:'session/follow', payload:{args:{request:{address:{kind:'session',sessionId}}}}}`
 *     拿到开场快照，之后 `value.type === 'event'` 的帧就是回合事件：
 *     `turn/start` → `assistant/message`（完整文本，别叠加 `assistant/chunk`）→ `turn/end`。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { MiniWebSocket } from './ws.js';

const BROWSER_SESSION_KEY = 'client-connection/browser-session';
const COOKIE_PREFIX = 'dsh-auth-';
const COOKIE_PAYLOAD_VERSION = 1;
const COOKIE_LIFETIME_MS = 60 * 60 * 1000;
const SECRET_BYTES = 32;

const base64url = (buf) => Buffer.from(buf).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

export function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/**
 * 从 `.credentials.yaml` 里挖出浏览器会话签名密钥。
 *
 * 只认那一条记录的 `secret:` 行——为这点东西引一个 YAML 依赖不值当，
 * 但解析失败必须**返回 null**（而不是抛），让调用方回退到显式 cookie。
 */
export function readBrowserSessionSecret() {
  try {
    const file = path.join(resolveDshHome(), '.credentials.yaml');
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    let inBlock = false;
    let blockIndent = 0;
    for (const line of lines) {
      const header = line.match(/^(\s*)client-connection\/browser-session:\s*$/);
      if (header) {
        inBlock = true;
        blockIndent = header[1].length;
        continue;
      }
      if (!inBlock) continue;
      const first = line.match(/^(\s*)\S/);
      if (first && first[1].length <= blockIndent) break; // 出块了
      const secret = line.match(/^\s*secret:\s*(\S+)\s*$/);
      if (!secret) continue;
      const raw = secret[1].replaceAll('-', '+').replaceAll('_', '/');
      const bytes = Buffer.from(raw, 'base64');
      if (bytes.byteLength !== SECRET_BYTES) return null; // 密钥方案变了，别发坏 Cookie
      return bytes;
    }
    return null;
  } catch {
    return null;
  }
}

/** 为一个具体地址铸造会话 Cookie。 */
export function mintBrowserSessionCookie(baseUrl, secret, { lifetimeMs = COOKIE_LIFETIME_MS } = {}) {
  const authority = new URL(String(baseUrl)).host;
  if (!authority) throw new Error('DSH baseUrl 里没有 authority');
  const issuedAt = Date.now();
  const payload = base64url(Buffer.from(JSON.stringify({
    version: COOKIE_PAYLOAD_VERSION,
    authority,
    issuedAt,
    expiresAt: issuedAt + lifetimeMs,
  }), 'utf8'));
  const signature = base64url(createHmac('sha256', secret).update(payload).digest());
  const name = COOKIE_PREFIX + base64url(createHash('sha256').update(authority).digest());
  return `${name}=v1.${payload}.${signature}`;
}

/** 参数包装表：新协议把原 payload 塞进 `args.request`（session/list 是 `_request`）。 */
const ARG_KEY = {
  'session/list': '_request',
  'session/create': 'request',
  'session/prompt': 'request',
  'session/cancel': 'request',
  'session/projections': 'request',
  'session/follow': 'request',
  'workspace/create': 'request',
  'workspace/rename': 'request',
  'workspace/archiveSession': 'request',
};

function wrapArgs(endpoint, payload) {
  let body = payload ?? {};
  if (endpoint === 'session/prompt' && typeof body.requestId !== 'string') {
    body = { ...body, requestId: randomUUID() };
  }
  const key = ARG_KEY[endpoint];
  if (key === undefined) return { args: body };
  return { args: { [key]: body } };
}

export class DshClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl ?? 'http://127.0.0.1:3080';
    this.explicitCookie = options.cookie ?? '';
    this.workspacePath = options.workspacePath ?? process.cwd();
    this.turnTimeoutMs = options.turnTimeoutMs ?? 180_000;
    this.logger = options.logger ?? console;

    this.cookie = '';
    this.workspaceId = null;
    this.sessions = new Map(); // 会话键 -> sessionId
  }

  get muxUrl() {
    const url = new URL('/api/remote.mux', this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

  /** 拿一个能用的 Cookie：先看显式配置，再尝试本地铸造。 */
  ensureCookie() {
    if (this.cookie) return this.cookie;
    if (this.explicitCookie) {
      this.cookie = this.explicitCookie;
      return this.cookie;
    }
    const secret = readBrowserSessionSecret();
    if (!secret) {
      throw new Error(
        '拿不到 DSH 会话 Cookie：既没有配置 dsh.cookie，也读不到 '
        + `~/.dsh/.credentials.yaml 里的 ${BROWSER_SESSION_KEY} 密钥`,
      );
    }
    this.cookie = mintBrowserSessionCookie(this.baseUrl, secret);
    return this.cookie;
  }

  /** 发一个一元 RPC。 */
  async callUnary(method, payload = {}, { timeoutMs = 30_000 } = {}) {
    const endpoint = method.replaceAll('.', '/');
    const envelope = {
      type: 'client-request',
      rpcId: randomUUID(),
      method: endpoint,
      payload: wrapArgs(endpoint, payload),
    };
    const res = await fetch(new URL(`/api/${endpoint}`, this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: this.ensureCookie() },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) {
      this.cookie = ''; // Cookie 过期/被 DSH 重启作废，下次调用重新铸造
      throw new Error(`${endpoint}: HTTP 401（Cookie 失效）`);
    }
    if (!res.ok) throw new Error(`${endpoint}: HTTP ${res.status}`);
    const full = await res.json();
    if (full?.type !== 'server-response' || full?.rpcId !== envelope.rpcId || !full.result) {
      throw new Error(`${endpoint}: 回包形状不对`);
    }
    if (!full.result.ok) {
      const { code, message } = full.result.error ?? {};
      throw new Error(`${endpoint} 失败: ${code ?? 'unknown'}: ${message ?? ''}`);
    }
    return full.result.value;
  }

  /** 建（或复用）一个工作区，会话都挂在它下面。 */
  async ensureWorkspace() {
    if (this.workspaceId) return this.workspaceId;
    const value = await this.callUnary('workspace/create', { path: this.workspacePath });
    this.workspaceId = value?.workspace?.workspaceId ?? value?.workspaceId;
    if (!this.workspaceId) throw new Error('workspace/create 没返回 workspaceId');
    return this.workspaceId;
  }

  /** 一个聊天会话对应一个 DSH 会话，按 ctx 缓存。 */
  async ensureSession(key) {
    const cached = this.sessions.get(key);
    if (cached) return cached;
    const workspaceId = await this.ensureWorkspace();
    const value = await this.callUnary('session/create', { workspaceId });
    const sessionId = value?.sessionId;
    if (!sessionId) throw new Error('session/create 没返回 sessionId');
    this.sessions.set(key, sessionId);
    return sessionId;
  }

  /**
   * 跑一个回合：开 mux → 订阅该会话 → 发 prompt → 收事件收到 turn/end。
   * @returns {Promise<{text: string, reason: string}>}
   */
  async runTurn(sessionId, text) {
    const ws = new MiniWebSocket(this.muxUrl, { headers: { cookie: this.ensureCookie() } });
    const streamId = randomUUID();

    await ws.connect();

    return new Promise((resolve, reject) => {
      let snapshotSeen = false;
      let prompted = false;
      let finished = false;
      let turnText = '';
      let currentTurn = null;

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('回合超时'));
      }, this.turnTimeoutMs);

      const cleanup = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try { ws.close(1000); } catch { /* 已经关了 */ }
      };

      const sendPrompt = () => {
        if (prompted) return;
        prompted = true;
        this.callUnary('session/prompt', {
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        }).catch((err) => {
          cleanup();
          reject(err);
        });
      };

      ws.onMessage = (data) => {
        let frame;
        try {
          frame = JSON.parse(typeof data === 'string' ? data : data.toString());
        } catch {
          return;
        }
        if (frame.streamId !== streamId) return;

        if (frame.type === 'error') {
          cleanup();
          reject(new Error(`事件流报错：${frame.error?.code ?? 'unknown'}`));
          return;
        }
        if (frame.type === 'end') {
          cleanup();
          if (turnText) resolve({ text: turnText, reason: 'stream-end' });
          else reject(new Error('事件流结束但没收到回复'));
          return;
        }
        if (frame.type !== 'item') return;

        const value = frame.value;
        if (value?.type === 'snapshot') {
          // 开场快照里可能有历史回合的 turn/end，绝不能当成新回合
          if (!snapshotSeen) {
            snapshotSeen = true;
            sendPrompt();
          }
          return;
        }
        if (value?.type !== 'event') return;

        const event = value.event;
        if (event?.type === 'turn/start') {
          if (!prompted) sendPrompt(); // 兜底：没等到快照就先跑起来了
          currentTurn = event.data?.turn;
          return;
        }
        if (event?.type === 'assistant/message') {
          if (currentTurn !== null && event.data?.turn !== currentTurn) return;
          for (const block of event.data?.message?.content ?? []) {
            if (block?.type === 'text' && typeof block.text === 'string') turnText += block.text;
          }
          return;
        }
        if (event?.type === 'turn/end') {
          if (currentTurn !== null && event.data?.turn !== currentTurn) return;
          cleanup();
          resolve({ text: turnText.trim(), reason: event.data?.reason ?? 'end' });
        }
      };

      ws.onClose = () => {
        if (finished) return;
        clearTimeout(timer);
        if (turnText) resolve({ text: turnText.trim(), reason: 'closed' });
        else reject(new Error('事件流提前关闭'));
      };

      ws.onError = (err) => {
        cleanup();
        reject(err);
      };

      ws.send(JSON.stringify({
        type: 'open',
        streamId,
        endpoint: 'session/follow',
        payload: {
          args: {
            request: {
              address: { kind: 'session', sessionId },
              maxMessages: 1,
            },
          },
        },
      }));

      // 万一 DSH 不发快照，别把回合卡死
      setTimeout(() => { if (!finished) sendPrompt(); }, 3_000);
    });
  }

  /** 桥接对外只有这一个方法：一句话进，一段话出。 */
  async prompt(ctx, text) {
    const key = `${ctx?.type ?? 'console'}:${ctx?.groupId ?? ctx?.userId ?? 'local'}`;
    const sessionId = await this.ensureSession(key);
    const result = await this.runTurn(sessionId, text);
    return result.text;
  }

  async close() {
    this.sessions.clear();
  }
}
