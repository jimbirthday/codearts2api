# codearts2api

把 [`dsh-providers-hub`](https://github.com/iJetLi/dsh-providers-hub) 的
**Jet Hub 多渠道账号管理**与**本机 OpenAI 网关**搬到独立后端运行，**不依赖 DSH 宿主**，
面向自建服务与容器部署。

它不 fork 上游代码，而是直接把上游的插件装载起来 —— 所以**渠道、模型、协议、界面
都跟着上游走**，本项目自己只负责鉴权、状态隔离与对外接口。

<img width="1277" height="919" alt="总览界面" src="https://github.com/user-attachments/assets/b3fc1739-37b5-43b1-a927-78c4b706fec7" />

<img width="1920" height="1031" alt="Jet Hub 管理界面（上游设置页原样复用）" src="https://github.com/user-attachments/assets/0fc7e323-2830-49e0-898f-88e28c631a71" />

## 使用方法

### Docker 部署

推荐用镜像跑。`CODEARTS2API_HOME=/data` 已由镜像设好并声明为 `VOLUME`，**不挂卷则容器
重建后账号会丢**。

```bash
docker pull ghcr.io/zhuweiyou/codearts2api:latest
docker run -d --name codearts2api \
  -p 8080:8080 \
  -v codearts2api-data:/data \
  ghcr.io/zhuweiyou/codearts2api:latest
```

也可以在仓库根目录自行构建：`docker build -t codearts2api .`，再把上面的镜像名换成
`codearts2api` 运行。

首次启动会在 `/data/admin-key` 生成管理密钥，用它登录后台：

```bash
docker exec codearts2api cat /data/admin-key
```

打开 `http://<主机>:8080/admin` 进入。管理接口自带鉴权，`-p 8080:8080` 不会把后台直接
暴露给公网；公网部署仍需自行终结 TLS（见 [`AGENTS.md`](AGENTS.md)）。

### 本机直跑

**要求**：Node.js `^22.19.0 || ^24.11.0 || >=26.0.0`（建议 24 LTS ≥24.11），包管理器用 **pnpm 11**
（`corepack enable` 即可；项目已含 `pnpm-lock.yaml`）。

```bash
pnpm install
pnpm run build   # 前端(dist/) + 后端(dist-server/) 一起构建
pnpm start       # 运行后端编译产物 dist-server/index.js
```

启动后打开 <http://127.0.0.1:8080/admin>。首次启动会在日志里打印一次管理密钥
（默认状态目录 `~/.codearts2api`，可用 `CODEARTS2API_HOME` 指定），用它在登录页进入后台。

### 管理界面

`/admin`（登录后）顶栏是三个一级页面：

- **总览**（默认首页）：网关状态、今日用量、近 14 日趋势、渠道账号与余额、积分收支、
  模型分布、自动签到；
- **渠道管理**：上游 Jet Hub 设置页原样复用 —— 左侧为各渠道，页头「网关」按钮可查看
  对外地址、复制 API Key 与模型清单；
- **调用方**：多把 Key 与分组授权（见下）。

顶栏右侧还有 **「回调修复」**（远程部署时第三方登录跳回 `127.0.0.1` 打不开，可让服务器
本机重放）与**主题切换**（跟随系统 / 浅色 / 深色）。

### CodeArts JSON 批量导入

打开「渠道管理」，点顶部 **「导入 CodeArts JSON」**，选择一个或多个 `.json` 文件。
每个文件可以是一个账号对象，也可以是账号对象数组。每批最多 100 个文件，总大小不超过 2 MB。
检查预览后点 **「确认导入」**；格式错误的记录会列出原因，其余有效记录仍可导入。

必需字段为 `access_key_id`、`secret_access_key`、`cloud_dragon_token`、`expiration`。
同时兼容上游标准字段，转换关系如下：

| 文件字段 | 上游凭据字段 |
| --- | --- |
| `cloud_dragon_token` | `security_token` |
| `expiration` | `expires_at` |
| `dpop_private_key` | `dpop_private_key_jwk` |

`user_id`、`user_name`、`domain_id` 会保留；账号名优先取 `user_name`。
自动续期需要同时提供 `refresh_token`、`code_verifier` 和 EC P-256 格式的 DPoP 私钥（含 `x/y/d`）。
临时凭据已经过期也可以导入，但能否续期取决于这些材料是否仍有效；失败时需要重新登录。

此入口只追加账号，重复导入同一文件会跳过，不覆盖已有账号、模型开关和锁定设置。
不同工具导出的同一账号若缺少一致的身份字段，上游可能无法判重，需检查是否出现重复账号。
导入成功后账号视图自动刷新。其他渠道和完整备份仍使用上游的「备份与恢复」入口。

### CodeArts 会话粘性与并发

CodeArts 现在优先复用会话绑定的账号；新会话按在途请求数、绑定数和最近使用顺序分散。
账号禁用、凭据不可读或目标模型限额时会重新分配；账号只是满载时保持绑定并限时等待，
其他会话仍可使用空闲账号。名额覆盖完整推理过程，包括 SSE 输出；完成、失败、换号、
客户端取消与超时都会回收。读取凭据、模型目录和后台续期不占用推理名额。

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `CODEARTS_MAX_IN_FLIGHT` | `1` | 每个账号同时进行的最大推理数，范围 1–100；跨模型、跨调用方共享 |
| `CODEARTS_QUEUE_LIMIT` | `100` | 等待名额的请求上限；`0` 表示满载立即拒绝 |
| `CODEARTS_QUEUE_TIMEOUT_MS` | `15000` | 每次等待名额的超时，毫秒 |
| `CODEARTS_STICKY_TTL_MS` | `1800000` | 会话绑定的空闲过期时间，默认 30 分钟，活动请求期间保留绑定 |

例如设置 `CODEARTS_MAX_IN_FLIGHT=2`，10 个可用账号最多同时承接 20 次推理。
这是本地保护上限，实际可用并发仍取决于 CodeArts 的服务端限制；建议先用默认值再逐步调整。
排队超时或队列已满时，非流式返回 HTTP 429；已经开始 SSE 响应时以错误事件返回。

Chat Completions 和 Responses 都支持显式会话键，按以下顺序读取：
`metadata.conversation_id`、`metadata.conversationId`、顶层 `conversation_id` / `conversationId`、
`prompt_cache_key`、`X-Conversation-Id`、`X-Session-Id` 请求头。
缺省时用 system / instructions 与首条 user 内容的摘要派生。不同对话若首轮内容相同，
派生键可能相同，因此需要严格区分会话时请传显式键；`user_id` 不作为会话键。
会话键按调用方隔离，只在内存里保存摘要，不保存提示词或密钥。
超过 16 MB 的正文不额外解析会话信息，此时请使用会话请求头。

上游 `Chat-Id` 随会话和账号保持稳定，`Session-Id` 按推理请求隔离，防止并发任务共用队列任务 ID。
输出前的账号/传输故障最多进行 3 轮调度尝试；上游已有的模型限额换号仍逐个尝试未用账号。
开始输出内容块后不再跨账号重放。按需续期刷新实际选中的账号。

该机制覆盖 `/v1/chat/completions`、`/v1/responses`、直接访问插件网关和聚合派发到 CodeArts 的请求。
`GET /healthz` 的 `scheduling.codearts` 可查看在途数、排队数、绑定数与生效配置。
绑定和计数属于单进程，重启后重新分配；多个实例不共享并发名额。
其他渠道继续使用上游原有调度规则。

### 多把调用方 Key（分组授权）

默认只有一把网关 Key。要「按人发 Key、按人限模型、按人看用量」时，用顶栏「调用方」页：

- **一把 Key 一个人**，可单独停用 / 删除；
- **分组决定能调哪些模型**（白名单）；
- **用量按人按模型记账**，只记元数据，不落 prompt / 回复正文。

在「分组」页建分组、勾白名单，在「Key」页新建并发给对方（明文只显示一次）。
`<home>/caller-keys.json` 不存在时该功能不生效，删掉即回滚。

## API

### HTTP 接口

| 路径                                                                | 说明                                             |
| ------------------------------------------------------------------- | ------------------------------------------------ |
| `GET /admin`                                                        | 管理界面（登录页 → 默认「总览」；渠道页复用上游 Jet Hub） |
| `POST /api/jet-hub`                                                 | Jet Hub 管理 RPC（上游实现原样透传，需管理密钥） |
| `GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/responses` | OpenAI 兼容接口（上游网关，需网关 Key）          |
| `GET /healthz`                                                      | 健康检查（不含密钥，可给监控用）                 |

### 鉴权

两把钥匙，别混用：

| 密钥         | 位置                            | 给谁       | 权限                             |
| ------------ | ------------------------------- | ---------- | -------------------------------- |
| **管理密钥** | `<home>/admin-key`              | 只有你自己 | 进后台、改配置、导出全部账号凭据 |
| **网关 Key** | `<home>/openai-gateway/api-key` | 调用方     | 只能调 `/v1/*` 推理接口          |

脚本 / curl 直接带 `Authorization: Bearer <admin-key>` 访问 `/api/jet-hub`。

### OpenAI 兼容接口

登录 `/admin` → 页头「网关」按钮 → 拿实际地址、API Key 与模型清单。客户端把 `base_url`
指向网关、`api_key` 填网关 Key。模型 ID 形如 `provider/模型名`（如
`codearts/deepseek-v4.1-flash`），**必须带渠道前缀**，可用模型以 `GET /v1/models` 为准。
支持 SSE 流式与 base64 内联图片输入。

### 聚合路由

| 路由                     | 行为                                                                     |
| ------------------------ | ------------------------------------------------------------------------ |
| `aggregate/<规范模型名>` | 把同一模型在各渠道的条目归一化，按额度临期顺序选号，失败时切换下一个候选 |
| `jet-hub-auto/auto`      | 在候选渠道中自动挑选可用者与模型                                         |

需先配置好对应渠道的账号，否则目录为空；可在 `/admin` 的「聚合 (跨渠道)」面板设置轮换。

---

🛠 完整的镜像标签、环境变量、状态目录、账号迁移、反向代理、安全边界、常见问题，以及
架构 / 测试 / 上游升级流程等开发内容，见 [`AGENTS.md`](AGENTS.md)。历次变更见
[`CHANGELOG.md`](CHANGELOG.md)。
