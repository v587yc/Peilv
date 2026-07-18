# Linux Candidate P0 隔离验收契约

## 结论

该脚本只供专用 Linux 沙箱主机人工执行。本次交付只准备资源，不连接服务器、不创建 unit/mount/loop，也不调用生产部署、回滚或预检命令。

## 强制门禁

必须同时满足：

1. `PEILV_LINUX_P0_SANDBOX_ONLY=1`。
2. 人工参数 `--isolated-host-ack`。
3. root、Linux、systemd、cgroup v2。
4. 根目录仅允许 `mktemp -d /var/lib/peilv-test-XXXXXXXX`；或 `--root-mode=loopback` 使用 `/tmp/peilv-test-<随机>.img` 独立 ext4。
5. unit 仅允许 `peilv-p0-test-<随机>.service`。
6. 在任何动态资源创建前静态扫描脚本自身，拒绝生产 unit/timer、代理、数据库和应用状态路径标识。
7. unique unit 的 `LoadState` 必须在创建 sandbox 前有可靠不存在证据：规范化后的单行值为 `not-found`；或命令明确以 4 退出且值为空。`loaded`、`masked`、`error`、`bad-setting`、`stub`、`merged` 等任何非 `not-found` 状态，以及其他空值、异常退出、乱码、多行输出全部 fail closed。

缺少任一门禁时，输出 JSONL `FAIL` 并非零退出。`--help` 只显示帮助。

## 隔离与清理

- 所有可变资源位于唯一 sandbox root。
- rollback 使用 fixture；“正式命令”只是 sandbox 内计数器。
- `EXIT/HUP/INT/TERM` trap 仅清理已记录且通过名称边界校验的唯一 unit、子 mount、loop device、loop image、临时根。
- 动态流程开始前要求宿主端口 5001 无监听。
- cleanup 失败即拒收，不得把功能 PASS 当作整体通过。

## 覆盖矩阵

| 领域 | 通过标准 |
|---|---|
| PrivateNetwork | host curl 不可达；MainPID `nsenter -n` 可达并返回 `ready=true` |
| systemd/cgroup | PrivateNetwork/PrivateTmp/NNP、MemoryMax、swap、TasksMax、CPUQuota、NOFILE 及 cgroup v2 文件值一致 |
| flock | 事务一持锁时事务二失败；释放后事务二成功 |
| blocks/inodes/quota | 隔离 df/quota fixture 分别触发 fail closed，不消耗宿主容量 |
| rollback 六故障 | stage/enospc/hash/start/readiness/log 每项正式命令计数为 0 |
| preflight | 临时 verified tree 递归清理；失败树原子移入临时 quarantine |
| stubborn lifecycle | TERM 超时；MainPID、私有 5001、busy mount 均阻止提前释放；SIGKILL 后 MainPID=0、端口关闭 |
| 输出 | 每项 JSONL；末行 `PASS|FAIL PASS=n FAIL=n SKIP=n TOTAL=n` |

## 本次静态验证命令

```bash
bash -n tests/linux-candidate-p0-acceptance.sh
bash -n tests/fixtures/linux-p0/mock-rollback-transaction.sh
bash -n tests/fixtures/linux-p0/unit-loadstate-guard.sh
bash -n tests/fixtures/linux-p0/unit-loadstate-guard-matrix.sh
bash tests/fixtures/linux-p0/unit-loadstate-guard-matrix.sh
pnpm exec vitest run tests/linux-candidate-p0-acceptance-contract.test.ts
```

这些命令不运行 Linux 动态验收。

## 将来专用沙箱人工执行（本次不要执行）

```bash
sudo PEILV_LINUX_P0_SANDBOX_ONLY=1 tests/linux-candidate-p0-acceptance.sh --isolated-host-ack --root-mode=varlib
sudo PEILV_LINUX_P0_SANDBOX_ONLY=1 tests/linux-candidate-p0-acceptance.sh --isolated-host-ack --root-mode=loopback
```

## 拒收条件

任一测试 FAIL、cleanup 非 PASS、六故障任一计数非 0、出现非唯一资源、宿主 5001 已占用、缺少逐项 JSONL 或总计不一致，均拒收。
