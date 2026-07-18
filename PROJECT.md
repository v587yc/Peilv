# 实时赔率监控系统项目说明

## 1. 系统定位

本项目是 Next.js App Router 全栈足球赔率监控与 AI 分析系统，围绕 titan007 数据建立“采集 → 持久化 → 分析 → 验证 → 学习 → 报表”闭环。

页面入口：

| 路径 | 用途 |
|---|---|
| `/` | 导航首页，不自动重定向。 |
| `/login` | 管理员账号密码登录；未初始化时仅展示本机 CLI 指引。 |
| `/odds` | 赛事、赔率采集、分析、验证学习与报表主页面。 |
| `/test-ai` | LLM、搜索和飞书配置测试。 |
| `/backtest` | 创建、查询和取消隔离回测任务。 |
| `/memory` | 记忆条目和对话管理。 |

## 2. 技术栈与运行方式

- Next.js 16.1.1、React 19.2.3、TypeScript 5
- Tailwind CSS 4、shadcn/ui、Radix UI
- Supabase JavaScript SDK、PostgreSQL、Drizzle schema
- OpenAI-compatible LLM API、可选搜索 API、飞书 Webhook
- Vitest 单元测试、Playwright Chromium E2E
- 自定义 Node HTTP 入口 `src/server.ts`

项目只使用 pnpm：

```bash
pnpm install
pnpm dev                  # 默认 http://localhost:5000
pnpm test
pnpm ts-check
pnpm lint
pnpm build
pnpm start
pnpm test:e2e:install     # 首次运行 E2E
pnpm test:e2e             # 独立使用 127.0.0.1:3100
```

`scripts/build.sh` 会安装依赖、执行 `next build`，再用 tsup 输出 `dist/server.js`。`scripts/start.sh` 运行生产 server。

## 3. 数据库基线与迁移

数据库定义的可执行来源：

1. `setup-database.sql`：新环境完整初始化基线。
2. `migrations/manifest.json` 描述的全部迁移：已有环境必须按 manifest 顺序执行至当前版本 `0023_strategy_lab_trusted_settlement`，不得跳过或乱序。`0012` 提供原子登录 reservation，`0013` 提供管理员更新 OCC，`0014`–`0019` 提供登录/审计/回测恢复与 owner fence，`0020`–`0023` 提供 Strategy Lab 事实模型、策略制品、快照 provider 和 trusted settlement。
3. `src/storage/database/shared/schema.ts`：代码侧 Drizzle 模型，必须与 SQL 同步维护。

`0001_production_baseline.sql` 会：

- 创建 `schema_migrations` 和 `migration_duplicate_archive`；
- 补齐生产预测、回测预测、学习版本、记忆压缩、任务状态字段；
- 将可识别的 `YYYY-MM-DD` 统一为内部 `YYYYMMDD`；
- 在删除重复行前完整归档，并按更新时间/创建时间/id 确定性保留最新记录；
- 为预测、日报、赔率、联赛选择、回测运行等自然键建立唯一索引；
- 建立策略版本、后台任务、赔率快照、数据质量和审计表。

新库直接执行 `setup-database.sql`。旧库必须先备份，再按 manifest 编号执行迁移，并核对 `schema_migrations`、`migration_duplicate_archive`、manifest 中的 SQL SHA-256 和真实业务数据。当前 `0001_production_baseline.sql` 以及 `0014`–`0019` 的 `codeRollbackSafe=false`；这些迁移应用后，禁止直接回退到 `0013` 或更早的不兼容代码，只能回退到通过 release manifest 兼容性检查的代码版本。数据库只允许前向迁移，不执行数据库降级。`disable-rls.sql` 只用于明确的诊断场景，不是部署步骤。

核心表分组：

| 分组 | 表 |
|---|---|
| 赔率与输入 | `match_odds`、`odds_snapshots`、`prediction_data`、`league_selections`、`user_focused_leagues` |
| 线上分析 | `prediction_results`、`learned_patterns`、`strategy_versions`、`daily_reports` |
| 回测隔离 | `prediction_results_backtest`、`learned_patterns_backtest`、`backtest_jobs` |
| 运维与身份 | `automation_tasks`、`automation_task_steps`、`audit_logs`、`data_quality_records`、`admin_users`、`admin_sessions`、`admin_login_attempts` |
| 配置与记忆 | `app_settings`、`memory_bank` |

