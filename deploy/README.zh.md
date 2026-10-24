# MMBOT 企业私有化部署

本目录把 MMBOT（DSH + ds-bot 插件）打包成可在**内网 / 离线主机**上运行的 Docker 部署：一条脚本准备离线包，一条脚本在目标机导入，compose 启动，自带部署自检。模型走任意 OpenAI 兼容网关（企业自有网关、vLLM、One-API、DeepSeek 官方 API 皆可），密钥不落盘。

- 编排文件：`compose.offline.yml`（不联网拉镜像）
- 辅助脚本：`install.sh`（prepare / load / config / check）
- 部署自检：`check.mjs`
- 反向代理样例：`proxy/nginx.conf`（TLS 终止，可选）

## 架构一览

```
浏览器 ──HTTPS──> nginx(可选, --profile proxy) ──> ds-bot 容器(dsh web :3080)
                                                    ├── DATA_DIR（DSH_HOME：团队/会话/登录态/模型配置）
                                                    ├── WORKSPACE_DIR（Bot 的工作目录）
                                                    └── OpenAI 兼容模型网关（宿主机或内网地址）
```

手机 App 的配对与移动桥接不包含在本镜像的验证范围内（与上游 `docker/` 一致）；企业内网场景以 Web 为主。

## 前置条件

**联网构建机（一次性）**
- Docker 与 docker compose
- 能访问 npm 源（内网可设 `NPM_REGISTRY`，见 `.env.example`）
- 本仓库一份（`deploy/` 与 `docker/Dockerfile` 同在）

**离线目标机**
- Linux + Docker + docker compose（无需外网）
- 两个可写目录：数据目录 `DATA_DIR`（DSH_HOME）与工作区 `WORKSPACE_DIR`
- 一个 OpenAI 兼容网关地址（宿主机或内网可达），以及模型 id / 上下文窗口等参数

## 快速开始（离线三步）

```bash
# ① 联网机构建离线包（生成 deploy/offline/mmbot-offline-<版本>.tar）
cp deploy/.env.example deploy/.env      # 先把模型网关等填好
bash deploy/install.sh prepare

# ② 把整个 deploy/offline 拷到离线机（U 盘/内网传输），在离线机解压并导入
tar xf mmbot-offline-<版本>.tar
bash deploy/install.sh load             # docker load + 生成配置 + 打印启动命令

# ③ 启动并自检
docker compose -f deploy/compose.offline.yml --env-file deploy/.env up -d
bash deploy/install.sh check            # 或 node deploy/check.mjs
```

联网机也可以直接用（`prepare --skip-build` 可复用本机已有镜像）。

## 模型网关

`deploy/.env` 里的四项决定 Bot 用什么模型：

| 变量 | 说明 |
| --- | --- |
| `MMBOT_GATEWAY_BASE_URL` | 网关地址，必须以 `/v1` 结尾；网关在宿主机时用 `http://host.docker.internal:<端口>/v1`（compose 已加 host-gateway 映射） |
| `MMBOT_GATEWAY_API_KEY` | Bearer 令牌。只写入容器环境变量，**不落盘**：`install.sh config` 生成 `DATA_DIR/cordis.patch.yml` 时仅引用 `apiKeyEnv` |
| `MMBOT_MODEL_ID` | 模型 id，必须与网关 `/models` 返回完全一致（区分大小写），自检会校验 |
| `MMBOT_MODEL_CONTEXT_WINDOW` / `MMBOT_MODEL_MAX_TOKENS` | 按网关实际值填写，缺了会让长文裁剪算错 |

改完 `.env` 后执行 `bash deploy/install.sh config` 重建配置（旧文件自动备份），再重启容器生效。

## 反向代理与 TLS

默认只绑定 `127.0.0.1:3080`，不直接暴露。对外发布走内置 nginx：

1. 证书放 `deploy/proxy/tls/`（`fullchain.pem` + `privkey.pem`）
2. `.env` 里 `DSH_TRUSTED_HOST` 填对外域名（多个用逗号分隔，**不带端口**）——`dsh web` 只信任名单里的 Host，否则 API 一律 403
3. 启动：`docker compose -f deploy/compose.offline.yml --env-file deploy/.env --profile proxy up -d`

nginx 配置在 `deploy/proxy/nginx.conf`（透传 `Host`、关闭缓冲以支持流式输出）。443 端口需要 root 或 `CAP_NET_BIND_SERVICE`；改用 `MMBOT_TLS_PORT` 换端口即可。

## 数据与备份

| 目录 | 内容 | 备份优先级 |
| --- | --- | --- |
| `DATA_DIR`（默认 `./data`） | DSH_HOME：Bot 团队、会话记录、登录态、模型配置（`cordis.patch.yml`） | 最高——它就是整个团队 |
| `WORKSPACE_DIR`（默认 `./workspace`） | Bot 读写的工作文件 | 高 |
| `deploy/.env` | 部署配置（含网关密钥） | 高，注意保密 |

备份建议：停容器后整目录打包（`docker compose ... down && tar czf mmbot-data-$(date +%F).tgz data workspace deploy/.env`），或对两个目录做文件系统快照。恢复＝目录放回原位＋`up -d`。

## 升级

1. 联网机：改 `MMBOT_IMAGE` 为新版本 tag（建议固定版本号），`bash deploy/install.sh prepare` 出新离线包
2. 离线机：`bash deploy/install.sh load`（只导入镜像，不动数据），`MMBOT_IMAGE` 指向新 tag 后 `up -d`
3. `bash deploy/install.sh check`：其中 `plugin` 检查项会核对容器内已装的 `ds-bot` 版本与仓库版本是否一致

数据目录不做迁移，升级前后共用。

## 回滚

把 `deploy/.env` 的 `MMBOT_IMAGE` 改回上一个 tag，重新 `up -d` 即可；数据目录与工作区目录原样保留。若新版本已写入了不兼容数据，用备份目录整体还原（先 `down`，再覆盖数据目录，再 `up -d`）。

## 故障排查

| 现象 | 排查 |
| --- | --- |
| 页面能开，所有 API 403 | `DSH_TRUSTED_HOST` 没包含浏览器实际访问的域名/IP；改完重启容器 |
| 容器互相正常但连不上宿主机网关 | 网关地址用了 `localhost`——容器里应写 `host.docker.internal`；确认网关监听 `0.0.0.0` 而非仅 `127.0.0.1` |
| 启动后健康检查长时间不就绪 | 首次启动要初始化数据卷并安装插件，`start_period` 给了 180 秒；`docker compose logs -f ds-bot` 看进度 |
| 报镜像拉取失败 | 离线机忘了 `install.sh load`；compose 是 `pull_policy: never`，不会自动拉 |
| 文件属主不对 / Bot 写不进工作区 | `PUID`/`PGID` 与宿主机目录属主不一致（`id -u`/`id -g` 核对） |
| 想确认模型配置是否生效 | `node deploy/check.mjs --dry-run` 看解析出的配置；`check` 里 `gateway` 项验证 `/models` 连通与模型 id |

自检单项重跑：`node deploy/check.mjs --skip port`（跳过某项）；`--json` 供运维平台采集。
