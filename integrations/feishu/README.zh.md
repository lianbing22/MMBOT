# 飞书连接器（`integrations/feishu`）

把飞书装进 Bot 的工具箱：这是一个 **MCP stdio 服务器**，让 MMBOT 的 Bot 列出机器人在的群、读群历史、发消息、把邮箱/手机号换成 open_id。实现只有 Node 内置能力（`fetch`、`node:test`），**零外部依赖**，不引入 `@modelcontextprotocol/sdk`，也不需要 `npm install`。

| 做什么 | 工具 |
|---|---|
| 给群或人发一条纯文本消息 | `feishu_send_message` |
| 列出机器人所在的群和单聊 | `feishu_list_chats` |
| 读群的会话历史（分页） | `feishu_get_chat_history` |
| 邮箱/手机号 → open_id | `feishu_get_user` |

要求 Node.js ≥ 20。运行 `node server.mjs` 即可，仓库根目录不需要安装任何东西。

- English: [README.md](README.md)
- 协议：MCP `2024-11-05`，stdio 上按行传 JSON-RPC 2.0（`initialize`、`tools/list`、`tools/call`）。

## 1. 创建飞书自建应用

1. 打开飞书开放平台开发者后台 <https://open.feishu.cn/app>，用企业管理员或开发者账号登录。
2. **创建企业自建应用**：填名称（例如 `MMBOT 助手`）和描述，进入应用。
3. **添加机器人能力**：应用功能 → 机器人 → 启用。发消息和读历史都要求应用有机器人能力。
4. **开通权限**：权限管理 → API 权限，按下表勾选。
5. **配置通讯录数据范围**（只有 `contact:user.id:readonly` 需要）：权限管理 → 该权限 → 可访问的数据范围 → 选择全部成员，或指定部门/成员。范围之外的邮箱查不到 open_id。
6. **取凭证**：凭证与基础信息 → App ID、App Secret。
7. **发布版本**：版本管理与发布 → 创建版本 → 申请发布。权限改动后必须重新发布并等审批生效；新权限要等下一次换 token 才生效。
8. **把机器人拉进目标群**：群设置 → 群机器人 → 添加机器人。机器人不在群里时，发消息和读历史都会失败（`230002` / `not_in_chat`）。

| 权限 | 作用 | 用到的工具 |
|---|---|---|
| `im:message` | 以机器人身份发消息 | `feishu_send_message` |
| `im:message:readonly` | 读会话历史消息 | `feishu_get_chat_history` |
| `im:chat:readonly` | 列出机器人所在的群和单聊 | `feishu_list_chats` |
| `contact:user.id:readonly` | 邮箱/手机号 → open_id | `feishu_get_user` |

权限点名称以开发者后台“权限管理”里显示的为准（飞书会随版本调整名称）。本连接器只发纯文本，不需要卡片、文件、云文档相关权限。

## 2. 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `FEISHU_APP_ID` | 是 | 应用 App ID |
| `FEISHU_APP_SECRET` | 是 | 应用 App Secret，只用于换 token；任何日志和错误结果里都不出现 |
| `FEISHU_BASE_URL` | 否 | 默认 `https://open.feishu.cn`；Lark 国际版用 `https://open.larksuite.com`；测试时指向本地 mock |
| `FEISHU_TIMEOUT_MS` | 否 | 单次请求超时，默认 `15000`（取值 50–60000） |
| `FEISHU_RETRIES` | 否 | 暂时性失败（429 / 5xx / 网络）的重试次数，默认 `1`，最大 `3` |

服务器本身可以先验一步（不会访问网络）：

```sh
cd integrations/feishu
node server.mjs --print-tools   # 打印四个工具的 JSON Schema
node server.mjs --help          # 用法与环境变量
```

## 3. 在 MMBOT / DSH 里注册

MMBOT 的 MCP 是“共享能力”：先在主机上保存，再分配给 Bot。

1. **保存能力**：dsh（桌面版或 Web）→ 设置 → **Capabilities** → **Add capability**
   - **Name**：`feishu`（只允许小写字母、数字、单连字符；`github` 保留）
   - **Type**：`MCP server`；**Connection**：`Local command`
   - **Command**：`node` 的绝对路径（用 `which node` 查；从 Dock 启动的桌面版 PATH 里可能没有 node）
   - **Arguments (one per line)**：`/ABS/PATH/MMBOT/integrations/feishu/server.mjs`
   - **Environment (JSON)**：见下面的片段
