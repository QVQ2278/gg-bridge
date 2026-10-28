# gg-bridge

把某个聊天平台接到 **DeepSeek Harness**（下称 DSH）的桥。消息进 DSH 变成一个回合，DSH 的回复再发回去。

> 现在这份是**骨架**：通信两端都留了明确的插槽，其中 console 适配器是能直接跑的，DSH 客户端还是 TODO。
> `docs/ARCHITECTURE.md` 写了每个槽位该填什么，以及 `qq-bridge` 里可以直接照抄的那部分。

## 为什么是骨架

DSH 那一侧的协议不简单，照抄比重新发明省事：

- 鉴权是 Cookie，不是 Bearer。Cookie 由 `~/.dsh` 里持久化的 `client-connection/browser-session`
  密钥做 HMAC 离线铸造，所以**不用**去扒进程启动 token。
- RPC 方法名是斜杠形式（`session/list`、`session/prompt`），payload 包在 `{ args: {...} }` 里。
- 事件流是 `/api/remote.mux` 上按 `session/follow` 打开的流，提问/审批走同一条 mux 上的
  `$events` 与 `$events/result`。

这三件事 `qq-bridge/src/dsh-client.js` 已经踩平了，本仓库的 `src/dsh/client.js` 就是给它留的位置。

## 跑起来

```bash
npm install     # 目前没有依赖，纯 node 内置模块
npm start       # 启动 console 适配器，在终端里跟 DSH 对话
```

没有 `config.json` 时会读 `config.example.json`。

## 目录

```
src/index.js            入口：读配置、装适配器、把两边接起来
src/adapters/base.js    适配器接口（connect / send / onMessage）
src/adapters/console.js 终端适配器，当前唯一能跑的
src/dsh/client.js       DSH 客户端插槽（TODO：照 qq-bridge 移植）
docs/ARCHITECTURE.md    槽位说明、协议要点、移植清单
```

## 下一步

1. 定平台：`gg` 接的是哪个端（QQ？某个群里？别的软件？）。
2. 按那个端写一个 `src/adapters/<name>.js`，实现 `base.js` 的四个方法。
3. 把 `src/dsh/client.js` 的方法填上，参考 `qq-bridge/src/dsh-client.js`。

## License

MIT
