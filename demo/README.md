# 演示 / Demo

两个 demo，都不需要 DSH、不需要网络、没有第三方依赖。

## ① Host 侧契约（4 例）

```sh
node demo/run-demo.mjs
```

| 用例 | 展示的语义 |
|---|---|
| 正常任务 | `RELEASED` + `cleanup_confirmed`，退出码镜像 payload |
| 期限强制 | `seconds=1` 到点后返回 `124`、`timed_out=true` |
| 运行中取消 | Host 收到 SIGTERM → 向自己创建的进程组发信号 → `143`、`cancelled=15` |
| 准入拒绝 | `HOST_NATIVE_BLOCKED` + `reason`，payload **从未启动** |

覆盖的是**Host 侧**：参数校验、独立进程组、期限、取消转发、fd 7 单行结算。
`fake-host.mjs` 是契约的演示替身，`cleanup_confirmed` 与 `group_members` 是写死的常量；
它不证明生产准入，也不证明进程组真的为空。

## ② 适配器本体（6 例）

```sh
node demo/run-adapter.mjs
```

真实 import `index.mjs`，用一个 stub 的 `@deepseek-ai/dsh-tools` 和 stub 执行上下文，跑通：

| 用例 | 断言 |
|---|---|
| 正常任务 | `settlement=RELEASED`、`returncode=0`、`receipt_saved=true` |
| 期限到点 | `returncode=124` |
| 运行中取消（AbortSignal） | `returncode=143` |
| 准入拒绝 | `BLOCKED_OR_UNKNOWN` + `blocked_reason` |
| 结算通道写两行 | `UNKNOWN` + 具体错误，**不猜** |
| `seconds=0` | 插件层抛错，Host 从未被调用 |

这里的 `sandbox.confine` 是直通，所以它证明的是**适配器逻辑**，不是 DSH 原生沙箱。
原生沙箱必须在真实会话里按 `docs/install.md` 的 A–E 验证。

## 如果要接自己的 Host

1. 读 `docs/host-contract.md`；
2. 按 `fake-host.mjs` 的形状实现 argv 与 fd 7；
3. `node scripts/prepare.mjs --host /path/to/your-host --artifacts /path/to/evidence-calls`；
4. 按 `docs/install.md` 的 A–E 五步验证。

## 录一支 60 秒演示（可选素材）

如果要给人快速看，而不是让人读文档，按这个分镜录：

| 时间 | 画面 | 一句旁白 |
|---|---|---|
| 0–8s | `index.mjs` 停在 `ctx.sandbox.confine(...)` 与 `ctx.subprocess.spawn({…'--result-fd','7'…})` | 「插件只做翻译：confinement 用 DSH 原生的，预算和结算交给本地 Host。」 |
| 8–20s | 终端 `node demo/run-demo.mjs`、`node demo/run-adapter.mjs` | 「不起 DSH 也能看到两种层面的验证。」 |
| 20–35s | DSH 新会话，首 Turn 前选「本机任务准入」，模型调用 `host_run` | 「真实会话里，模型拿到的是一次带预算的调用。」 |
| 35–45s | `seconds=1` + `sleep 5` → 结果显示 `124` | 「到点就被硬截止，不靠模型自觉。」 |
| 45–58s | `sleep 600` 调用中点原生停止 → `ABORTED` + Host `143` | 「取消后进程组清空、任务已释放，结算可核对。」 |
| 58–60s | README 的「它做什么 / 不做什么」 | 「边界写得很清楚，这也是一份可以接管的实现。」 |

录好放到仓库 Release 或视频平台，不要提交二进制进仓库。

### 录屏脱敏清单（发布前逐条过）

画面里出现一次真实 home 路径，就等于把机器信息发给所有人。录之前先改环境：

- 终端提示符改成不带主机名/用户名的形式：`export PS1='$ '`
- 演示项目放在 `/tmp/demo-project`，不要用真实工作区；命令里不出现 `~/Desktop/...`
- 证据目录用 `/tmp/host-admission-calls`，不展示 `~/Library/Application Support/...`
- 用**新建的空会话**，侧边栏不要露出其它会话标题、项目名或 teammate 名称
- 关闭通知、隐藏 Dock 里的私人应用，不打开 `~/.dsh`、`.env`、任何回执目录
- 不在画面里出现内部 issue 编号、邮箱、账号、其他 agent 的输出
- 录完逐帧看一遍：路径、标题栏、侧边栏、终端历史、命令补全候选

如果需要展示真实路径，先在编辑器里替换成 `/Users/demo/...` 再开录。
