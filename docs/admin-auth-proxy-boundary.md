# 管理员登录代理信任边界

- 项目受控生产部署使用 `infra/openresty/peilv.conf`，应用仅监听 loopback；该部署必须设置 `ADMIN_TRUST_PROXY=true`。
- OpenResty 直接终止 TLS：80 端口只做 301 跳转，443 使用 `/etc/peilv/tls/fullchain.pem` 与 `/etc/peilv/tls/privkey.pem`，并发送 HSTS。`PEILV_PUBLIC_HOST` 必须设置为证书覆盖的生产域名。
- OpenResty 使用真实 `$remote_addr` 覆盖（而不是透传或追加）`X-Forwarded-For`、`Forwarded` 与 `X-Forwarded-Proto`，并在进入应用前对登录和 bootstrap 执行单 IP rate/connection 限制。
- 其他部署默认保持 `ADMIN_TRUST_PROXY=false`，不得信任客户端代理头，并且必须在平台边缘配置等价的真实来源 IP 限速和并发限制；单独暴露应用端口不受支持。
- 开启后取代理链首个合法 IP。若代理没有清洗客户端头，攻击者可制造来源桶，故不得开启。
- `ADMIN_LOGIN_RATE_LIMIT_SECRET` 必须是稳定的、至少 32 字符的服务端秘密；它只用于 HMAC 限流键，不得暴露给浏览器或复用为密码。
- 数据库全局桶只限制活跃 scrypt reservation，不按未认证请求累计长期全局速率；可信来源桶由受控入口提供第二层来源速率保护。
- `0011`/`0012` 的旧 RPC 可能仍授予 service-role 执行权限，但当前代码只允许使用 `0014` 的 v2 RPC。`0014` 标记为 `codeRollbackSafe=false`，数据库应用后禁止回滚到 `0013` 或更旧代码。

## 内部 API 凭据迁移

1. 将轮换后的32–128位 base64url（仅 `A-Z a-z 0-9 _ -`，可带一个尾部 LF）凭据写入 `/opt/peilv/shared/credentials/internal-api-secret`，所有者 `root:root`、模式 `0600`；父目录链必须 root 所有且不可 group/other 写；不要在命令行或日志中提供值。
2. 从 `/opt/peilv/shared/app.env` 删除 `INTERNAL_API_SECRET`。生产应用不接受仅环境变量配置。
3. 只允许原样安装已验证 release 内的 `infra/systemd/peilv.service`、`peilv-reconcile.service` 与 timer，禁止手工生成或复用宿主旧模板。应用 unit 必须唯一包含 `Environment=HOSTNAME=127.0.0.1`、`Environment=PORT=5000`、`Environment=DEPLOY_RUN_PORT=5000`，同时保留原有 `User`、`Group`、`LoadCredential` 与 hardening；执行 `systemctl daemon-reload` 后必须通过 production preflight 的当前 release/unit 一致性检查才能重启服务。单元通过 `LoadCredential` 提供 `%d/internal-api-secret`。
4. 安装 release 内的 `scripts/lib/curl-secret.sh` 到 `/usr/local/libexec/peilv/curl-secret.sh`，保持 `root:root:0755`。
5. 运行 production preflight，确认 credential 文件、systemd hardening、helper hash 和健康检查均通过。

旧 `INTERNAL_API_SECRET` 曾可能出现在进程环境或命令行中，生产迁移后必须通过秘密管理流程轮换；本文不生成或记录凭据值。

生产自动化仅支持 Linux + systemd credential。Windows 可用于本地开发，但 `start-production.cmd`、dispatch/reconcile PowerShell 在生产模式下会直接失败，不解析 `.env` 中的内部凭据。

候选 release 在晋级前以 `peilv-candidate` 独立用户、无 EnvironmentFile、无 LoadCredential、不可访问 shared、只读 release 的 transient unit 运行，只探测 `/`、`/login` 和无密钥 `/api/readiness`。候选通过并停止后，部署事务才安装其 OpenResty 模板、root-owned helper 和 systemd units，再切换 symlink并以正式 credential unit 启动。

正式服务使用独立用户 `peilv-app`、`peilv-reconcile`、`peilv-dispatch`；健康探针使用 `peilv-probe`，候选使用 `peilv-candidate`。这些用户仅加入 `peilv` 只读代码组，各自只有独立 RuntimeDirectory 可写。轮换脚本当前只支持 `--dry-run`，真实轮换属于高危生产操作，必须另行明确批准。