2. **首次批准**：本地命令能力保存后是待批准状态，点能力行上的 **Allow**，Bot 才会真的启动它。
3. **分配给 Bot**：打开某个 Bot 的详情 → **Capabilities** → 打开 `feishu` 的开关。
4. 工具在会话里以 `mcp__feishu__<工具名>` 出现，例如 `mcp__feishu__feishu_send_message`。

环境 JSON 里不要写真实密钥，用密钥引用：

```json
{
  "FEISHU_APP_ID": "$DSH_SECRET_FEISHU_APP_ID",
  "FEISHU_APP_SECRET": "$DSH_SECRET_FEISHU_APP_SECRET"
}
```

把 App ID / Secret 存成密钥（设置 → Secrets，或让 Bot 用 `request_secret` 要），在环境里只写 `$DSH_SECRET_<名字>`；MMBOT 在启动 MCP 进程前替换成真实值，配置文件里只有引用。注意 MCP 进程读的是它自己的环境变量，不是 Bot shell 里的 `$DSH_SECRET_*`。

设置页保存的字段（便于核对）等价于：

```json
{
  "name": "feishu",
  "kind": "mcp",
  "description": "Read and send Feishu messages",
  "transport": "stdio",
  "command": "/usr/local/bin/node",
  "args": ["/ABS/PATH/MMBOT/integrations/feishu/server.mjs"],
  "env": {
    "FEISHU_APP_ID": "$DSH_SECRET_FEISHU_APP_ID",
    "FEISHU_APP_SECRET": "$DSH_SECRET_FEISHU_APP_SECRET"
  }
}
```

**用 npx 启动**（可选）：把目录装成全局包后，`mmbot-feishu` 就在 PATH 上：

```sh
npm install --global /ABS/PATH/MMBOT/integrations/feishu
```

此时 Command 填 `npx`、Arguments 填 `-y` 和 `mmbot-feishu`（或 Command 直接填 `mmbot-feishu`、参数留空）。包发布到你们的 registry 之后，也可以写 `npx -y mmbot-feishu-mcp`。直接从 checkout 跑时用 `node server.mjs`，不需要安装。

## 4. 工具与参数

每个工具的输入和输出都有 JSON Schema，`node server.mjs --print-tools` 可以直接取到。工具名下面的写法是不带前缀的原始名。

### 4.1 `feishu_send_message`

给群或人发一条纯文本消息；目标三选一，必须正好给一个。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `chat_id` | string | 三选一 | 群/会话 ID（`oc_…`） |
| `open_id` | string | 三选一 | 用户 open_id（`ou_…`），发单聊 |
| `email` | string | 三选一 | 用户邮箱，飞书自行解析 |
| `text` | string | 是 | 消息正文，≤ 30000 字符 |

调用 `POST /open-apis/im/v1/messages?receive_id_type=chat_id|open_id|email`，正文 `{receive_id, msg_type: "text", content: "{\"text\":\"…\"}"}`。

返回：

```json
{
  "ok": true,
  "message_id": "om_d4c1…",
  "chat_id": "oc_5f6e…",
  "create_time": "1730000000000",
  "receive_id_type": "chat_id",
  "receive_id": "oc_5f6e…"
}
```

### 4.2 `feishu_list_chats`

