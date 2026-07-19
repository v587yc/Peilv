# 实时赔率监控系统

基于 Next.js 16、React 19、TypeScript、Supabase PostgreSQL 的足球赔率监控与分析系统。首页 `/` 提供统一导航，核心页面包括 `/odds`、`/test-ai`、`/backtest`、`/memory`，管理员登录页为 `/login`。

## 运行要求

- Node.js 20+
- pnpm 9+
- Supabase/PostgreSQL（业务功能需要；首页、登录和最小 E2E 不依赖真实数据库或外部赔率服务）

## 安装与运行

### 一期服务边界与端口

- 本地 Web 开发端口：`1802`。
- 独立 Worker 内部端口：`2802`，仅用于首期后台任务进程的内部通信，不作为浏览器公开入口。
- 生产端口继续兼容现有 `5000`（正式实例）/`5001`（候选实例）约定，本期不改动生产切换流程。
- 首期架构仍是现有 Next.js Web/API 加独立 Worker，并非全量前后端拆仓。`project/frontend`、`project/backend` 仅保留为项目结构边界，本期正式代码继续按现有 Next.js 目录组织。
- 策略实验室一期先接入确定性的规则 A/B 与兼容适配契约。规则 C 的完整执行延期：缺少任一关键字段时必须直接执行同一份规则 A；若 A 所需数据也不足则返回数据不足。关键字段完整但没有显式注入 C 执行器时必须返回 `unavailable`，不得生成或伪造 C 的推荐结果。

以上端口均为非敏感运行配置；账号、密码、令牌和数据库密钥不得写入 README 或提交到仓库。

```bash
pnpm install
PORT=1802 pnpm dev
```

本地开发地址为 `http://localhost:1802`。生产构建与启动仍保留现有 `5000/5001` 兼容约定：

```bash
pnpm build
pnpm start
```

质量检查：

```bash
pnpm test
pnpm ts-check
pnpm lint
pnpm build
pnpm test:e2e:install   # 首次安装 Chromium
pnpm test:e2e
```

Playwright 使用 `playwright.config.ts` 在 `127.0.0.1:3100` 启动独立生产构建服务器（因此先执行 `pnpm build`），不复用 5000 端口，也不要求真实 Supabase、LLM 或 titan007 服务。

## 自动化发布

推送到 GitHub 会运行 `.github/workflows/ci.yml`，自动完成单元测试、类型检查、ESLint、生产构建、Playwright E2E 和无密钥发布包检查。CI 不读取生产环境变量，也不会修改生产服务器。

生产发布改为两个手动按钮，避免没有 GitHub Environment 审批功能时误发布：

1. 先运行 `Production preflight`：只构建发布包并只读检查服务器，绝不修改生产环境。完成后在 Summary 里查看 `Release ID`、`Release SHA-256`、当前版本、回退版本和待执行迁移。
2. 确认预检没问题后，再运行 `Deploy approved production`：把上一步 Summary 里的 `Release ID` 和 `Release SHA-256` 填进去，才会真正上传、备份、迁移、5001 候选检查并原子切换。

详细约束和回滚步骤以 `PRODUCTION_DEPLOYMENT.md` 为准。

本地验证发布包：

```bash
pnpm build
release_id="$(date -u +%Y%m%dT%H%M%SZ)"
bash scripts/create-release.sh "$release_id"
bash scripts/verify-release.sh \
  "release-artifacts/peilv-$release_id.tar.gz" \
  "release-artifacts/peilv-$release_id.tar.gz.sha256"
```

不得使用 `scripts/create-distribution.ps1` 制作生产包，因为该脚本面向旧的本地分发流程并包含根目录 `.env`。

## 环境变量

### 数据库

| 变量 | 要求 | 说明 |
|---|---|---|
| `COZE_SUPABASE_URL` | 业务运行必需 | Supabase 项目 URL。 |
| `COZE_SUPABASE_ANON_KEY` | 业务运行必需 | Supabase anon key。 |
| `COZE_SUPABASE_SERVICE_ROLE_KEY` | 服务端部署建议 | 服务端数据库写入使用；必须仅保存在服务端。 |

### 认证与后台任务

