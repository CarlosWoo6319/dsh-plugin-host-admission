# Host Admission · DSH 插件（预览版 0.1.0-preview）

**让多个 agent 在同一台机器上跑本机任务时，不再互相踩。**

DSH 可以同时跑 Lead、teammates、子代理和多个会话。它们都能调用工具去编译、跑测试、启动长脚本、开浏览器——于是同一台机器上会出现：内存被抢、CPU 打满、端口被占、任务被系统杀掉、取消后留下孤儿进程。这不是模型能力问题，是**缺少一层资源准入**。

本插件给这类调用加一层最小、可核对的契约：**先申报预算，到点必须停，停了要能证明资源还回来了**。工作区权限一点都不放宽。

> 预览版参考实现，不是已上架插件。MIT 许可。

## 问题在哪

| 多个 agent 并发时的实际表现 | 后果 |
|---|---|
| 各自直接跑编译 / 测试 / 长脚本 | 内存与 CPU 互相抢，模型进程被拖慢甚至被杀 |
| 任务没有硬截止 | 卡住的构建一直占着机器，后续 agent 全部排队等死 |
| 取消只杀外层进程 | 子进程、进程组残留，机器越跑越卡 |
| 没有结算回执 | 「到底有没有释放」只能靠猜，没法判断能不能继续跑下一个任务 |

## 它做什么 / 不做什么

**做**：把一次工具调用翻译成一次带预算与期限的本地任务，结束后在独立通道上返回可核对的结算状态（`RELEASED` / `NO_LEASE_CREATED` / `BLOCKED_OR_UNKNOWN` / `UNKNOWN`）。

**不做**（刻意的边界）：不管账本、不排队、不重试、不调度、不回收别人的租约、不改文件权限、不做最终验收。资源准入归本地 Host，权限归 DSH 原生沙箱。本包只做**调用、身份、结果的翻译**——所以它可以和任何准入实现配合，也可以被随时替换。

## 怎么工作

```
DSH 模型 / agent
  │  host_run(argv, memory_mib, disk_growth_mib, seconds, budget_reason)
  ▼
原生 sandbox.confine()  ── payload 仍在 workspace-write 内，权限不放宽
  │
  ▼
本地准入 Host（独立进程，你提供，按 docs/host-contract.md 实现）
  │  预算 / 并发意图 / exclusive_keys（如 tcp-port:3000）/ 硬截止 / 独立进程组
  ▼
payload：编译、测试、长脚本、浏览器任务……
  │
  ▼  fd 7 上恰好一条 JSON（唯一结算通道）
RELEASED / CANCELLED_NO_LEASE / BLOCKED
```

多个 agent 并发时，谁先拿到资源、谁要等、谁的端口被占，都由**同一个 Host 账本**决定，而不是让各个 agent 互相撞运气。协议细节见 [docs/host-contract.md](docs/host-contract.md)。

## 两个可直接运行的 demo

都不需要 DSH，也不需要任何私有二进制。

**① Host 侧契约**（4 例，约 2 秒）

```sh
node demo/run-demo.mjs
```

```
PASS  正常任务 / normal task
  结算: {"type":"HOST_NATIVE_RESULT","status":"RELEASED","returncode":0,"release":"RELEASED","cleanup_confirmed":true,...}
PASS  期限强制 / deadline enforced        exit=124 timed_out=true
PASS  运行中取消 / cancelled mid-flight   exit=143 cancelled=15
PASS  准入拒绝 / admission refused        HOST_NATIVE_BLOCKED, 原因 HOST_LEDGER_BUSY（payload 从未启动）
```

**② 适配器本体**（6 例，真实 `index.mjs` + stub ctx）

```sh
node demo/run-adapter.mjs
```

```
PASS  正常任务 → RELEASED            {"settlement":"RELEASED","returncode":0,"receipt_saved":true}
PASS  期限到点 → returncode 124       {"settlement":"RELEASED","returncode":124}
PASS  运行中取消 → returncode 143     {"settlement":"RELEASED","returncode":143}
PASS  准入拒绝 → BLOCKED_OR_UNKNOWN   {"blocked_reason":"HOST_LEDGER_BUSY"}
PASS  结算通道两行 → UNKNOWN（不猜）   {"error":"Expected exactly one complete native result"}
PASS  参数越界 → 插件层拒绝           抛出: Host deadline is 1..3600 seconds
```

第二个 demo 会 import 真实的 `index.mjs`，跑真实的结算映射、fd 7 解析、取消与参数校验。
它**不能**证明 DSH 原生沙箱：那里 `sandbox.confine` 是直通，必须在真实会话里验证。

> demo 里的 `demo/fake-host.mjs` 是契约的**演示替身**：没有账本、没有跨任务排队、没有真实内存核算，`cleanup_confirmed` 是写死的。它的用途是让协议可观察、可复现，不是证明生产准入。