`GET /open-apis/im/v1/chats`，列出机器人所在的群和单聊。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page_size` | integer | 否 | 每页条数，1–100，默认 20 |
| `page_token` | string | 否 | 上一页返回的 `page_token` |

返回 `{ ok, chats: [...], page_token, has_more }`；每个 chat 是 `chat_id`、`name`、`description`、`chat_mode`（`group` / `p2p`）、`chat_type`、`external`、`owner_id`。

### 4.3 `feishu_get_chat_history`

`GET /open-apis/im/v1/messages`，读一个群的历史消息。机器人必须在该群里。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `container_id` | string | 是 | 要读的 `chat_id`（`oc_…`） |
| `container_id_type` | string | 否 | 只支持 `chat`，默认 `chat` |
| `start_time` / `end_time` | string | 否 | 起止时间，秒级时间戳 |
| `sort_type` | string | 否 | `ByCreateTimeAsc` / `ByCreateTimeDesc`，默认倒序 |
| `page_size` | integer | 否 | 每页条数，1–50，默认 20 |
| `page_token` | string | 否 | 上一页返回的 `page_token` |

返回 `{ ok, messages: [...], page_token, has_more }`；每条消息是 `message_id`、`msg_type`、`create_time`、`sender_id`、`sender_type`、`text`、`mentions`、`deleted`。正文被拍平成 `text`：文本消息直接取文字；富文本 post 拼成“标题 + 段落”；图片、文件、视频等用 `[image]`、`[file]` 之类的占位符，不会静默丢消息。

### 4.4 `feishu_get_user`

`POST /open-apis/contact/v3/users/batch_get_id?user_id_type=open_id`，把邮箱或手机号换成 open_id。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `email` | string | 二选一 | 用户邮箱 |
| `mobile` | string | 二选一 | 用户手机号（需要国家码时带上） |

返回：

```json
{
  "ok": true,
  "users": [{ "open_id": "ou_9a1b…", "email": "ada@example.com", "mobile": "" }],
  "not_found": []
}
```

飞书匹配不到的值放在 `not_found` 里，不会假装成功。

## 5. 返回结构与错误码

成功时 `tools/call` 返回一条 text 内容，正文是 `{ "ok": true, ... }`。失败时 `isError: true`，正文是统一结构：

```json
{
  "ok": false,
  "code": "permission_denied",
  "message": "no permission",
  "hint": "The Feishu app is missing a permission scope. …",
  "feishu_code": 99991672,
  "status": 200,
  "endpoint": "/open-apis/im/v1/messages"
}
```

`code` 是稳定的机器可读值；`feishu_code`、`status`、`endpoint` 只在飞书有响应时出现，便于对着官方文档查。

| `code` | 含义 | 处理 |
|---|---|---|
| `invalid_arguments` | 参数不符合 schema | 按 `tools/list` 的 schema 改 |
| `missing_credentials` | 没配 App ID / Secret | 补环境变量并重启 |
| `invalid_config` | `FEISHU_BASE_URL` 非法 | 换成 http(s) 地址 |
| `timeout` | 请求超时 | 调大 `FEISHU_TIMEOUT_MS`，检查网络 |
| `network_error` | 连不上飞书 | 检查网络与 `FEISHU_BASE_URL` |
| `unauthorized` | 凭证或 token 被拒（重取一次后仍失败） | 核对 App ID / Secret，确认应用已发布 |
| `permission_denied` | 缺权限（`99991672` / `230027`） | 开通权限并发布新版本 |
| `not_in_chat` | 机器人不在这个群（`230002`） | 把机器人拉进群 |
| `rate_limited` | 被限流（429 / `99991400`） | 等几秒，减少发送频率 |
| `not_found` | ID 不存在 | 核对 ID |
| `server_error` | 飞书 5xx | 稍后重试 |
| `invalid_request` | 飞书拒绝参数 | 检查参数 |
| `feishu_error` | 其他飞书错误 | 用 `feishu_code` 查文档 |
| `internal_error` | 连接器自身的问题 | 把 `message` 报给维护者 |

## 6. token、重试与超时

- `tenant_access_token` 换到后缓存在进程内存，按飞书返回的 `expire` 计算到期时间，**提前 5 分钟**刷新；并发调用只换一次（单飞）。
- 飞书回 401 或 token 失效码（`99991661`、`99991663`、`99991664`、`99991668`）时丢弃缓存、重取一次再重试原请求；再失败就报 `unauthorized`。
- 429 / 408 / 5xx / 网络错误最多重试 `FEISHU_RETRIES` 次（默认 1，指数退避，250ms 起、最多 1.5s）；**超时不重试**，所以最坏耗时大约是 `FEISHU_TIMEOUT_MS`（换 token 和业务请求各一次）。
- 不打印凭证或 token；错误信息里如果出现已登记的值，会替换成 `[redacted]`。

## 7. 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| Bot 里没有 `mcp__feishu__*` 工具 | 能力没保存 / 没 Allow / 没给 Bot 打开 | 设置 → Capabilities 点 **Allow**；Bot 详情 → Capabilities 打开开关；重开 dsh |
| `permission_denied` / `99991672` | 权限没勾，或改了权限但没发布新版本 | 权限管理勾选 → 创建版本并发布 → 等审批 |
| `not_in_chat` / `230002` | 机器人不在目标群 | 群设置 → 群机器人 → 添加机器人 |
| `unauthorized` / `99991663` | App Secret 错、应用被停用，或网关用了别的 App | 核对凭证与 `FEISHU_BASE_URL` |
| `feishu_get_user` 查不到人 | 通讯录数据范围不含此人 | 权限管理 → `contact:user.id:readonly` → 调整数据范围 |
| `timeout` | 机器到飞书网络慢，或代理拦了 | 调大 `FEISHU_TIMEOUT_MS`；检查代理 |
| `missing_credentials` | MCP 进程环境里没有两个变量 | 环境 JSON 里补上（用 `$DSH_SECRET_*` 引用）后重启 dsh |
| 服务器起不来 | node 版本 < 20，或 Command 里 node 路径不对 | `node --version`；Command 用 `which node` 的绝对路径 |
| 想确认服务器本身没问题 | — | `node server.mjs --print-tools`，能输出 JSON 即正常（不联网） |

## 8. 安全

- 只用 Node 内置 `fetch`，依赖为零：离线或内网机器不需要 `npm install`。
- App Secret 只出现在换 token 的请求体里；日志和错误结果里出现即替换为 `[redacted]`。
- token 只在进程内存里，不落盘。
- 建议最小权限：只开上面四个权限；发送用机器人身份，不需要用户 OAuth。
- 消息正文会经过飞书，不要把密钥写进消息。
- 只发纯文本，不下载文件、不执行飞书里的指令；飞书返回的内容按数据处理。

## 9. 开发与测试

```sh
cd integrations/feishu
node --test                     # 24 个用例；全部打本地 mock，不出网
node server.mjs --print-tools   # 工具 JSON，便于集成方校验
node server.mjs --help
```

文件：

| 文件 | 内容 |
|---|---|
| `server.mjs` | MCP stdio 协议、token 缓存、HTTP 错误映射、四个工具、CLI |
| `test/server.test.mjs` | 本地 http mock；覆盖 initialize、tools/list、发送成功、参数校验、401 重取 token、提前刷新、限流重试、500、超时、凭据缺失、错误透传与 CLI |
| `package.json` | `type: module`、`bin`、`engines.node >= 20`，没有 dependencies |

测试用 `FEISHU_BASE_URL` 指向 `127.0.0.1` 上的 mock，所以**不需要真实凭证、也不会访问飞书**。改代码后先跑 `node --test`。

## 10. 已知限制与下一步

限制：

- 只发纯文本。卡片、富文本 post、图片、文件暂未实现（`feishu_send_message` 只接受 `text`）。
- 只做主动调用：没有事件订阅，Bot 现在**收不到**飞书群里的消息，得由用户在自己的 Bot 聊天里让它去读/发。
- 读历史是单页的，需要翻页时用返回的 `page_token` 继续要。

双向群桥接（飞书群里 @Bot 直接干活）的设计建议：

1. **事件入口**：在飞书开放平台订阅 `im.message.receive_v1`。本机常常没有公网地址，优先用**长连接**（飞书 SDK 的 WebSocket 模式）而不是 webhook，不用暴露端口；长连接进程与 MCP 服务器分开跑，因为 MCP stdio 是请求-响应模型，塞进一个常驻监听会互相拖住。
2. **会话映射**：`chat_id` 对应 MMBOT 的一个群会话；`sender.open_id` 对应用户身份。只有当消息 `@` 了机器人才进 Bot 回合，避免群里闲聊反复触发。
3. **回帖**：Bot 的答复用 `feishu_send_message` 回到同一个 `chat_id`，并带上父消息 `message_id` 形成回复线程；超出长度分段发送。
4. **幂等与去重**：按 `event_id` / `message_id` 去重，重连补发不会重复触发；处理失败的消息进入重试队列而不是丢弃。
5. **安全边界**：只处理机器人所在群；来自群里的指令默认低权限，发往外部的动作（发邮件、改数据）要人类确认；不把群里的内容当系统指令。
