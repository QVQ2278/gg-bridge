/**
 * DSH 客户端：Cookie 鉴权 + 斜杠 RPC + 常驻 remote.mux。
 *
 * 为什么是「常驻」：审批和提问（`approval/request`、`user-questions/request`）只在
 * `$events` 那条流上出现，而且出现的**时候**回合正卡着等答复。每回合开一条流就必然
 * 错过它们，所以这里只开一条 mux，会话订阅按需加载、断线自动重连（重连后重放订阅）。
 *
 * 协议要点（来自 qq-bridge 的实测记录，见 docs/ARCHITECTURE.md）：
 *   · Cookie = 'dsh-auth-' + base64url(sha256(authority))，值 v1.<payload>.<hmac>，
 *     密钥取自 ~/.dsh/.credentials.yaml 的 client-connection/browser-session（32 字节）
 *   · POST /api/<斜杠方法>，信封 { type:'client-request', rpcId, method, payload:{args} }
 *   · 回合事件：turn/start → assistant/message（只取 text 块）→ turn/end
 *   · 审批答复：POST /api/$events/result { args:{ clientId, eventId, outcome } }
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { MiniWebSocket } from './ws.js';

const BROWSER_SESSION_KEY = 'client-connection/browser-session';
const COOKIE_PREFIX = 'dsh-auth-';
const COOKIE_PAYLOAD_VERSION = 1;
const COOKIE_LIFETIME_MS = 60 * 60 * 1000;
const SECRET_BYTES = 32;
const RECONNECT_MAX_MS = 30_000;

const base64url = (buf) => Buffer.from(buf).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

export function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 从 `.credentials.yaml` 挖出会话签名密钥；结构不符一律返回 null。 */
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
      if (first && first[1].length <= blockIndent) break;
      const secret = line.match(/^\s*secret:\s*(\S+)\s*$/);
      if (!secret) continue;
      const raw = secret[1].replaceAll('-', '+').replaceAll('_', '/');
      const bytes = Buffer.from(raw, 'base64');
      if (bytes.byteLength !== SECRET_BYTES) return null;
      return bytes;
    }
    return null;
  } catch {
    return null;
  }
}

/** 为一个具体地址铸造会话 Cookie（authority 含端口）。 */
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

