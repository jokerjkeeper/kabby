<div align="center">

# kabby

**一个 cc 进程，多个窗口同时 attach — 给 Claude Code 用的 PTY 多路复用器。**

桌面、浏览器、手机、iframe 看到的是同一个终端，关掉窗口 cc 照样在跑。

</div>

---

![kabby Web UI — 多标签页、左侧项目/Running 列表、右上 Live 面板与监控入口](docs/images/screenshot.png)

<div align="center">

[English](./README.en.md) · [繁體中文](./README.md) · **简体中文**

</div>

## What is Kabby

一般在终端里开 Claude Code，cc 的生命周期是绑在那个终端窗口上的：窗口关了、SSH 断了，会话就没了；想换一台设备接手，只能重开一个新的 cc。

kabby 把 **cc 进程**和 **client 连接**拆开。cc 跑在 daemon 里的 PTY 中，任何 client（桌面 App、浏览器标签页、wepages 的 iframe、手机浏览器）用 WebSocket attach 上来，看到的是同一个画面、同一份 scrollback，行为等同 `tmux attach`——只是 attach 的入口从终端变成了网址。

在这之上长出三个延伸功能：把会话开成**聊天室**让别人实时围观或协作、通过 tunnel **远程**用手机连回家里那台机器的 cc，以及扫描 cc 历史做 token 用量与成本的**分析监控**。

kabby 本身只有 Node.js 加四个依赖（express / ws / node-pty / cors），没有数据库，会话放在内存里，配置放在 `~/.kabby/`。

## Installation

需要 **Node.js ≥ 18**，以及已安装的 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI（Codex 也可以）。

```bash
git clone https://github.com/jokerjkeeper/kabby.git
cd kabby
npm install
npm start
# → kabby daemon listening on http://localhost:3700
```

浏览器打开 `http://localhost:3700` 就是完整 UI。`node-pty` 在 Windows 上走预编译的 ConPTY 后端，正常 `npm install` 即可，不需要 build 工具链。

开发时自动重启：

```bash
npm run dev
```

**桌面 App（可选）** —— Electron 壳，就是一个指向 daemon 的窗口：

```bash
cd desktop
npm install
npm start           # 开发
npm run dist        # 打包成 Windows portable exe
```

### Configuration

环境变量（可写在 `.env`，模板见 `.env.example`）：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `PORT` | `3700` | HTTP + WS 共用端口 |
| `HOST` | `127.0.0.1` | 监听地址；设为 `0.0.0.0` 开放局域网直连（务必搭配 `AUTH_TOKEN`） |
| `AUTH_TOKEN` | （未设） | 设置之后 WS 连接必须带 `?token=<value>` |
| `KABBY_VIEWER_PATH` | （未设） | cc history viewer 的 portable exe 绝对路径；设置后 UI 上的「viewer」按钮才会启用 |

用户数据放在 `~/.kabby/`：`profiles.json`（项目列表）、`sensitive-words.json`（敏感词库）、用量索引。

## Features

### 多 client attach（核心）

- **一个 PTY、N 个 client**：新 client 接上先收 scrollback replay，再接实时输出，不用重开 cc
- **项目（profile）**：把常用工程存成一张卡片，一键「新对话」或「接续上次」——后者直接把 cc 的历史会话接回来
- **多标签页 + 分割 pane**：`Ctrl+Shift+←/→` 切标签页、`Ctrl+Shift+D/E` 左右/上下分割，每个 pane 是一个独立会话
- **Provider**：Claude Code 与 Codex 都能开，建会话时选
- **敏感词拦截**：发送的输入在服务端比对词库，命中直接拦下，不进 PTY

### Chat

主页右上「聊天室」打开右侧面板：创建房间、绑定一个运行中的会话、设一组入房 key。

![创建聊天室：绑定会话、房间名称、入房 key 与「允许访客在终端输入」开关](docs/images/room-create.png)

别人打开 `http://<host>:3700/room.html`（或用「复制链接」带 `?key=`），输入 key + 昵称即可进房：

- **看终端**：实时看到绑定会话的画面（含 scrollback replay），跟随房主的终端尺寸
- **文字聊天**：保留最近 200 条；支持**贴图**（Ctrl+V 粘贴截图或选文件，前端压缩走 WS 存内存，每房保留最近 20 张）与 **@mention**（自动补全房内成员，被 @ 会高亮提示）
- **权限**：房间有「可输入」开关，**默认只读**，房主可随时切换、实时生效；只读是服务端强制，不是前端隐藏
- **隔离**：访客的 key 只换得该房绑定会话的 WS + 聊天，访问不到其他 API
- 房间存在内存里，daemon 重启或绑定会话结束即自动关房

