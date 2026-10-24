# MMBOT

**把你的 Bot 团队，带到电脑和手机上。**

中文 · [English](README.md) · [安装配置](docs/getting-started.zh.md) · [下载](https://github.com/lianbing22/MMBOT/releases/latest)

MMBOT 连接自己电脑或服务器上的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）。你可以和专业 Bot 对话，让多个 Bot 在群聊中协作，在桌面或手机上查看工具执行、管理任务。桌面 App 自带锁定版本的 DSH；手机与电脑共用同一套会话、模型和工作区。

<p align="center">
  <img src="docs/images/mobile/home.zh.png?v=0.1.0-15" width="250" alt="MMBOT 会话主页">
  <img src="docs/images/mobile/chat.zh.png?v=0.1.0-15" width="250" alt="Bot 对话与悬浮聊天控件">
  <img src="docs/images/mobile/night.zh.png?v=0.1.0-15" width="250" alt="MMBOT 夜间模式">
</p>

<p align="center">会话主页 · Bot 对话 · 夜间模式</p>

## 可以做什么

独立桌面 App 从 DeepSeek Harness 导入 Bot 团队时，不继承旧主机的手机授权或 TLS 身份。手机入口默认关闭，需要重新启用并配对；用户编写的手机技能会保留，原主机不受影响。

| 功能 | 手机端体验 |
| --- | --- |
| Bot 团队 | 创建 Bot，自定义名称、角色、头像和模型；指定 Main Bot 管理团队。每个 Bot 保留长期对话。 |
| 群聊协作 | 组建 Bot 群聊、选择管理员、@ 成员或引用其他对话；查看谁正在工作、谁在等待批准。 |
| 消息与多模态 | 流式回复与思考，长按消息操作，附加图片和文件，语音输入与语音对话。 |
| 工具与主机管理 | 专属工具结果卡片，允许/拒绝待批准操作，管理支持的 Skills、插件和连接器，以及可选桌面浏览器控制。 |
| 共享能力 | 在手机上选择每个 Bot 可使用的 MCP 服务、技能和能力包，查看连接与批准状态；能力库在 DSH 电脑上配置。 |
| 任务与记忆 | 管理定时任务和 Bot 记忆，搜索历史对话，在设置或详情页查看用量。 |
| 工作目录 | 为 Bot 选择主机项目或目录，也可为群聊指定统一目录；对话在新分段中继续，保留历史。需要 v0.1.1 及以上版本。 |
| 通知 | 任务与审批提醒，支持 Android 后台接收和可选云推送。 |
| 外观与语言 | 中英文、日间/夜间/跟随系统，离线可查看缓存和编辑草稿。 |

Bot 对话换段时，定时任务保留原 Session 绑定，到期提醒转发到当前段处理；换段不会复制或重建任务。

<p align="center">
  <img src="docs/images/mobile/group.zh.png?v=0.1.0-15" width="250" alt="显示 Bot 作者头像的群聊">
  <img src="docs/images/mobile/create.zh.png?v=0.1.0-15" width="250" alt="创建 Bot 与头像自定义">
  <img src="docs/images/mobile/tools.zh.png?v=0.1.0-15" width="250" alt="工具、Skills 和插件入口">
</p>

<p align="center">群聊协作 · 创建 Bot · 工具与技能</p>

<p align="center">
  <img src="docs/images/mobile/settings.zh.png?v=0.1.0-15" width="250" alt="悬浮控件与设置页面">
  <img src="docs/images/mobile/capabilities.zh.png?v=0.1.0-15" width="250" alt="为每个 Bot 分配 MCP、技能和能力包">
</p>

<p align="center">设置 · 能力库</p>

截图使用演示数据。[截图来源](docs/images/mobile/README.md)

## 快速开始

1. 安装 [DSH Desktop](https://github.com/deepseek-ai/deepseek-harness/releases)，打开 **插件 → 添加插件**，粘贴下方安装文本并安装、启用、重启。
2. 在电脑上配置模型。本版本的手机 App 仍叫 **DS Bot**，MMBOT 的名称会随它的下一个版本到来；从 [v0.1.3 Release](https://github.com/lianbing22/MMBOT/releases/tag/v0.1.3) 下载 `dsbot-android-arm64-v0.1.3.apk` 安装到手机；`dsbot-android-x86_64-v0.1.3.apk` 用于对应模拟器。
3. 手机安装 APK。电脑打开 MMBOT **设置 → 移动设备 → 启用手机连接**，手机扫码，电脑批准设备。

```text
github:lianbing22/MMBOT#a115f2b722387b3a401bd34e26fe48ad7d34f78d&path:ds-bot
```

以上是完整安装文本，直接复制。Release 还提供 `ds-bot-0.1.3.tgz`；下载后使用 `SHA256SUMS` 校验。该固定地址装不上时（例如电脑没有装 Git），改为填写这个归档的完整路径安装。插件归档 SHA-256：`ab65ce3033a88890c3410c371aa7a2fc8c88f96437f4620889128b6a7b1c5b1f`。

该固定地址指向已发布的 v0.1.3 源码。历史 v0.1.2 下载仍原样保留以兼容已有锁文件；新安装请使用 v0.1.3。详见 [v0.1.3 发布说明](docs/releases/v0.1.3.md)。

初次配对建议使用同一 Wi-Fi。插件自动配置本地 HTTPS，无需域名或手动安装证书。Bot、工具和任务由电脑或服务器执行，模型使用主机配置的提供商；使用时需保持主机在线。

请使用本仓库提供的配套插件包，npm 上游的同名 `ds-bot` 不包含完整手机连接功能。

v0.1.1 还支持[公网 IPv6 跨网络直连](docs/mobile-local-https.zh.md#ipv6-直连)，无需域名或中继。

iOS 源码已提供，当前没有 IPA 安装包；构建与支持说明见 [iOS 文档](docs/ios.zh.md)。

[安装与配置](docs/getting-started.zh.md) · [功能与通知配置](docs/mobile-features.zh.md) · [远程连接](docs/mobile-install.zh.md)

主机插件升级与修复见[插件更新](docs/plugin-updates.zh.md)。

### 网页搜索

MMBOT 会把 `auto` 搜索 provider 选为整个 profile 的后端。禁用 `web-search-auto` 时，也要为该 profile 选择另一个已注册的搜索 provider。详见[网页搜索说明](ds-bot/README.md#web-search)和[恢复步骤](docs/known-issues.zh.md#关掉web-search-auto后所有会话的网页搜索都失败)。

## Docker

从本仓库检出构建镜像，说明见 [`docker/README.md`](docker/README.md)（英文）。容器是 Bot 的沙箱。此镜像尚未发布或验证 Docker 内的手机配对和移动桥接功能。

## 桌面应用

桌面应用位于 [`app/`](app/README.md)（英文）。它自带 DSH，不用先装 DSH。在 [Releases](https://github.com/lianbing22/MMBOT/releases/latest) 里下载：

- Windows（x64）：`MMBOT-<版本>-win-x64.exe`。运行它即可安装，只装给当前用户，不要管理员权限。如果提示“Windows 已保护你的电脑”，点 **更多信息** → **仍要运行**。
- macOS：Apple 芯片下载 `MMBOT-<版本>-mac-arm64.zip`，Intel 下载 `MMBOT-<版本>-mac-x64.zip`。Safari 会自动解压；把 **MMBOT** 拖进 **应用程序**，再打开。如果提示无法检查这个 App，打开 **系统设置** → **隐私与安全性**，点 **仍要打开**。
- Linux（x64）：本项目也能构建 `MMBOT-<版本>-linux-x86_64.AppImage` 和 `MMBOT-<版本>-linux-amd64.deb`；CI 会构建并校验两者，但本 fork 的发布流程暂未把它们附到 Release 上。需要的人在 Linux 上进入 `app/` 运行 `npm run dist`，细节见 [`app/README.md`](app/README.md) 的 Linux 部分。

第一次打开时，App 会问数据和 Bot 的文件放在哪里，并可以从你的 dsh 复制 Bot 团队（只读取你的 dsh，不改它）。在 App 的设置里配好模型就能用。Windows 版会自动更新；macOS 版和 Linux 的 deb 有新版本时会提示你下载。

开发时在目标电脑上运行：

```sh
cd app
npm ci
npm start
```

在对应目标系统上用 `npm run dist` 构建安装包；Windows、macOS 和 Linux 原生打包由各自的 CI runner 验证。macOS 安装包没有公证。桌面更新元数据只随普通 `vX.Y.Z` 版本发布；`-rN` 修订版仍仅用于插件和 Android 资产，因此桌面更新必须使用下一个语义版本。

## 开发

App 使用 React Native 与 Expo，共用 SDK 连接 DSH 插件。

| 目录 | 内容 |
| --- | --- |
| [apps/mobile](apps/mobile/README.md) | 手机 App、原生构建与开发说明 |
| [packages/mobile-sdk](packages/mobile-sdk) | 手机与主机通信 SDK |
| [ds-bot](ds-bot/README.md) | DSH 插件、手机桥接与电脑端界面 |

开发使用 Node.js 24。环境安装、测试与贡献流程见 [贡献指南](CONTRIBUTING.md)。[GitHub Actions](.github/workflows/build.yml) 检查插件、桌面安装包和手机 App，并构建 Android APK；签名与发布步骤见 [发布文档](docs/releasing.zh.md)。

主机兼容基线为 DSH `0.2.1-rc.2`。语音和桌面浏览器控制需要对应的主机服务，详见 [功能说明](docs/mobile-features.zh.md)。

本 fork 同步自冻结的 upstream：`1bebe826f74e9a72cabafd3b80602b05af867b38`（upstream `v0.2.1`），其 diff 基线为 `02cbb63a29f3591839d2b37ffa91d202a12ede6c`（upstream `v0.2.0`）。该同步在本 fork 中尚未发布；fork 版本仍为 `0.1.3`。Docker 刻意保留本 fork 的离线插件归档重装、供应链策略元数据预置和事务回滚；上游已移除这些能力。

[本地调试](docs/mobile-local-debug.zh.md) · [上游同步](docs/mobile-upstream.zh.md) · [更新记录](CHANGELOG.md)

## 致谢与许可

MMBOT 是 [DS Bot App](https://github.com/QingJ01/DS-Bot-App) 的品牌化分支，而 DS Bot App 又是 [DS Bot](https://github.com/Fei2411/DeepSeek-Bot) 面向手机端的分支。插件与桌面 App 现在以 MMBOT 发布；手机 App 在下一版之前仍沿用 DS Bot 的名称与包名。

本项目基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 开发。每个 Bot 都在 DSH 会话中工作，并使用 DSH 工具与模型。上游声明见 [NOTICE](NOTICE)。

[Apache License 2.0](LICENSE)。MMBOT 是独立项目，并非 DeepSeek 官方产品。
