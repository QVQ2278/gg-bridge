# 架构与移植清单

## 两条边

```
  聊天平台  <--适配器-->  gg-bridge  <--DSH 客户端-->  DeepSeek Harness
 (QQ/群/…)   base.js                     dsh/client.js
```

适配器只认「文本 + 上下文」，DSH 客户端只认「一个回合进、一段回复出」。
中间这一层不存业务状态，状态都在两端各自的进程里。

## 槽位

| 槽位 | 现状 | 要做什么 |
|---|---|---|
| `src/adapters/base.js` | 接口已定 | 不用改 |
| `src/adapters/console.js` | 可跑 | 拿它验证链路 |
| `src/adapters/<平台>.js` | 缺 | 实现 connect / send，收到消息 emit('message') |
| `src/dsh/client.js` | 只有签名 | 移植鉴权 + RPC + 事件流 |

## DSH 侧要点（照 qq-bridge 抄，别自己发明）

1. **Cookie 鉴权**。`dsh-auth-` 前缀 + `base64url(sha256(authority))`，payload 里
   `authority` 必须等于请求的 Host 头；用 `~/.dsh` 的 `client-connection/browser-session`
   密钥做 HMAC 签名。签名密钥不可用时才回退到进程启动 token。
2. **斜杠 RPC**，参数包在 `{ args: {...} }`。`session/prompt` 必带 `requestId`。
3. **`/api/remote.mux`**：先 `session/follow` 开流，再发 `session/prompt`；
   文本增量、工具调用、**提问与审批**都从这条流里出。
4. **审批**：DSH 的审批请求走 mux 上的 `$events`，要用 `$events/result` 回。桥如果不应答，
   回合会永远卡住——这是最容易踩的坑。
5. **会话退役**：换会话前要清掉 DSH 侧未执行的队列，读队列以 `session/projections`
   为主路径。qq-bridge 在这里踩过 P0（读了一个不存在的字段，导致每次退役都抛错）。

## 平台侧要点

- 一条消息 = 一个回合，别把多条合并；合并会让 DSH 的审批和中断语义都乱掉。
- 回复要转成纯文本（平台不支持 Markdown 时）；qq-bridge 的 `src/md-to-plain.js` 可以抄。
- 长回复要分片，但别把代码块劈开。
- 断线重连要做，但重连后不要把没发出去的消息重放一遍（会重复触发回合）。

## 移植顺序

1. 先让 console 适配器 + 假 DSH（返回固定字符串）跑通 → 验证事件循环。
2. 接真 DSH，只做 `session/list` + `session/create`，确认 Cookie 能过。
3. 做 `session/prompt` + mux 拼接文本。
4. 最后做审批与中断。
5. 再写平台适配器——它是唯一跟平台强相关、必须最后做的部分。
