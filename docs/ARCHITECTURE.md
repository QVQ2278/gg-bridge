# 架构与协议备忘

## 两条边

```
  聊天平台  <--适配器-->  gg-bridge  <--DSH 客户端-->  DeepSeek Harness
 (QQ/OneBot)  base.js                   dsh/client.js
```

适配器只认「文本 + 上下文」，DSH 客户端只认「一句话进、一段话出」。
中间不存业务状态：会话 id 在客户端里按 ctx 缓存，消息本身不落盘。

## 槽位

| 槽位 | 现状 |
|---|---|
| `src/adapters/base.js` | 接口（connect / send / emit('message')） |
| `src/adapters/onebot.js` | ✅ QQ，OneBot v11 正向 WebSocket |
| `src/adapters/console.js` | ✅ 终端 |
| `src/dsh/client.js` | ✅ Cookie 铸造、单元 RPC、回合 |
| `src/dsh/ws.js` | ✅ 手写 WebSocket（带 Cookie 头） |
| `scripts/test-*.mjs` | ✅ 16 项本地测试 |

## DSH 侧：实测出来的协议

### 1. Cookie 鉴权

```
name  = 'dsh-auth-' + base64url(sha256(authority))
value = 'v1.' + base64url({version:1, authority, issuedAt, expiresAt}) + '.' + base64url(hmac_sha256(secret, payload))
```

- `authority` = `Host` 头，例如 `127.0.0.1:65296`（**端口也算**，换端口要重新铸造）
- `secret` = `~/.dsh/.credentials.yaml` → `records['client-connection/browser-session'].payload.secret`，
  32 字节，base64url
- 有效期别超过 30 天（默认上限）；这里给 1 小时，401 时自动重铸

进程启动 token（`?token=`）是另一条路，但它只在内存里、只在启动器把 stdout 记到日志时才找得到，
所以不作为主路径。

### 2. 单元 RPC

```
POST /api/session/prompt
cookie: <上面那串>

{ "type": "client-request", "rpcId": "<uuid>", "method": "session/prompt",
  "payload": { "args": { "request": { ... } } } }
```

回包 `{type:'server-response', rpcId, result:{ok:true, value}}`，失败是 `result.error.{code,message}`。

参数位置：多数 `args.request`，`session/list` 是 `args._request`，`agentPresets/list`、`settings/describe`
直接 `args:{}`。`session/prompt` 必须带 `requestId`。

### 3. 事件流 `/api/remote.mux`

WebSocket，握手要带 `Cookie` 头。开流：

```json
{ "type": "open", "streamId": "<uuid>", "endpoint": "session/follow",
  "payload": { "args": { "request": { "address": { "kind": "session", "sessionId": "..." }, "maxMessages": 1 } } } }
```

下行帧：

| 帧 | 含义 |
|---|---|
| `{type:'item', value:{type:'snapshot'}}` | 开场快照（含历史，**别把里面的旧 turn/end 当新回合**） |
| `{type:'item', value:{type:'event', event}}` | 回合事件：`turn/start` / `assistant/message` / `turn/end` |
| `{type:'end'}` / `{type:'error'}` | 流结束 |

`sandbox`：`assistant/message` 里 `data.message.content` 是内容块数组，只取 `type==='text'`。
**不要**再把 `assistant/chunk` 拼进来——两个都拼会让文本翻倍。

### 4. 会话生命周期

```
workspace/create {path}            -> value.workspace.workspaceId
session/create   {workspaceId}     -> value.sessionId
session/prompt   {sessionId, mode:'queue', content:[{type:'text',text}]}
workspace/archiveSession {sessionId}
```

## 审批与提问（已接）

`$events` 流和会话流开在同一条 mux 上：

- `value.type==='ready'` → 记下 `clientId`（答复时要带）
- `value.type==='waterfall'` 且 `value.event==='approval/request'` → 审批
- `value.type==='waterfall'` 且 `value.event==='user-questions/request'` → 提问

答复走一元 RPC：

```
POST /api/$events/result
{ "args": { "clientId": "...", "eventId": "...", "outcome": { "kind": "result", "value": "allowed-once" } } }
```

`outcome.value` 的形态：

| 场景 | value |
|---|---|
| 同意一次 | `"allowed-once"` |
| 拒绝 | `"rejected"` |
| 回答问题 | `{ "answers": [{ "id": "q1", "selected": [], "custom": "第一题的回答" }] }` |

桥接这一层把它翻成聊天里的一句话（「【要审批】shell：要跑命令，回同意或拒绝」），
下一条消息如果在等答复，就当作答复处理，而不是开新回合。

注意：**流必须常驻**。审批事件出现的时刻，回合正卡着等答复；每回合开一条新流必然错过。

## 队列与退役（还没做）

换会话/重置前要清掉 DSH 侧还没跑的队列项（`session/projections` 的 `inbox` 投影 →
`session/updateQueue` `{action:{kind:'remove'}}`），否则旧任务会继续烧 token。
qq-bridge 在这里踩过 P0，`reference` 里那份代码的注释写得很清楚。

## 平台侧要点

- 一条消息 = 一个回合，别合并。
- 回复转纯文本；长回复分片但别劈开代码块。
- 断线重连后不要重放已发消息（会重复触发回合）。