| 变量 | 要求 | 说明 |
|---|---|---|
| `ADMIN_BOOTSTRAP_TOKEN` | 仅首次初始化临时必需 | 高熵一次性 secret，只供本机 `pnpm admin:bootstrap` 调用 bootstrap API；首位管理员创建后必须从运行环境删除并重启。不得放入网页、argv、日志或仓库。 |
| `ADMIN_LOGIN_RATE_LIMIT_SECRET` | 必需 | 管理员登录限流键的服务端 secret；只检查是否存在，不记录值。 |
| `ADMIN_TRUST_PROXY` | 可选，默认关闭 | 只有值严格为 `true` 才信任代理来源头；开启前必须落实并保留 `docs/admin-auth-proxy-boundary.md` 描述的受控代理边界。未设置或其他值时不信任代理头。 |
| `ADMIN_API_TOKEN` | 仅旧版恢复兼容 | 不是普通登录密码。账号体系初始化后，`/login` 只接受管理员账号和密码；不要继续把旧 token 分发给用户。 |
| `INTERNAL_API_SECRET_FILE` | 本地开发可选 | 指向32–128位 base64url（`A-Z a-z 0-9 _ -`）凭据文件。Linux生产不从环境变量读取密钥，而由 systemd `LoadCredential` 提供 `%d/internal-api-secret`；Windows生产自动化不受支持。 |
| `PORT` | 可选 | 默认 `5000`。 |
| `HOSTNAME` | 可选 | 默认 `localhost`。 |
| `COZE_PROJECT_ENV` | 可选 | 标识开发或生产运行环境；生产源码不加载 React Inspector。 |

开发期组件定位工具必须通过仓库外的浏览器扩展或本地编辑器工具链启用，不得静态导入根 layout，也不得加入 production standalone 依赖闭包。

### AI、搜索、通知和抓取

- `LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`
- `SEARCH_API_KEY`、`SEARCH_BASE_URL`
- `FEISHU_WEBHOOK_URL`
- `FETCH_URL_ALLOWED_HOSTS`：`/api/fetch-url` 的额外 HTTPS 域名白名单，逗号分隔；仍会拒绝凭据、私网地址和不安全重定向。
- `ADMIN_OUTBOUND_ALLOWED_HOSTS`：管理员明确审批的额外出站域名，逗号分隔；精确域名直接填写，仅需允许子域时使用 `*.example.invalid`。自建 OpenAI 兼容或搜索端点必须先在此处授权，数据库中已有 URL 不会自动成为可信域。
- `ADMIN_OUTBOUND_ALLOWED_PORTS`：经管理员明确审批的额外 HTTPS 端口，逗号分隔；未配置时仅允许标准 443 端口。

LLM、搜索和飞书配置可存于 `app_settings`，环境变量作为回退。所有地址必须使用 HTTPS，禁止 userinfo、fragment、IP 字面量和未授权端口；保存时执行静态域名策略，连接测试及实际调用会校验 DNS 返回的全部 A/AAAA 地址、固定本次连接解析结果，并逐跳复验重定向。管理员设置 API、回测、写接口和高成本分析接口由 `src/proxy.ts` 统一保护。

### 构建与运行环境契约

- `pnpm build` 不读取项目根目录 `.env*` 作为生产打包配置。构建脚本会在 Next 构建前把这些文件原子隔离到工作区外、同卷的受限临时目录，并在成功、失败或收到信号时恢复；文件内容不会被读取、打印、修改或加入 Git。
- `.next/standalone` 和 release 制品禁止包含任何 `.env*`。构建与 `create-release.sh` 均采用 fail closed 检查，不以事后删除掩盖泄漏。
- 生产运行时非敏感配置只由 systemd `EnvironmentFile=/opt/peilv/shared/app.env` 注入；内部 secret 只由 `LoadCredential` 注入，release 本身不携带运行配置或凭据。
- `infra/systemd/peilv.service` 固定且唯一声明 `HOSTNAME=127.0.0.1`、`PORT=5000`、`DEPLOY_RUN_PORT=5000`。release 验证、preflight 与 deploy 会对缺失、重复、旧值和已安装 unit 漂移 fail closed；候选运行由隔离 lifecycle 显式覆盖为 `5001`。
- 只有明确设计为浏览器公开配置的 `NEXT_PUBLIC_*` 才允许进入客户端 bundle。secret 和服务端配置不得改名为 `NEXT_PUBLIC_*`，也不得通过 `next.config` 的 `env` 烘焙。

