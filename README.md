# 实时赔率监控系统

基于 Next.js 16、React 19、TypeScript、Supabase PostgreSQL 的足球赔率监控与分析系统。首页 `/` 提供统一导航，核心页面包括 `/odds`、`/test-ai`、`/backtest`、`/memory`，管理员登录页为 `/login`。

## 运行要求

- Node.js 20+
- pnpm 9+
- Supabase/PostgreSQL（业务功能需要；首页、登录和最小 E2E 不依赖真实数据库或外部赔率服务）

## 安装与运行

```bash
pnpm install
pnpm dev
```

默认地址为 `http://localhost:5000`。生产构建与启动：

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
| `ADMIN_API_TOKEN` | 受保护 API 必需 | `/login` 使用的管理员令牌，也是 12 小时 HttpOnly 会话的签名密钥；未配置时受保护接口返回 503。 |
| `INTERNAL_API_SECRET` | 后台调度必需 | 调度分发器与内部业务调用使用的 `x-internal-api-secret`，必须与外部 cron 调用方一致且不得暴露给浏览器。 |
| `PORT` | 可选 | 默认 `5000`。 |
| `HOSTNAME` | 可选 | 默认 `localhost`。 |
| `COZE_PROJECT_ENV` | 可选 | `DEV` 启用开发 Inspector，`PROD` 使用生产模式。 |

### AI、搜索、通知和抓取

- `LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`
- `SEARCH_API_KEY`、`SEARCH_BASE_URL`
- `FEISHU_WEBHOOK_URL`
- `FETCH_URL_ALLOWED_HOSTS`：`/api/fetch-url` 的额外 HTTPS 域名白名单，逗号分隔；仍会拒绝凭据、私网地址和不安全重定向。

LLM、搜索和飞书配置可存于 `app_settings`，环境变量作为回退。管理员设置 API、回测、写接口和高成本分析接口由 `src/proxy.ts` 统一保护。

## 数据库初始化与迁移

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
```

迁移不会由应用启动过程自动执行。必须按编号全部执行，并检查 `schema_migrations` 已记录对应版本；`0004_prediction_verification_columns.sql` 用于补齐旧库的预测验证字段（包括 `prediction_results.auto_is_correct`）。

迁移是非破坏性基线：补字段、统一 `YYYYMMDD` 日期、将重复数据归档到 `migration_duplicate_archive`、确定性保留最新记录，再创建唯一约束与索引。生产执行后应检查 `schema_migrations` 和归档表；真实历史数据清理仍必须在目标数据库上验证。

不要把 `disable-rls.sql` 当作常规迁移。生产环境应配置明确的 RLS 策略或仅由受控服务端使用 service-role key。

## 后台调度

调度状态持久化在 `automation_tasks` 与 `automation_task_steps`，包含幂等键、步骤状态、租约锁、重试次数和错误信息。北京时间计划为：

| 时间 | 任务 |
|---|---|
| 12:02 | 抓取当日赔率 |
| 12:10 | 抓取皇冠快照 |
| 12:15 | 执行 AI 分析 |
| 02:00 | 验证昨日结果 → 学习 → 生成报表 |

生产分析保存成功后会立即按比赛 ID 幂等创建或更新赛前 30 分钟任务；回测不会创建生产任务。每分钟调度只补建固定日任务并执行已到期队列，部署平台应每分钟向 `POST /api/automation/dispatch` 发送 `x-internal-api-secret`。另由独立计划任务每 15 分钟调用 `POST /api/automation/reconcile`，用于修复瞬时漏建、历史预测和仍处于 pending 状态的开赛时间变化。两个接口都只接受 `INTERNAL_API_SECRET`，浏览器关闭不影响后台任务。

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