## 安装（预览版只支持本地目录安装）

> **顺序不能反**：先生成 patch，再安装该目录。仓库里**没有**提交 `cordis.patch.yml`（它含本机绝对路径，已被 `.gitignore` 忽略）。`npm install` 本身能装上，但装出来的包没有这个 patch，DSH 加载 bundle 时才会失败——所以请按下面的本地目录流程安装。

1. 克隆到一个**固定、不移动**的目录（安装记录会指向它）：

```sh
git clone https://github.com/CarlosWoo6319/dsh-plugin-host-admission.git \
  "$HOME/Library/Application Support/dsh-bundles/host-admission"
```

2. 生成机器专属 patch（同时创建证据目录）：

```sh
cd "$HOME/Library/Application Support/dsh-bundles/host-admission"
node scripts/prepare.mjs \
  --host "/absolute/path/to/your-admission-host" \
  --artifacts "$HOME/Library/Application Support/dsh-bundles/host-admission-calls"
```

3. 在 DSH 插件页把**这个目录**作为本地 bundle 安装；重载后出现预设「本机任务准入」。
4. **新建**会话，在首个 Turn 之前选择该预设；确认能看到工具 `host_run`。
5. 按 [docs/install.md](docs/install.md) 的 A–E 五步验证。

前置：DSH 桌面版 `≥ 0.2.1-rc.2`；一个实现 host 契约的可执行文件；Node ≥ 20。

升级：换一个**新目录**装新版本，不要原地改写正在使用的 bundle；旧会话保留旧版本。

## 已知限制

- **预览版**：已在本机 DSH 0.2.1-rc.2 + 自有 Host 上验证；**参数化版本尚未在他人机器上验证**，请按此判断成熟度。
- 需要一个 Host 实现；仓库只给契约与演示替身，**不含生产准入系统**。
- 仅支持 `workspace-write`；拒绝其它权限模式，不提供升级路径。
- 预算数值是**申报需求，不是操作系统硬配额**。
- 未覆盖：准入窗口内取消、SIGKILL、掉电、脱离进程组、跨平台。
- `@deepseek-ai/dsh-tools` 从已安装的 DSH 应用解析；应用不在默认 macOS 路径时，用环境变量 `DSH_PACKAGE_ROOT` 指向其 `…/app.asar/dsh/package.json`。
- 打包、签名、上架审核的自动化尚未实现（路线图第 1 项）。
- `package.json` 里 `"private": true` 是刻意的：本包**不**发布到 npm，只通过本地目录安装；这样也不会误把本机 patch 带上分发。

## 验证状态（可核对的部分）

| 范围 | 结果 | 能否由他人复现 |
|---|---|---|
| Host 侧契约（`demo/run-demo.mjs`） | 4/4 | 能，无需 DSH |
| 适配器本体（`demo/run-adapter.mjs`） | 6/6 | 能，stub ctx |
| 真实模型会话（本机 DSH 0.2.1-rc.2） | 正常调用 / 越界写入被原生沙箱拒绝 / 运行中取消得到 `ABORTED` 且 Host 侧 143、进程组为空、已释放 | 部分（需同版本 DSH 与 Host） |
| 期限对齐 | 插件 3600 秒与 Host 硬截止一致；`0`、`3601` 在校验层拒绝 | 能（校验路径已由 demo 覆盖） |

不能代签：他人机器、DSH 原生沙箱行为、其它平台。

## 目录

```
index.mjs                  插件实现（只做翻译）
locale/{zh,en}.json        原生显示的标题与描述
icon.svg                   图标
cordis.patch.template.yml  预设与工具注册模板
scripts/prepare.mjs        按本机生成 cordis.patch.yml
scripts/guard-pack.mjs     打包前守卫：拒绝带上本机 patch 或绝对路径
docs/host-contract.md      Host 侧契约（argv、fd 7、结算状态）
docs/install.md            安装与 A–E 验证
demo/run-demo.mjs          Host 侧四例
demo/run-adapter.mjs       适配器本体六例
demo/fake-host.mjs         契约演示替身
```

## 路线图

1. 打包与上架：一键生成可安装 bundle、版本升级与回滚路径。
2. Host 契约抽成可替换接口，任何准入实现都能接。
3. 面向普通用户的用法：不读契约文档也能直接跑本机重任务。
4. 跨平台（Linux 首发），进程组与信号语义的等价验证。

## 许可

[MIT](LICENSE) © 2026 Carlos Woo。可自由使用、修改、分发与商用，保留版权与许可声明即可。

> 如果你只想要结论：`LICENSE` 文件就是全部操作。MIT 是标准文本，不需要署名以外的额外义务，也不提供担保。