## 数据库初始化与迁移

### 首位超级管理员

完成数据库迁移并启动应用后，`GET /api/auth/session` 在没有管理员账号时返回 `initialized:false`。公网 `/login` 只显示“尚未初始化”、本机操作说明和重新检查按钮，不提供 bootstrap token 输入框，也不会继续普通登录。

在应用服务器的受信任终端执行：

```bash
node ./scripts/admin-bootstrap.mjs
```

CLI 不接受命令行参数。token 优先从受保护的 `ADMIN_BOOTSTRAP_TOKEN` 环境读取，也支持 TTY 隐藏输入；账号和显示名交互读取，密码隐藏读取且不回显。若应用并非监听 `http://127.0.0.1:5000`，可设置只含 origin、无凭据/查询/片段的 `ADMIN_BOOTSTRAP_BASE_URL`。默认只允许 HTTP(S) loopback；非本机仅允许 HTTPS，并需显式设置 `ADMIN_BOOTSTRAP_ALLOW_REMOTE_HTTPS=true` 确认已建立受控安全边界。初始化成功后立即从运行环境移除 bootstrap token 并重启应用，再用账号密码登录。旧 `ADMIN_API_TOKEN` 不能作为普通登录密码；文档和命令中不得写入真实 secret。

### 新数据库

在 Supabase SQL Editor 或 `psql` 中执行：

```text
setup-database.sql
```

该脚本建立当前完整基线，包括业务表、生产/回测隔离表、后台任务表、审计表、赔率快照和数据质量表，并记录迁移版本。

### 已有数据库升级

先备份数据库，再按编号执行：

```text
migrations/0001_production_baseline.sql
migrations/0002_match_odds_freshness.sql
migrations/0003_prediction_analyzed_at.sql
migrations/0004_prediction_verification_columns.sql
migrations/0005_match_t30_analysis.sql
migrations/0006_market_settlement_evidence.sql
migrations/0007_weighted_learning_samples.sql
migrations/0008_management_command_receipts.sql
migrations/0009_admin_identity.sql
migrations/0010_admin_identity_guardrails.sql
migrations/0011_admin_login_rate_limit.sql
migrations/0012_admin_login_reservations.sql
migrations/0013_admin_user_optimistic_concurrency.sql
migrations/0014_admin_login_uniform_reservations.sql
migrations/0015_admin_lifecycle_strong_audit.sql
migrations/0016_atomic_backtest_claim.sql
migrations/0017_management_command_recovery_states.sql
migrations/0018_command_audit_and_backtest_leases.sql
migrations/0019_backtest_owner_fenced_persistence.sql
migrations/0020_strategy_lab_fact_model.sql
migrations/0021_strategy_lab_policy_and_artifacts.sql
migrations/0022_strategy_lab_snapshot_provider.sql
migrations/0023_strategy_lab_trusted_settlement.sql
migrations/0024_automation_task_idempotent_ensure.sql
```

迁移不会由应用启动过程自动执行。必须以 `migrations/manifest.json` 为唯一顺序和校验依据，按编号执行至当前最新版本 `0024_automation_task_idempotent_ensure`，并检查 `schema_migrations` 已记录全部已执行版本。管理员账号、持久会话与 RBAC 依赖 `0009_admin_identity.sql`；`0010` 增加首位超级管理员及权限护栏；`0011` 增加持久登录限流；`0012` 用原子、有界 reservation 替代 check-record 竞态窗口；`0013` 为管理员变更增加基于 `updated_at` 前置条件的乐观并发控制（OCC）。`0014`–`0019` 继续收紧登录、生命周期审计、回测 claim、命令恢复、命令审计和 owner fence；`0020`–`0023` 建立 Strategy Lab 事实模型、策略制品、快照 provider 和 trusted settlement；`0024` 提供自动化任务原子幂等 ensure RPC。