## 4. 认证与环境变量

### 4.1 数据库

- `COZE_SUPABASE_URL`
- `COZE_SUPABASE_ANON_KEY`
- `COZE_SUPABASE_SERVICE_ROLE_KEY`：服务端可选且推荐，禁止暴露到浏览器。

### 4.2 管理员与内部调用

- `ADMIN_BOOTSTRAP_TOKEN`：只用于空数据库创建首位 `super_admin` 的一次性 secret。只从受保护环境或 TTY 隐藏输入读取，初始化后删除并重启。
- `ADMIN_LOGIN_RATE_LIMIT_SECRET`：登录限流键 secret，必须在服务端设置。
- `ADMIN_TRUST_PROXY`：可选且默认关闭；只有严格设置为 `true` 时才信任代理客户端地址，并要求流量经过会覆盖来源头的受控代理边界。
- `ADMIN_API_TOKEN`：仅旧版恢复兼容，不是普通登录凭据；账号初始化后登录只接受账号密码。
- `INTERNAL_API_SECRET_FILE`：本地开发内部凭据文件；生产通过 systemd `LoadCredential` 提供，不使用环境变量承载密钥。

管理员采用数据库账号、强密码哈希、持久 HttpOnly 会话和 RBAC。`super_admin` 管理管理员与角色，其他角色仅获得其声明能力；关键变更写审计。登录保护由 `0012` 的原子、有界 reservation 消除并发 check-record 窗口；管理员写操作由 `0013` 的 `updated_at` 前置条件执行 OCC，冲突返回而非覆盖新数据。首次启动时 `/login` 不收集 bootstrap token，只提示服务器操作员运行 `pnpm admin:bootstrap`。CLI 不接受 argv secret；成功后必须清理临时 token 并重启。`src/proxy.ts` 根据 `src/lib/api-protection.ts` 统一保护设置、LLM 测试、飞书、URL 抓取、回测、高成本分析以及业务写接口。浏览器会话写请求还执行同源校验；内部任务可使用内部密钥。

### 4.3 其他变量

- 运行：`PORT`、`HOSTNAME`、`COZE_PROJECT_ENV`
- AI：`LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`
- 搜索：`SEARCH_API_KEY`、`SEARCH_BASE_URL`
- 通知：`FEISHU_WEBHOOK_URL`
- URL 导入：`FETCH_URL_ALLOWED_HOSTS`

## 5. 数据采集与主要 API

| API | 方法 | 说明 |
|---|---|---|
| `/api/odds` | GET | 今日实时赛事。 |
| `/api/schedule` | GET | 历史/未来赛程。 |
| `/api/data/match/[id]` | GET | 单场多公司赔率。 |
| `/api/data/match/[id]/opentimes` | GET | 开盘时间与皇冠新数据。 |
| `/api/data/match/[id]/crown-live` | GET | 皇冠变动数据。 |
| `/api/data/odds-db` | GET/POST/PATCH | 赔率数据库查询和写入。 |
| `/api/prediction` | GET/POST/DELETE | 日期预测 JSON。 |
| `/api/analysis` | GET/POST | 查询或生成分析。 |
| `/api/analysis/verify` | GET/PATCH | 自动验证或人工修正。 |
| `/api/analysis/learn` | GET/POST | 学习统计和模式生成。 |
| `/api/report` | GET/POST | 查询或生成日报。 |
| `/api/backtest` | GET/POST/DELETE | 回测任务管理。 |
| `/api/automation/dispatch` | POST | 外部 cron 驱动的内部调度。 |
| `/api/automation/compensate` | POST | 管理员人工补偿任务。 |
| `/api/automation/status` | GET | 后台任务状态。 |

### 孤立 API 结论

`GET /api/data/matches` 是旧的批量抓取实现。仓库内对该 URL 的搜索只有路由自身和历史文档，没有页面、服务或测试调用；当前批量流程由前端逐个调用 `/api/data/match/[id]`。因此它是“仓库内孤立、待弃用候选”，不是已证明可立即删除的 API：外部消费者不可由静态搜索排除。本轮不改业务 route，保留端点；正式删除前必须核对生产访问日志和外部集成，并发布弃用通知。

