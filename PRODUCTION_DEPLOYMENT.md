# 生产环境同步手册

本文用于把本地 `D:\wendan\peilv` 的修改安全同步到生产服务器。后续执行同步时以本文为准，不需要重新分析部署拓扑，但仍需做最小只读检查并在修改生产环境前确认。

## 1. 安全规则

- 本文和发布包中禁止保存管理员令牌、SSH 密码、数据库密码、JWT、Service Role Key、内部 API Secret。
- 登录凭据由用户在当前会话中临时提供，只能在内存中使用，不写入脚本、日志、发布包或服务器 release 目录。
- 不得使用当前的 `scripts/create-distribution.ps1` 直接制作生产包，因为它会把根目录 `.env` 加入压缩包。
- 不覆盖 `/opt/peilv/shared/app.env` 或 `/opt/peilv/shared/local-data.env`。
- 不直接修改当前 release。每次发布都创建新的时间戳目录，通过 `current` 软链接切换。
- 数据库只执行尚未登记在 `schema_migrations` 中的前向迁移。
- 上传、暂停调度、停止应用、备份、迁移、切换和重启前，需要向用户报告影响与回退点并取得一次明确确认。
- 不使用 `--no-verify`、强制覆盖、删除旧 release 或删除备份来绕过问题。
- 不在公网 UI、命令行参数、shell history 或日志中收集/传递 `ADMIN_BOOTSTRAP_TOKEN`。

## 2. 已知生产拓扑

| 项目 | 当前约定 |
|---|---|
| 应用目录 | `/opt/peilv` |
| release 目录 | `/opt/peilv/releases/<UTC时间戳>` |
| 当前版本软链接 | `/opt/peilv/current` |
| 共享环境文件 | `/opt/peilv/shared/app.env` |
| 应用服务 | `peilv.service` |
| 自动分发 timer | `peilv-dispatch.timer` |
| 自动修复 timer | `peilv-reconcile.timer` |
| 应用用户/组 | `peilv-app:peilv`；候选为隔离的 `peilv-candidate:peilv-candidate`，且不属于 `peilv` 组 |
| 应用监听端口 | `5000` |
| 候选版本检查端口 | `5001` |
| OpenResty 上游 | `http://127.0.0.1:5000` |
| OpenResty 代理文件 | `/opt/1panel/www/sites/peilv/proxy/root.conf` |
| 数据后端 | `DATA_BACKEND=local` |
| 运行环境 | `COZE_PROJECT_ENV=PROD` |
| PostgreSQL 容器 | `local-data-postgres-1` |
| PostgREST 容器 | `local-data-postgrest-1` |
| 网关容器 | `local-data-gateway-1` |
| 本地数据网关 | `127.0.0.1:54321` |
| PostgreSQL 数据目录 | `/opt/peilv/data/postgres` |
| 数据库备份目录 | `/opt/peilv/backups` |
| Node.js | `/usr/bin/node`，当前为 Node 22 系列 |
| 生产启动 | 仅 `/usr/bin/node server.js`；生产路径禁止 pnpm/npm/npx/yarn/corepack 与 lifecycle |

生产根地址和 SSH/1Panel 登录信息由用户临时提供，不记录在本文。

`peilv.service` 的生产监听契约必须显式且唯一包含 `Environment=HOSTNAME=127.0.0.1`、`Environment=PORT=5000`、`Environment=DEPLOY_RUN_PORT=5000`。release 归档必须复制仓库中的同一模板；verify、preflight 和 deploy 对缺失、重复、`0.0.0.0`、`3000` 或已安装 unit 与当前 release 漂移一律阻断。候选生命周期继续通过隔离的 `env -i` 将三项覆盖为 loopback `5001`，不受生产模板固定端口影响。

## 3. 本地发布前验证

在本地项目根目录执行：

```bash
pnpm exec vitest run
pnpm ts-check
pnpm lint
pnpm build
```

至少必须保证：

