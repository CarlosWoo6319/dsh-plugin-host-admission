# 安装与验证 / Install & verify

预览版只支持**本地目录安装**。顺序不能反：先生成 patch，再安装该目录。

## 0. 前置检查

```sh
node --version            # ≥ 20
```

- DSH 桌面版 `≥ 0.2.1-rc.2`（需要 `sandboxPolicy` / `sandbox.confine` / `subprocess` 控制通道）
- 一个实现 [host-contract.md](host-contract.md) 的可执行 Host

## 1. 固定目录

```sh
git clone https://github.com/CarlosWoo6319/dsh-plugin-host-admission.git \
  "$HOME/Library/Application Support/dsh-bundles/host-admission"
```

要点：

- 目录**不要移动或删除**，安装记录会指向它；要升级就换新目录重装。
- 仓库里没有 `cordis.patch.yml`（它含本机绝对路径，已被 `.gitignore` 忽略），所以此时还不能安装。

## 2. 生成机器专属 patch

```sh
cd "$HOME/Library/Application Support/dsh-bundles/host-admission"
node scripts/prepare.mjs \
  --host "/absolute/path/to/your-admission-host" \
  --artifacts "$HOME/Library/Application Support/dsh-bundles/host-admission-calls"
```

脚本做四件事：校验 Host 可执行、创建证据目录、把模板填成本机路径、写出 `cordis.patch.yml`。
它不写 DSH profile，不启动或停止任何任务。默认目标目录就是当前仓库，`--bundle-dir` 只在需要时覆盖。

## 3. 安装与启用

1. 在 DSH 插件页把该目录作为本地 bundle 安装；
2. 重载后出现预设 **本机任务准入**；
3. **新建**会话（已用会话保留创建时的预设），在**首个 Turn 之前**选择该预设；
4. 确认会话里能看到工具 `host_run`。

## 4. A–E 五步验证

| 步骤 | 做什么 | 通过标准 |
|---|---|---|
| A | 正常调用：`argv=["node","-e","console.log(1)"]`，`seconds=20` | `settlement=RELEASED`，`stdout` 含 `1`，`receipt_saved=true` |
| B | 越界写入：payload 尝试写工作区外路径 | 被原生沙箱拒绝（node 侧表现为 `EACCES`/`EPERM`，python 侧为 `PermissionError`）；`settlement` 仍 `RELEASED`（Host 照常结算失败任务） |
| C | 期限：`seconds=1` + `sleep 5` | `returncode=124` |
| D | 取消：`seconds=60` + `sleep 600`，等约 2–3 秒后原生停止 | Host `143`，任务已释放（启动后立刻取消可能得到 `BLOCKED_OR_UNKNOWN`，属已知时机下限） |
| E | 越界参数：`seconds=0` 或 `3601` | 插件层拒绝，**不产生** Host 回执 |

每次调用生成**一个**证据文件（不是追加写同一个文件）：`artifactRoot` 下
`<session与call摘要>-<uuid>.json`，`0600` 权限，`schema: dsh.host-admission-call/v1`。
插件不持久化 business stdout/stderr/argv，只存摘要与结算。

## 5. 回滚

1. 让在跑的任务结束或被原生取消；
2. 在插件页只停用本 bundle（停用保留依赖，卸载才移除）；
3. 不要恢复整份 profile 备份覆盖其它配置，不要重启共享应用来「强制生效」。

## 故障对照

| 现象 | 含义 | 处理 |
|---|---|---|
| `host_run` 不存在 | bundle 未加载或预设没选 | 重载 bundle，新建会话首 Turn 前选预设 |
| 加载即报 `ENOENT` / 插件起不来 | `hostCommand` 路径无效 | 重跑 `prepare.mjs`，确认 Host 路径可执行 |
| `Host Admission requires the native workspace-write policy` | 会话权限不是 workspace-write | 换会话/权限，不支持升级 |
| `hostCommand is required: point it at …` | 配置缺项 | 重跑 `scripts/prepare.mjs` |
| `artifactRoot is required: point it at …` | 配置缺项 | 同上，指向一个你拥有的可写目录 |
| `HOST_SETTLEMENT_UNKNOWN` | 结算通道缺失/多行/退出码不一致 | 查 Host 是否写 fd 7、是否 daemonize |
| `BLOCKED_OR_UNKNOWN` + `blocked_reason` | 准入拒绝 | 按原因处理，不要用重试掩盖 |
| `UNKNOWN` | 插件拒绝猜测结算 | 先修通道，再判断任务是否真的结束 |
