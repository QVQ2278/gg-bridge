# gg-bridge

把 **QQ** 接到 **DeepSeek Harness**（下称 DSH）的桥。QQ 消息进 DSH 变成一个回合，agent 的回复再发回 QQ。

- QQ 侧走 **OneBot v11 正向 WebSocket**，NapCat / Lagrange / SnowLuma 都能用，不绑某个实现。
- DSH 侧走 **Web API**：本地铸造会话 Cookie（纯 HMAC，不碰进程启动 token）、斜杠 RPC、`/api/remote.mux` 收回合事件。
- **零运行时依赖**，只要 Node ≥ 22.13。WebSocket 客户端也是自己写的（Node 自带的那个不能带 Cookie 头）。

## 状态

| 部分 | 状态 |
|---|---|
| QQ 适配器（OneBot v11） | ✅ 收发、重连、群里只接 @ / 前缀 |
| console 适配器 | ✅ 终端里测链路 |
| DSH 客户端 | ✅ Cookie 鉴权、建工作区/会话、常驻事件流、跑回合 |
| 审批 / 提问 | ✅ 转到聊天里问，回「同意」/「拒绝」或一段话 |
| 端到端 | ✅ 在本机 DSH 上实测（一句话 2~3 秒回来） |
| 流式 | ❌ 整段一次性发，不分片、不边跑边发 |

## 跑

```bash
npm test     # 16 项，纯本地：OneBot 解析 + Cookie 铸造 + 密钥读取
npm start    # 读 config.json（没有就读 config.example.json）
```

`config.json`：

```json
{
  "adapter": { "type": "onebot", "url": "ws://127.0.0.1:3001", "accessToken": "", "groupReply": "mention", "prefixes": ["gg"] },
  "dsh": { "baseUrl": "http://127.0.0.1:65296", "cookie": "", "workspacePath": "" }
}
```

| 字段 | 说明 |
|---|---|
| `adapter.type` | `onebot`（QQ）或 `console`（终端） |
| `adapter.url` | OneBot 的 WebSocket 地址，NapCat 默认 `ws://127.0.0.1:3001` |
| `adapter.groupReply` | 群里怎么才回：`mention` / `prefix` / `always` |
| `dsh.baseUrl` | `dsh web` 的地址，端口每次启动可能不同，照实际填 |
| `dsh.cookie` | 留空就自动从 `~/.dsh/.credentials.yaml` 铸造；填了就优先用 |
| `dsh.workspacePath` | 会话挂哪个目录，留空用当前目录 |

## 怎么接上的（省得你再去踩一遍）

1. **鉴权**：Cookie 名 = `dsh-auth-` + `base64url(sha256(authority))`，值 = `v1.<payload>.<hmac>`，
   用 `~/.dsh/.credentials.yaml` 里的 `client-connection/browser-session` 密钥签。纯本地计算。
2. **RPC**：`POST /api/<斜杠方法>`，信封 `{type:'client-request', rpcId, method, payload:{args:{...}}}`；
   参数多在 `args.request`，`session/list` 是 `args._request`。
3. **回合**：`/api/remote.mux` 上先 `session/follow` 拿开场快照，再发 `session/prompt`
   （`mode:'queue'` + `content:[{type:'text'}]`），收 `turn/start` → `assistant/message` → `turn/end`。
   **别叠加 `assistant/chunk`**，那会和 `assistant/message` 重复，回复文本会翻倍。
4. **事件流要带 Cookie 头**：Node 自带 WebSocket 不支持自定义头，所以 `src/dsh/ws.js` 是手写的
   RFC 6455 最小实现（握手、掩码、分片、ping）。

## 目录

```
src/index.js             入口：读配置、装适配器、把两侧接起来
src/adapters/base.js     适配器接口
src/adapters/onebot.js   QQ（OneBot v11 正向 WS）
src/adapters/console.js  终端
src/dsh/client.js        DSH 客户端：Cookie、RPC、回合
src/dsh/ws.js            最小 WebSocket 客户端（能带 Cookie 头）
scripts/test-onebot.mjs  消息解析/触发判断
scripts/test-cookie.mjs  Cookie 铸造 + 密钥读取
docs/ARCHITECTURE.md     槽位、协议、待办
```

## 情绪系统（从 astrbot_plugin_affection 搬过来的）

每个聊天一套数值，全局还有一套「对己」的：

| 字段 | 范围 | 作用 |
|---|---|---|
| 好感度 | 0~100 | 决定「对他」用哪张标签表（0/25/50/75/100 五档） |
| 他力比多 / 他攻击性 | 0~50 | 想亲近 / 想推开的强度，各五档，落在档间做双线性插值 |
| 自力比多 / 自攻击性 | 0~50 | 对自己的状态，全局一份 |

- 偏离基线后按**二次曲线**衰减，默认 2 小时回到基线（`computeDecay`）。
- 每轮由「潜意识分析」给出一组增量。现在是**规则打分**（词表 + 强度 + 轮次），
  以后可以换成让 LLM 输出 JSON——接口形状和插件一致（`libido_other_delta` 那一套）。
- 每轮把状态写成一段提示词喂给 agent，末尾一句「不要提及任何数值」。
- 发 `/情绪` 看当前档案。

状态存在 `.affect-state.json`（已在 .gitignore 里）。

数据表 `src/persona/emotion-tables.json` 是从插件的 `emotion_tables.py` 用 `ast` 直接转的，
不是手抄，避免抄错。

## 还没做的

- 长回复分片、Markdown 转纯文本。
- 多会话并发下的排队（现在同一会话串行，不同会话互不影响）。
- 审批目前只支持「同意一次 / 拒绝」，没有「永久允许这个工具」。

## License

MIT