1. Vitest 全部通过。
2. TypeScript 无错误。
3. ESLint 无错误。
4. Next.js 生产构建成功。
5. `.next/standalone/server.js`、`.next/BUILD_ID`、`.next/routes-manifest.json`、`.next/static` 和 `public` 齐全。
6. 新增迁移有测试覆盖，且迁移文件可重复注册而不重复写入 `schema_migrations`。
7. 迁移已按照 `migrations/manifest.json` 按序执行至当前最新版本 `0023_strategy_lab_trusted_settlement`，并完成 SQL SHA-256 校验；管理员身份迁移包含 `0009`–`0013`，`0012` 是原子登录 reservation，`0013` 是管理员更新 OCC，`0014`–`0019` 是登录/审计/回测恢复与 owner fence 的强化迁移，`0020`–`0023` 是 Strategy Lab 迁移。旧库不得跳过或乱序执行任何迁移。

若只做紧急热修，可以先运行相关目标测试和 `pnpm ts-check`，但生产构建仍必须执行。

构建环境契约：项目根 `.env*` 仅供本地开发，`scripts/build.sh` 会在 Next 构建期间将其隔离到工作区外、同卷的受限临时目录，并通过 trap 在成功、失败和信号退出时原样恢复。standalone 或 release 中发现任意 `.env*` 均直接失败。生产非敏感配置由 `peilv.service` 的 `EnvironmentFile=/opt/peilv/shared/app.env` 在运行时提供；secret 仅通过 systemd `LoadCredential` 提供。禁止把服务端配置或 secret 改名为 `NEXT_PUBLIC_*` 或写入 `next.config` 的 `env`。

## 4. 无密钥发布包

### 4.1 应包含

- Next standalone 自包含运行树（根 `server.js`、`.next/BUILD_ID`、`.next/routes-manifest.json`、`.next/static`、`public`、追踪依赖）；
- `migrations`；
- 运行所需的 `scripts`；
- release manifest 与 migration manifest；release manifest 的 `files` 数组绑定全部制品文件树 SHA-256，migration manifest 保持仅描述迁移。

### 4.2 必须排除

- `.env`、`.env.*`；
- `infra/local-data/.env`；
- `/opt/peilv/shared` 中的任何生产环境文件；
- `node_modules`；
- `.local-data`；
- `coverage`、`test-results`；
- `server.log` 和其他日志；
- 本地数据库文件；
- 旧压缩包；
- 凭据、Cookie、Token；
- `.next/cache`、`.next/dev`、`.next/diagnostics`。

### 4.3 制品命名

```text
release-artifacts/peilv-<UTC时间戳>.tar.gz
release-artifacts/peilv-<UTC时间戳>.tar.gz.sha256
```

例如：

```text
release-artifacts/peilv-20260712T083500Z.tar.gz
```

### 4.4 制品验证

生成后必须：

1. 列出压缩包成员，确认没有 `.env`。
2. 扫描包内是否包含当前会话提供的管理员令牌、SSH 密码及本地环境变量值。
3. 确认以下文件存在：

```text
.next/BUILD_ID
dist/server.js
package.json
pnpm-lock.yaml
migrations/*.sql
scripts/reconcile-automation.sh
```

4. 计算 SHA-256，上传后在服务器再次计算并比对。

## 5. 发布前只读检查

后续同步不需要重新探索代码，但必须执行以下最小只读检查：

```bash
readlink -f /opt/peilv/current
systemctl is-active peilv.service
systemctl is-active peilv-dispatch.timer
systemctl is-active peilv-reconcile.timer
systemctl list-jobs --no-pager
df -h / /opt
ss -lntp | grep ':5000'
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

检查数据库迁移：

```bash
docker exec local-data-postgres-1 sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -Atc \
  "select version from schema_migrations order by applied_at, version;"'
```

检查受保护健康接口时，使用 root 管理的 `/opt/peilv/shared/credentials/internal-api-secret` 和 `/usr/local/libexec/peilv/curl-secret.sh`。凭据不得进入环境变量、argv 或输出：

```bash
printf 'url = "http://127.0.0.1:5000/api/storage/health"\nfail\nsilent\nshow-error\n' | \
  /usr/local/libexec/peilv/curl-secret.sh /opt/peilv/shared/credentials/internal-api-secret