> ⚠ 开启「可输入」等于让访客在这台机器上用你的权限执行任意命令，只给信任的人。

### Remote

daemon 绑 `127.0.0.1` 时只有本机能访问。要从外面连回这个 cc，有两种做法：

- **局域网直连**：`HOST=0.0.0.0` + `AUTH_TOKEN`，同网段的手机/笔记本直接连 `http://<内网 IP>:3700`
- **Cloudflare Tunnel（推荐）**：kabby 保持绑 `127.0.0.1`，由 tunnel 对外暴露成 `https://kabby.你的域名`（对外 443、不开防火墙入站）。配置步骤见 [`docs/cloudflare-tunnel.html`](./docs/cloudflare-tunnel.html)

搭配 [`docs/deploy-systemd.md`](./docs/deploy-systemd.md) 把 daemon 设成 systemd service，实现开机自启、崩溃重启、不随 SSH 断线而停——等于一台永远在线的 cc 主机，手机浏览器随时连上去看它跑到哪了。

另外 `embed.html` 是给第三方系统嵌入用的精简终端页，可以用 iframe 挂进自己的工单/任务页（见 [`docs/wepages-phase3-integration.md`](./docs/wepages-phase3-integration.md)）。

### Session Analyze

主页右上「监控」打开只读分析面板：后台 watcher 持续扫描 Claude Code / Codex 的历史 jsonl 建索引。

![监控面板：总计行 + Token 用量标签页，逐会话列出 model、turns、token、成本与最后活动时间](docs/images/monitor.png)

- 顶部总计：sessions、turns、input/output token、cache 写入与读取、**成本估算**、敏感词命中数
- **Token 用量**：逐会话列出 model / turns / token / 成本 / 最后活动，可展开看逐轮明细，能定位到哪一轮 context 爆掉
- **Live**：当前正在跑的会话的实时逐轮用量
- **仪表板**：汇总视图
- **敏感词**：命中列表，词库在 `~/.kabby/sensitive-words.json`
- 右上切换 **Claude / Codex**；「重新整理」重读索引，「重审历史」删索引全扫（重算 token/成本并把当前词库应用到既有对话）

索引与定价都是本地计算，不会把你的对话发送到任何地方。

## API

```bash
# 创建会话
curl -X POST http://localhost:3700/api/sessions \
  -H "Content-Type: application/json" \
  -d '{"name":"unity","cwd":"D:/Projects/my-app"}'

# 列出所有会话
curl http://localhost:3700/api/sessions

# attach（任意 WS client，例如 wscat）
wscat -c ws://localhost:3700/ws/unity
```

完整 HTTP + WS 参考：[`docs/api.md`](./docs/api.md) · 从零开始的操作流程与排错：[`docs/usage.md`](./docs/usage.md)

## Testing

```bash
node test/smoke.js
```

用 `cmd.exe` 代替 cc 运行（不依赖 claude 是否安装），验证：HTTP API 创建/删除会话、两个 WS client 连同一个会话的 fan-out、第三个 client 后加入能收到 scrollback replay、`clientCount` 正确反映 attach 数。

## Architecture

```
client（桌面 App / 浏览器 / iframe / room.html）
        │  WebSocket  ws://host:3700/ws/<session>
        ▼
   daemon.js ── HTTP API + WS upgrade + fan-out
        │
   Session ── node-pty（一个 cc 进程）+ ring buffer（scrollback）
```

```
src/
  daemon.js        — 入口：HTTP server + WS upgrade + API routes
  session.js       — Session 类：封装 PTY + scrollback + clients
  registry.js      — 单例 Map<id, Session>，name 去重、ccSessionId 占用查询
  ring-buffer.js   — 100KB chunk-based ring buffer
  room-registry.js — 聊天室：房间、入房 key、成员与消息
  profile-store.js — ~/.kabby/profiles.json CRUD
  usage-watcher.js — 后台扫描历史 jsonl 建用量索引
  cc-history.js    — 解析 cc 对话历史 jsonl
  sensitive.js     — 敏感词比对
public/            — Web UI（SPA + room.html + embed.html）
desktop/           — Electron 桌面 client
docs/              — API、使用手册、部署（tunnel / systemd）
PLAN.md            — 设计决策与分阶段规划
```

设计决策与各阶段细节见 [`PLAN.md`](./PLAN.md)。

## License

MIT
