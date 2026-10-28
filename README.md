# gg-bridge

把 **QQ** 接到 **DeepSeek Harness**（下称 DSH）的桥。QQ 消息进 DSH 变成一个回合，agent 的回复再发回 QQ。

QQ 这一侧走 **OneBot v11 正向 WebSocket**，NapCat / Lagrange / SnowLuma 都能用，不绑某一个实现。
DSH 这一侧还没填（见下）。

## 现在能跑到哪一步

| 部分 | 状态 |
|---|---|
| QQ 适配器（OneBot v11） | ✅ 连、收、发、重连、群里只接 @ / 前缀 |
| console 适配器 | ✅ 终端里测链路用 |
| DSH 客户端 | ❌ 只有签名，`src/dsh/client.js` 顶部写了要抄什么 |

拿 console 就能把整条链路跑起来：

```bash
npm start          # 读 config.json，没有就读 config.example.json
npm test           # OneBot 解析/触发逻辑的纯函数测试
```

## 配置

`config.example.json` → 复制成 `config.json` 再改：

```json
{
  "adapter": {
    "type": "onebot",
    "url": "ws://127.0.0.1:3001",
    "accessToken": "",
    "groupReply": "mention",
    "prefixes": ["gg"]
  },
  "dsh": { "baseUrl": "http://127.0.0.1:3080", "cookie": "", "sessionId": "" }
}
```

| 字段 | 说明 |
|---|---|
| `url` | OneBot 的 WebSocket 地址。NapCat 默认 `ws://127.0.0.1:3001` |
| `accessToken` | OneBot 端配了 token 才填，会拼成 `?access_token=` |
| `groupReply` | 群里怎么才回：`mention`（被 @ 才回）/ `prefix`（带前缀才回）/ `always`（全回） |
| `prefixes` | `groupReply=prefix` 时的触发词，匹配后会被剥掉再送进 DSH |

私聊永远回。自己在群里说的话不会被当成消息接回来。

## 目录

```
src/index.js             入口：读配置、装适配器、把两边接起来
src/adapters/base.js     适配器接口（connect / send / 事件）
src/adapters/onebot.js   QQ，OneBot v11 正向 WebSocket
src/adapters/console.js  终端，测链路用
src/dsh/client.js        DSH 客户端插槽（TODO）
scripts/test-onebot.mjs  纯函数测试
docs/ARCHITECTURE.md     槽位说明、DSH 协议要点、移植清单
```

## 下一步：DSH 那一侧

协议有三处坑，`docs/ARCHITECTURE.md` 和 `src/dsh/client.js` 里都写清楚了：
Cookie 鉴权（不是 Bearer）、斜杠 RPC、`/api/remote.mux` 事件流。
`qq-bridge/src/dsh-client.js` 已经踩平过，移植时只抄鉴权和 RPC 通道，别抄业务。

## License

MIT