S3 对象存储已被 Supabase 表替代。源码不存在 AWS SDK import，`@aws-sdk/client-s3` 和 `@aws-sdk/lib-storage` 已从依赖及锁文件移除。

## 6. 后台调度与可靠性

后台调度由 `src/lib/automation/` 实现，任务和步骤持久化到数据库。它具备：

- 任务/步骤幂等键；
- pending/running/retrying/completed/failed 状态；
- 数据库租约锁和过期任务重新领取；
- 步骤独立错误与最多 3 次尝试；
- 失败后延迟重试，最终失败可发送飞书通知；
- 状态查询和管理员补偿入口。

北京时间计划：12:02 抓赔率、12:10 皇冠快照、12:15 分析、02:00 验证昨日数据后学习并生成报表。

`POST /api/automation/dispatch` 只负责一次“补建到期任务 + 执行可用任务”。应用进程本身没有常驻 cron 计时器，因此部署平台必须用 cron/计划任务周期调用该接口，并携带正确的 `INTERNAL_API_SECRET`。这使调度不依赖浏览器页面，但仍依赖外部调度触发和可用的应用/数据库。

## 7. 验证与学习语义

验证的最终结果不是简单的单一布尔值：

- 自动验证根据皇冠参照数据与终盘数据计算方向；
- 无法确定盘口、水位或方向时标记为 invalid/unverified，不进入正确率分母；
- 人工修正优先于自动结果，并保留自动值和人工值；
- 报表和学习读取最终有效验证结果；
- 学习过滤无效、未验证和关注联赛白名单外的记录；
- 动态权重可进入后续规则计算，但版本发布、时间切分和更完整的质量门槛仍需继续完善。

今日赛程保留全部联赛；历史、未来、验证、学习和报表按 `user_focused_leagues` 白名单约束。白名单读取失败的后端流程应 fail-closed，不能扩大样本范围。

## 8. 回测隔离

回测通过 `backtest_jobs` 持久化状态、进度、参数、日志与结果。每次运行携带 `run_id` 和 `source=backtest`：

- 分析结果写 `prediction_results_backtest`；
- 学习模式写 `learned_patterns_backtest`；
- 回测内部来源只接受带 `INTERNAL_API_SECRET` 的调用；
- 线上学习默认读取生产表，不读取回测表。

因此回测不会污染线上预测和学习数据。当前限制是计算仍在应用进程中执行；服务中断后任务记录保留，但不能从精确中间进度自动续跑，且内部流程仍通过本机 HTTP 调用共享 API。

## 9. SSRF 与资源边界

`/api/fetch-url` 同时受管理员认证与 `safe-fetch` 策略保护：

- 仅 HTTPS；
- 仅内建或 `FETCH_URL_ALLOWED_HOSTS` 配置的域名及其子域；
- 禁止 URL 凭据；
- DNS 解析后拒绝私网、回环、链路本地和特殊地址；
- 每次重定向重新校验，最多 3 次；
- 15 秒超时、2 MiB 响应上限和内容类型限制。

## 10. 测试体系

Vitest 覆盖认证、API 保护、SSRF 策略、自动化引擎、分析权重、验证日期、回测限制/任务等。Playwright 配置位于 `playwright.config.ts`，E2E 位于 `tests/e2e/*.e2e.ts`，覆盖：

1. 登录页结构；
2. 未认证敏感 API 返回 401；
3. 首页四个核心导航入口；
4. 管理员登录后仍拒绝 SSRF 回环目标。

E2E webServer 固定绑定 `127.0.0.1:3100`，设置测试专用管理员令牌，不连接真实外部服务。

## 11. 发布摘要

本轮完成 P2-05、P2-06、T-14：清除未使用 AWS SDK、确认并标记孤立批量 API、补齐真实运行和迁移文档、引入可独立启动的 Playwright 最小安全/导航 E2E。没有修改业务 route、`setup-database.sql`、schema 或 `/odds` 页面。