回滚边界必须以 manifest 中的 `codeRollbackSafe` 为准：当前 `0001_production_baseline.sql` 以及 `0014`–`0019` 标记为 `codeRollbackSafe=false`；`0024_automation_task_idempotent_ensure.sql` 标记为 `true`，仅表示新增 RPC 与 schema 向后兼容，不表示数据库可降级。0024 发布前的旧代码仍会使用 `insert/catch 23505/select`，回退旧代码可能恢复 duplicate-key 日志，因此应在应用 RPC 已部署并验证后再使用该兼容标记。只能回退到通过 release manifest 兼容性检查、且与已应用 schema 相容的代码 release。数据库只执行前向迁移，不做页面级或脚本级降级。

Strategy Lab 的通用 migration/setup 只建立并强制默认拒绝的 RLS，不创建托管环境可能禁止创建的 LOGIN 角色。具备 `CREATEROLE`/对象所有权的受控环境需单独执行 `infra/local-data/sql/strategy-lab-roles.sql`；该脚本只创建无密码的 `NOLOGIN` 分组角色并安装最小 ACL/policy。运行时 LOGIN 必须由部署 secret 工具预创建，再仅授予 `strategy_lab_writer`（或只读场景的 `strategy_lab_reader`），禁止使用 `strategy_lab_owner`、超级用户或 `BYPASSRLS` DSN。当前 policy 的 `USING (true)` 边界仅适用于单租户 Strategy Lab，并且只绑定专用角色。

迁移是非破坏性基线：补字段、统一 `YYYYMMDD` 日期、将重复数据归档到 `migration_duplicate_archive`、确定性保留最新记录，再创建唯一约束与索引。生产执行后应检查 `schema_migrations` 和归档表，并确认 manifest 中所有迁移文件的 SHA-256；真实历史数据清理仍必须在目标数据库上验证。

不要把 `disable-rls.sql` 当作常规迁移。生产环境应配置明确的 RLS 策略或仅由受控服务端使用 service-role key。

## 后台调度

调度状态持久化在 `automation_tasks` 与 `automation_task_steps`，包含幂等键、步骤状态、租约锁、重试次数和错误信息。北京时间计划为：

| 时间 | 任务 |
|---|---|
| 12:02 | 抓取当日赔率 |
| 12:10 | 抓取皇冠快照 |
| 12:15 | 执行 AI 分析 |
| 02:00 | 验证昨日结果 → 学习 → 生成报表 |

生产分析保存成功后会立即按比赛 ID 幂等创建或更新赛前 30 分钟任务；回测不会创建生产任务。调度与修复任务通过 systemd credential 文件读取内部凭据并调用受保护接口，凭据不进入进程环境或命令行。浏览器关闭不影响后台任务。

## 验证、学习与回测隔离

- 自动验证区分有效、无效和未验证数据；缺少盘口或水位的数据不进入准确率分母。
- 人工验证优先于自动结果，学习读取最终有效结果并排除无效/未验证样本。
- 学习仅使用关注联赛白名单内的有效样本，并将模式写入 `learned_patterns`。
- 回测任务持久化在 `backtest_jobs`；预测和学习分别写入 `prediction_results_backtest`、`learned_patterns_backtest`，并携带 `source=backtest`/`run_id`，不会写入线上学习表。
- 回测仍由应用进程执行；任务状态可查询，但进程中断后的计算不会从中间进度自动续跑。

## API 遗留检查

AWS S3 存储已被数据库替代，项目中没有 AWS SDK import，因此已移除 `@aws-sdk/client-s3` 与 `@aws-sdk/lib-storage`。

`GET /api/data/matches` 经全项目静态搜索没有业务调用者；当前页面批量抓取使用单场 `/api/data/match/[id]`。为遵守“不删除仍可能被外部客户端调用的 API”和本轮不修改业务 route 的约束，本次将其标记为孤立、待弃用候选而未删除。删除前应先确认部署访问日志和外部集成，并完成一个发布周期的弃用公告。

## 发布说明（P2-05 / P2-06 / T-14）

- 移除实际未使用的 AWS SDK 依赖并更新锁文件。
- 核验 `/api/data/matches` 为仓库内孤立 API，保留并记录安全下线条件。
- 重写 README 与项目说明，准确记录迁移、认证、后台调度、验证学习、回测隔离和运行命令。
- 增加 Playwright Chromium E2E 配置，覆盖登录页、未认证敏感 API、首页导航和已认证后的 SSRF 拒绝；测试不访问真实外部服务。
