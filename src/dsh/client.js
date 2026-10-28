/**
 * DSH 客户端——**还没写**。
 *
 * 为什么不在这个骨架里硬凑一个：DSH 的协议有三处坑，自己猜会写出一个
 * “跑起来像对、实际每个回合都 401”的东西：
 *
 *   1. 鉴权是 Cookie。Cookie 不是 OAuth，也不是 Bearer。它由 ~/.dsh 里持久化的
 *      `client-connection/browser-session` 密钥（32 字节）做 HMAC 离线铸造：
 *        cookie = 'dsh-auth-' + base64url(sha256(authority))
 *        payload.authority === authority（Host 头，例如 127.0.0.1:3080）
 *      进程启动 token 只存在内存里，DSH 0.1.7 起不再落盘，所以“读日志拿 token”已死。
 *
 *   2. RPC 方法名是斜杠：`session/list`、`session/create`、`session/prompt`……，
 *      参数包在 `{ args: { ... } }` 里，`session/prompt` 还强制要 requestId。
 *
 *   3. 事件流是 WebSocket / 长连接上的 `/api/remote.mux`，按 `session/follow` 开流，
 *      提问与审批走同一条流上的 `$events` / `$events/result`。
 *
 * 这三件事 qq-bridge 已经踩平了：
 *   qq-bridge/src/dsh-client.js   鉴权 + 铸造 Cookie + 连接
 *   qq-bridge/src/bridge.js       会话生命周期、回合、审批（677KB，别整份抄）
 *   qq-bridge/docs/*.md           协议与适配记录（DSH_020/021_ADAPTATION）
 *
 * 移植时只抄 dsh-client.js 的鉴权与 RPC 通道，不要抄 bridge.js 里 QQ 相关的业务。
 */
export class DshClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl ?? 'http://127.0.0.1:3080';
    this.cookie = options.cookie ?? '';
    this.sessionId = options.sessionId ?? '';
    this.ready = false;
  }

  /**
   * 连上 DSH 并准备好会话。可选：懒连接也行。
   * TODO(移植)：铸造 Cookie → 验证 /api/... 能过 401 → session/list 拿会话。
   */
  async connect() {
    this.ready = true;
    return this;
  }

  /**
   * 把一条平台消息变成一个 DSH 回合，等它跑完，返回最后的回复文本。
   *
   * @param {object} ctx         平台上下文（会话 id 等）
   * @param {string} text        用户说的话
   * @returns {Promise<string>}  agent 的回复
   */
  async prompt(ctx, text) {
    if (!this.cookie) {
      return '（DSH 还没接上：config.json 里的 dsh.cookie 是空的，先按 docs/ARCHITECTURE.md 把客户端补完。）';
    }
    // TODO(移植)：session/prompt + 监听 remote.mux，把流式片段拼成最终文本。
    throw new Error('DshClient.prompt() 未实现——见 src/dsh/client.js 顶部注释');
  }

  async close() {
    this.ready = false;
  }
}