```

确认：

- 当前 release 路径；
- 应用与 timer 状态；
- 没有运行中的 systemd job；
- 磁盘空间足够；
- 数据库和 PostgREST 健康；
- 待执行迁移列表；
- 上一个 release 可作为代码回退点。
- 必填的 `ADMIN_LOGIN_RATE_LIMIT_SECRET` 已存在（只检查存在性，不输出值）。`ADMIN_TRUST_PROXY` 可不设置；只有严格为 `true` 时，候选 release 必须包含并落实 `docs/admin-auth-proxy-boundary.md` 的受控代理边界。空安装需存在临时 `ADMIN_BOOTSTRAP_TOKEN`；已有管理员时该变量必须为空或已删除。

### 5.1 首次超级管理员启用闭环

数据库迁移必须按 `migrations/manifest.json` 顺序执行至当前最新版本 `0023_strategy_lab_trusted_settlement.sql`，完成迁移登记和校验后再启动应用。其中 `0012` 保证登录尝试 reservation 原子且有界，`0013` 保证管理员并发修改通过 OCC 检测冲突，`0014`–`0019` 提供统一登录 reservation、强审计、原子回测 claim、命令恢复、命令审计、回测租约和 owner fence，`0020`–`0023` 提供 Strategy Lab 的事实模型、策略制品、快照 provider 和 trusted settlement。若 `/api/auth/session` 返回 `initialized:false`，公网登录页只显示未初始化状态，不能在网页输入 bootstrap token。

### 5.2 迁移后的代码回退边界

代码回退必须读取并遵守 `migrations/manifest.json` 的 `codeRollbackSafe`。当前 `0001_production_baseline.sql` 以及 `0014`–`0019` 明确标记为 `codeRollbackSafe=false`；这些迁移应用后，禁止直接回退到 `0013` 或更早的旧代码。只能回退到 release manifest 兼容性检查通过、且与当前已应用 schema 相容的代码 release。该标记只约束代码 release 兼容性，不提供数据库降级能力；数据库只允许前向迁移。任何无法证明兼容性的回退都必须在切换前阻断，并保留当前 release、数据库备份和审计记录。

在当前生产 release 目录、加载受保护环境后执行 `node ./scripts/admin-bootstrap.mjs`。CLI 不接受 argv 参数；账号/显示名交互输入，密码隐藏输入，token 从受保护环境或隐藏输入读取。base URL 默认仅允许本机 loopback；若确需跨主机初始化，只允许 HTTPS，并需显式设置 `ADMIN_BOOTSTRAP_ALLOW_REMOTE_HTTPS=true` 确认受控安全边界，URL 本身不得包含凭据、查询参数或片段。CLI 成功后：

1. 从 `/opt/peilv/shared/app.env` 删除 `ADMIN_BOOTSTRAP_TOKEN`；
2. 重启 `peilv.service`，避免旧进程继续持有 token；
3. 重新访问 `/login`，确认出现账号密码登录并用首位 `super_admin` 登录；
4. 验证 RBAC 页面和 `admin.bootstrap` 审计记录；
5. 确认旧 `ADMIN_API_TOKEN` 无法作为普通账号密码登录。

文档、命令输出和工单均不得记录真实 token、管理员密码或数据库密码。

## 6. 向用户报告并确认

执行任何生产修改前，报告：

- 新 release 目标路径；
- 当前 release 和代码回退路径；
- 待执行迁移；
- 数据库备份路径；
- 受影响的服务与 timer；
- 预计停机时间，通常为 2–5 分钟；
- 回滚方式。

取得明确确认后再继续。

## 7. 上传并准备候选 release

假设：

```bash
RELEASE_ID=<UTC时间戳>
RELEASE_DIR=/opt/peilv/releases/$RELEASE_ID
ARCHIVE=/opt/peilv/releases/.peilv-$RELEASE_ID.tar.gz
```

步骤：

1. 确认目标目录和临时压缩包不存在。
2. 通过 SFTP 上传到 `$ARCHIVE`。
3. 在服务器计算 SHA-256，与本地结果一致后再解压。
4. 创建 `$RELEASE_DIR`。
5. 解压并设置所有者为 `peilv:peilv`。
6. 删除服务器上的临时压缩包。
7. 再次确认 release 中不存在 `.env`。
8. 不安装任何依赖、不触发 lifecycle。做静态运行检查：

```bash
runuser -u peilv-app -- sh -lc \
  "cd '$RELEASE_DIR' && /usr/bin/node --check server.js"