export class DshClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.baseUrl = options.baseUrl ?? 'http://127.0.0.1:3080';
    this.explicitCookie = options.cookie ?? '';
    this.workspacePath = options.workspacePath ?? process.cwd();
    this.turnTimeoutMs = options.turnTimeoutMs ?? 300_000;
    this.logger = options.logger ?? console;

    this.cookie = '';
    this.workspaceId = null;
    this.sessions = new Map();      // 会话键（qq:123456）-> sessionId
    this.followed = new Set();      // 已订阅的 sessionId
    this.pendingTurns = new Map();  // sessionId -> 正在等的回合
    this.streams = new Map();       // streamId -> { kind, sessionId }

    this.ws = null;
    this.eventClientId = null;
    this.eventStreamId = null;
    this.closing = false;
    this.reconnectDelay = 1_000;
  }

  get muxUrl() {
    const url = new URL('/api/remote.mux', this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

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
      this.cookie = '';
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

  // ── 常驻事件流 ────────────────────────────────────────────

  /** 连上 remote.mux，开 `$events` 和所有已订阅会话。断线自动重连。 */
  async start() {
    this.closing = false;
    await this.openMux();
    return this;
  }

  openMux() {
    return new Promise((resolve, reject) => {
      const ws = new MiniWebSocket(this.muxUrl, { headers: { cookie: this.ensureCookie() } });
      this.ws = ws;

      let settled = false;
      ws.onOpen = () => {
        this.reconnectDelay = 1_000;
        this.openEventStream();
        for (const sessionId of this.followed) this.sendFollow(sessionId);
        if (!settled) {
          settled = true;
          resolve(this);
        }
      };
      ws.onMessage = (data) => this.onMuxFrame(data);
      ws.onClose = () => {
        this.ws = null;
        this.eventClientId = null;
        this.eventStreamId = null;
        this.streams.clear();
        if (!settled) {
          settled = true;
          reject(new Error('连不上 DSH 事件流'));
        }
        if (!this.closing) this.scheduleReconnect();
      };
      ws.onError = (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      ws.connect().catch((err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
  }

  scheduleReconnect() {
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.logger.warn?.(`[dsh] ${delay}ms 后重连事件流`);
    setTimeout(() => {
      if (!this.closing) this.openMux().catch((err) => this.logger.warn?.('[dsh] 重连失败：', err.message));
    }, delay);
  }

  openEventStream() {
    if (!this.ws) return;
    const streamId = randomUUID();
    this.eventStreamId = streamId;
    this.streams.set(streamId, { kind: 'events' });
    this.ws.send(JSON.stringify({
      type: 'open',
      streamId,
      endpoint: '$events',
      payload: { args: {} },
    }));
  }

  sendFollow(sessionId) {
    if (!this.ws) return;
    const streamId = randomUUID();
    this.streams.set(streamId, { kind: 'session', sessionId });
    this.ws.send(JSON.stringify({
      type: 'open',
      streamId,
      endpoint: 'session/follow',
      payload: {
        args: { request: { address: { kind: 'session', sessionId }, maxMessages: 1 } },
      },
    }));
  }

  follow(sessionId) {
    if (this.followed.has(sessionId)) return;
    this.followed.add(sessionId);
    this.sendFollow(sessionId);
  }

  onMuxFrame(data) {
    let frame;
    try {
      frame = JSON.parse(typeof data === 'string' ? data : data.toString());
    } catch {
      return;
    }
    const stream = this.streams.get(frame.streamId);
    if (!stream) return;

    if (frame.type === 'end' || frame.type === 'error') {
      if (stream.kind === 'events') {
        this.eventStreamId = null;
      } else if (stream.kind === 'session' && this.followed.has(stream.sessionId)) {
        // 服务端回收了这条会话流：2 秒后重新订阅，否则这个会话永久静默
        setTimeout(() => { if (!this.closing && this.followed.has(stream.sessionId)) this.sendFollow(stream.sessionId); }, 2000);
      }
      this.streams.delete(frame.streamId);
      return;
    }
    if (frame.type !== 'item') return;

    const value = frame.value;
    if (stream.kind === 'events') {
      this.onEventFrame(value);
      return;
    }
    if (value?.type === 'event') this.onSessionEvent(stream.sessionId, value.event);
  }

  /** `$events` 流：ready 给 clientId，waterfall 里是审批/提问。 */
  onEventFrame(value) {
    if (!value) return;
    if (value.type === 'ready') {
      this.eventClientId = value.clientId;
      this.emit('ready', { clientId: value.clientId });
      return;
    }
    if (value.type !== 'waterfall') return;

    if (value.event === 'approval/request') {
      this.emit('approval', {
        sessionId: value.agentId,
        clientId: this.eventClientId,
        eventId: value.eventId,
        toolName: value.request?.toolName,
        callId: value.request?.callId,
        reason: value.request?.reason,
      });
      return;
    }
    if (value.event === 'user-questions/request') {
      this.emit('question', {
        sessionId: value.agentId,
        clientId: this.eventClientId,
        eventId: value.eventId,
        questions: value.request?.questions ?? [],
      });
    }
  }

  onSessionEvent(sessionId, event) {
    if (!event) return;
    const turn = this.pendingTurns.get(sessionId);
    if (!turn) return;

    turn.touch();

    if (event.type === 'turn/start') {
      turn.turnId = event.data?.turn;
      return;
    }
    if (event.type === 'assistant/message') {
      if (turn.turnId != null && event.data?.turn !== turn.turnId) return;
      for (const block of event.data?.message?.content ?? []) {
        if (block?.type === 'text' && typeof block.text === 'string') turn.text += block.text;
      }
      return;
    }
    if (event.type === 'turn/end') {
      if (turn.turnId != null && event.data?.turn !== turn.turnId) return;
      this.pendingTurns.delete(sessionId);
      turn.resolve({ text: turn.text.trim(), reason: event.data?.reason ?? 'end' });
    }
  }

  // ── 会话与回合 ────────────────────────────────────────────

  async ensureWorkspace() {
    if (this.workspaceId) return this.workspaceId;
    const value = await this.callUnary('workspace/create', { path: this.workspacePath });
    this.workspaceId = value?.workspace?.workspaceId ?? value?.workspaceId;
    if (!this.workspaceId) throw new Error('workspace/create 没返回 workspaceId');
    return this.workspaceId;
  }

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

  /** 跑一个回合，等到 turn/end 返回最终文本。审批会挂起，直到 approve() 答复。 */
  async prompt(ctx, text) {
    if (!this.ws) await this.start();
    const key = `${ctx?.type ?? 'console'}:${ctx?.groupId ?? ctx?.userId ?? 'local'}`;
    const sessionId = await this.ensureSession(key);
    this.follow(sessionId);

    if (this.pendingTurns.has(sessionId)) throw new Error('这个会话上一回合还没结束');

    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTurns.delete(sessionId);
        reject(new Error('回合超时'));
      }, this.turnTimeoutMs);

      const turn = {
        text: '',
        turnId: null,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
        touch: () => { timer.refresh?.(); },
      };
      this.pendingTurns.set(sessionId, turn);

      this.callUnary('session/prompt', {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }).catch((err) => {
        this.pendingTurns.delete(sessionId);
        turn.reject(err);
      });
    });

    return result.text;
  }

  /** 回答挂起的审批。value: 'allowed-once' | 'rejected'。 */
  async approve({ clientId, eventId }, value) {
    return this.respondEvent(clientId, eventId, { kind: 'result', value });
  }

  /** 回答挂起的提问（每题的 selected / custom 都留空即「跳过」）。 */
  async answer({ clientId, eventId, questions }, answers) {
    return this.respondEvent(clientId, eventId, {
      kind: 'result',
      value: { answers: answers ?? (questions ?? []).map((q) => ({ id: q.id, selected: [], custom: '' })) },
    });
  }

  async respondEvent(clientId, eventId, outcome) {
    return this.callUnary('$events/result', { clientId, eventId, outcome });
  }

  async close() {
    this.closing = true;
    for (const [, turn] of this.pendingTurns) turn.reject(new Error('客户端关闭'));
    this.pendingTurns.clear();
    this.ws?.close(1000);
    this.ws = null;
  }
}