```

上传和安装期间，旧版本继续在 5000 提供服务。

## 8. 暂停写入与数据库备份

停止两个 timer：

```bash
systemctl stop peilv-dispatch.timer peilv-reconcile.timer
```

确认对应 oneshot 服务均为 inactive；如果仍在运行，不得强制终止，先等待任务自然结束：

```bash
systemctl is-active peilv-dispatch.service
systemctl is-active peilv-reconcile.service
```

停止应用，开始停机窗口：

```bash
systemctl stop peilv.service
```

创建 PostgreSQL custom-format 备份。必须先写同目录 `.partial`，校验并 fsync 后再原子发布：

```bash
install -d -o root -g peilv -m 0750 /opt/peilv/backups

docker exec local-data-postgres-1 sh -lc \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "/opt/peilv/backups/peilv-before-$RELEASE_ID.dump.partial"

chmod 0640 "/opt/peilv/backups/peilv-before-$RELEASE_ID.dump.partial"
```

验证备份：

```bash
test -s "/opt/peilv/backups/peilv-before-$RELEASE_ID.dump.partial"
docker exec -i local-data-postgres-1 pg_restore -l \
  < "/opt/peilv/backups/peilv-before-$RELEASE_ID.dump.partial" \
  > /dev/null
sync -f "/opt/peilv/backups/peilv-before-$RELEASE_ID.dump.partial"
mv -T "/opt/peilv/backups/peilv-before-$RELEASE_ID.dump.partial" "/opt/peilv/backups/peilv-before-$RELEASE_ID.dump"
sync -d /opt/peilv/backups
sha256sum "/opt/peilv/backups/peilv-before-$RELEASE_ID.dump"
```

只有备份非空、`pg_restore -l` 成功且 SHA-256 已记录后，才允许迁移。

纯代码热修且无数据库迁移时，可以复用本次发布窗口内刚创建并验证的备份；跨发布窗口不得复用旧备份。

## 9. 执行待应用迁移

逐个比较本地 `migrations/*.sql` 与 `schema_migrations`。只执行未登记版本，按文件名顺序执行：

```bash
docker exec -i local-data-postgres-1 sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -v ON_ERROR_STOP=1' \
  < "$RELEASE_DIR/migrations/<migration>.sql"
```

每个迁移完成后检查：

- `schema_migrations` 已出现该版本；
- 预期表、列、索引和数据类型存在；
- PostgREST 日志显示 schema cache reload 成功；
- 迁移没有处于未提交状态。

查看 PostgREST 日志：

```bash
docker logs --since 5m local-data-postgrest-1
```

迁移失败时停止发布，不切换 release。根据事务状态和错误决定继续使用旧应用，或从已验证备份恢复。

## 10. 候选版本检查

切换前，先把目标 release 复制到磁盘型专用目录 `/var/lib/peilv/candidate-stage/<release-id>`。`/var/lib/peilv/candidate-stage` 必须是非 symlink、非 tmpfs/ramfs、`root:root 0700`，并与 `/opt/peilv/{shared,backups,releases,incoming}` 分离。preflight 和 deploy/rollback 都会按 release 解压后实际占用量检查可用空间，并额外保留 `max(25%, 256 MiB)` 安全余量；空间或父目录契约不满足时，在生产写入、备份、停服务和迁移前阻断。

root 先创建单次 release 目录并复制文件，复制前后计算包含相对路径、类型和文件 SHA-256 的 tree hash；hash 与 release verifier 均通过后，才把目录设置为 `root:peilv-candidate`、目录 `0550`、文件 `0440`。父目录 `0700` 阻止 candidate 枚举其它 release；systemd 仅通过 `BindReadOnlyPaths=/var/lib/peilv/candidate-stage/<release-id>:/srv/peilv-candidate` 精确暴露本次 tree，WorkingDirectory 使用 `/srv/peilv-candidate`。成功、失败或信号退出都只清理经过严格 releaseId 校验的本次目录，candidate staging 不进入部署 WAL，也不参与恢复状态。

候选由 supplementary groups 精确为空的 `peilv-candidate:peilv-candidate` 启动，使用 `env -i`，不加载 EnvironmentFile、credential 或 shared。`PrivateNetwork=yes` 创建独立网络命名空间，候选无法访问宿主 `127.0.0.1`；root 受信 helper 校验 systemd unit Id、MainPID 和 cgroup 后，通过 `nsenter -t <MainPID> -n` 探测候选命名空间内的 `127.0.0.1:5001`。候选同时受 RuntimeMaxSec、MemoryMax、MemorySwapMax=0、TasksMax、CPUQuota、LimitNOFILE、有界 `/tmp`、日志限速、空 capability 集及 kernel/process sandbox 约束。`InaccessiblePaths` 屏蔽 `/etc/peilv`、`/var/lib/peilv`、shared、backups、releases、incoming 和宿主 `/run` 敏感 socket。候选必须在停止 timer/application、备份和迁移之前唯一通过一次：

```bash
systemd-run --unit=peilv-candidate --uid=peilv-candidate --gid=peilv-candidate \
  --working-directory="/srv/peilv-candidate" \
  --property="PrivateNetwork=yes" --property="SupplementaryGroups=" \
  --property="BindReadOnlyPaths=/var/lib/peilv/candidate-stage/<release-id>:/srv/peilv-candidate" \
  --property="InaccessiblePaths=/etc/peilv /var/lib/peilv /opt/peilv/shared /opt/peilv/backups /opt/peilv/releases /opt/peilv/incoming /run/docker.sock /run/systemd/private /run/postgresql" \
  --property="RuntimeDirectory=peilv" --property="RuntimeDirectoryMode=0700" \
  --property="NoNewPrivileges=true" --property="ProtectProc=invisible" --property="ProcSubset=pid" \
  --property="IPAddressDeny=any" --property="IPAddressAllow=localhost" \
  /usr/bin/env -i NODE_ENV=production HOSTNAME=127.0.0.1 PORT=5001 DEPLOY_RUN_PORT=5001 \
  /usr/bin/node server.js
```

检查：

```bash
PID="$(systemctl show peilv-candidate-<release-id>.service -p MainPID --value)"
nsenter -t "$PID" -n -- curl -fsS http://127.0.0.1:5001/api/readiness
```

候选 readiness 只验证进程与 build 完整性，不访问数据库/schema，也不交付内部凭据。正式切换后才使用固定 host helper `/usr/local/libexec/peilv/curl-secret.sh` 做可信 `/api/storage/health` probe，验证数据库与 schema。

确认候选日志没有 error、exception 或 fatal 后，由共享 lifecycle helper 执行 stop、有界等待、必要时 SIGKILL，再确认 unit inactive、MainPID=0、固定网络命名空间中 5001 消失且 bind 已释放。任一证明失败都阻断事务并保留 stage，不得清理。

deploy、rollback 与 preflight 共用 `/run/lock/peilv-deploy.lock`。任何 private archive、verified tree、release、candidate、DB backup 或 systemd transaction 写入前，按底层 device 聚合峰值 blocks 与 inodes并加入安全余量；数据库无法在线估算时必须显式提供保守的 `PEILV_DB_BACKUP_ESTIMATE_KIB`。事务备份与 quarantine 的 GC 也必须持有该锁，至少保留最近一次成功事务恢复材料，并跳过 current、WAL 引用、rollback 候选和 quarantine。失败且从未激活的 release 移入 `/opt/peilv/quarantine`，不得作为 rollback 候选。

## 11. 原子切换正式版本

```bash
ln -s "$RELEASE_DIR" /opt/peilv/current.next
mv -Tf /opt/peilv/current.next /opt/peilv/current
systemctl start peilv.service
```

确认：

```bash
readlink -f /opt/peilv/current
systemctl is-active peilv.service
ss -lntp | grep ':5000'
curl -fsS http://127.0.0.1:5000/
curl -fsS http://127.0.0.1:5000/odds
```

如果新服务无法启动，立即把 `current` 原子切回旧 release 并启动 `peilv.service`。

## 12. 恢复自动化

先验证 reconcile：

```bash
systemctl start peilv-reconcile.service
systemctl show peilv-reconcile.service -p Result --value
journalctl -u peilv-reconcile.service -n 30 --no-pager
systemctl start peilv-reconcile.timer
```

成功后再验证 dispatch：

```bash
systemctl start peilv-dispatch.service
systemctl show peilv-dispatch.service -p Result --value
journalctl -u peilv-dispatch.service -n 30 --no-pager
systemctl start peilv-dispatch.timer
```

最终确认：

```bash
systemctl is-active peilv.service
systemctl is-active peilv-reconcile.timer
systemctl is-active peilv-dispatch.timer
systemctl list-timers peilv-reconcile.timer peilv-dispatch.timer --no-pager
```

## 13. 发布后验证

### 13.1 基础检查

- 生产首页 HTTP 200；
- `/odds` HTTP 200；
- 管理员登录成功；
- `/api/storage/health` 返回 `success: true`；
- `schemaVersion` 等于最新迁移；
- 5000 端口由新 Node 进程监听；
- `current` 指向新 release；
- 应用、dispatch、reconcile 均正常；
- 最近日志无 warning/error。

### 13.2 双市场功能检查

- 验证 API 返回独立的 `markets.handicap` 与 `markets.total`；
- 返回独立的 `stats.markets.handicap` 与 `stats.markets.total`；
- 报表 summary 包含两个市场；
- 让球和进球人工验证按钮互不影响；
- 撤回人工验证后只恢复对应市场的自动结果；
- 四分之一盘口能显示 win、half_win、push、half_loss、loss；
- 半赢按 0.5 正确、半输按 0.5 错误；
- LLM 的 accuracy 显示为“模型自评”；
- 概率与 EV 使用服务端确定性输出，不接受 LLM 覆盖；
- 数据不足时显示不可用，不生成虚假概率。

### 13.3 官方赛果闭环

生产自动化的 `verify-learn-report` 步骤必须按以下顺序执行：

1. `/api/schedule?date=<date>&mode=history`；
2. 将官方赛果写入 `match_results`；
3. `/api/analysis/verify` 双市场结算；
4. handicap/total 分别学习；
5. 生成报表。

已知外部限制：Titan history 端点曾出现 `success=true` 但返回 0 场，而 future 端点正常返回大量比赛。遇到该状态时必须保持预测为 pending，不得伪造赛果或准确率。该问题应单独排查历史页面语义、响应内容、编码、反爬或解析规则。

## 13.1 systemd 用户与凭据边界

生产主机需预先创建共享只读代码组 `peilv`，以及互不复用的系统用户 `peilv-app`、`peilv-reconcile`、`peilv-dispatch`、`peilv-candidate`、`peilv-probe`。应用、reconcile、dispatch、probe 按需属于 `peilv` 组；`peilv-candidate` 只能拥有同名主组且不得有任何 supplementary group。release 目录保持 `peilv:peilv:0750`；每个服务只能写自己的 systemd `RuntimeDirectory`，不得写 release 或 shared。账户创建属于主机高权限操作，应由基础设施审批流程执行，本仓库脚本不会自动创建用户。

安装 release 内的 app、reconcile、dispatch service/timer 后执行 `systemctl daemon-reload`。production preflight 会核对实际 unit hash、独立用户、组成员关系、LoadCredential 与 sandbox 属性。

内部凭据轮换脚本 `scripts/rotate-internal-secret.sh` 当前只支持 `--dry-run`，仅检查前置条件并输出不含值的原子轮换计划；真实写入、fsync/rename、重启消费者及旧凭据失效验证属于高危操作，必须另行明确批准，本任务未执行。

## 14. 回滚

### 14.1 只回滚代码

适用于数据库迁移保持向前兼容的情况：

1. 停止 dispatch/reconcile timer；
2. 确认无运行中任务；
3. 停止 `peilv.service`；
4. 把 `/opt/peilv/current` 原子切回旧 release；
5. 启动 `peilv.service`；
6. 验证健康；
7. 按 reconcile → dispatch 顺序恢复 timer。

### 14.2 回滚数据库

仅在迁移造成不可接受的数据或兼容性问题时执行：

1. 保持应用和 timer 停止；
2. 再备份一次故障现场数据库；
3. 使用发布前 custom-format 备份恢复；
4. 验证迁移版本、关键表和记录数；
5. 切回对应旧 release；
6. 启动并验证应用；
7. 恢复 timer。

数据库恢复是高影响操作，必须单独取得用户确认。

## 15. 不应执行的操作

- 不把本地 `.env` 上传到服务器；
- 不把生产 `.env` 下载进 release 或提交到代码库；
- 不在环境变量、argv 或命令输出中承载内部 API 凭据、管理员令牌或数据库密码；生产凭据由 systemd `LoadCredential` 提供。
- 不直接覆盖 `/opt/peilv/current` 目录内容；
- 不删除旧 release 来腾空间后再发布；
- 不在备份未验证前执行迁移；
- 不在 timer 或 oneshot 任务运行中强制切换；
- 不只更新代码而遗漏迁移；
- 不只迁移数据库而继续运行依赖旧 schema 的代码；
- 不因为历史源为空而把 pending 记录标为错误；
- 不修改 OpenResty 代理，除非本次需求明确要求修改端口或域名。

## 16. 下次直接给 Claude 的指令

可直接使用以下文本：

```text
请按照项目根目录 PRODUCTION_DEPLOYMENT.md 把本地修改同步到生产服务器。
不要重新分析部署拓扑，先执行文档中的最小只读检查、本地测试和无密钥制品检查。
向我报告新 release、当前回退 release、待执行迁移、数据库备份路径和预计停机时间；取得一次确认后，按文档完成上传、备份、迁移、5001 候选检查、原子切换、reconcile/dispatch 恢复和发布后验证。
不得上传或覆盖任何 .env，不得打印凭据，不得删除旧 release 或备份。
如果 Titan history 返回 0 场，保持赛果 pending 并单独报告，不得伪造准确率。
```

用户仍需在该会话中临时提供或授权使用：

- SSH 登录信息；
- 生产管理员令牌；
- 必要时的 1Panel 登录信息。

不要把这些值追加到本文。

## 17. GitHub Actions 自动发布

仓库包含两条工作流：

- `.github/workflows/ci.yml`：每次 push/PR 自动运行测试、类型检查、ESLint、生产构建、Playwright E2E 和无密钥制品验证；不会连接生产服务器。
- `.github/workflows/production-preflight.yml`：仅允许手动触发，只构建候选制品并只读检查服务器；不会上传制品到生产目录，也不会停止服务、备份、迁移或切换。
- `.github/workflows/deploy-approved-production.yml`：仅允许手动触发；用户把预检 Summary 中的 `Release ID` 与 `Release SHA-256` 填入后，才执行上传和生产发布。

自动发布仍以本文第 1–15 节为约束：

1. `scripts/create-release.sh` 使用白名单生成制品，替代禁止用于生产的 `scripts/create-distribution.ps1`。
2. `scripts/verify-release.sh` 在 GitHub runner 和服务器分别校验 SHA-256、成员白名单、必需文件和凭据特征。
3. `scripts/production-preflight.sh` 执行第 5 节只读检查，并在 GitHub Job Summary 中报告第 6 节要求的信息。
4. `scripts/deploy-production.sh` 在审批后执行第 7–12 节的自动化基线检查；第 13.2–13.3 节的双市场与官方赛果闭环仍需在发布后单独验证。新服务启动失败时只自动切回旧 release，不自动恢复数据库；迁移执行中失败时保持应用与 timer 停止，等待数据库评估。
5. 数据库恢复始终按照第 14.2 节单独确认后人工执行。

GitHub 配置：

- Repository Secrets：`PROD_HOST`、`PROD_PORT`、`PROD_AUDIT_USER`、`PROD_AUDIT_SSH_KEY`、`PROD_SSH_HOST_KEY`、`PROD_DEPLOY_USER`、`PROD_DEPLOY_SSH_KEY`。
- 不依赖 GitHub Environment 审批；生产发布由“先运行 `Production preflight`，再手动复制 `Release ID` 与 `Release SHA-256` 运行 `Deploy approved production`”完成。
- 生产部署设置并发锁，同一时间只能运行一个发布。

服务器使用 `peilv-audit` 与 `peilv-deploy` 两个专用 SSH 账号，通过 root-owned `/usr/local/sbin/peilv-control` 进入固定预检或部署命令。GitHub 不保存 root 密码、1Panel 密码、管理员令牌、数据库密码或共享环境文件内容。
