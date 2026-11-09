# Host 侧契约 / Host-side contract

本文件是插件与本地准入 Host 之间**唯一**的接口约定。它刻意很小：一次调用、一条结算消息。
协议依据 2026-10 在本机 DSH 0.2.1-rc.2 上的实际行为整理；`demo/fake-host.mjs` 是可运行的参考实现（演示替身）。

## 1. 调用

插件通过原生 subprocess 启动 Host，argv 固定顺序如下（语法示意：`<…>` 是占位，不要照抄进 shell）：

```
<hostCommand> --project <abs workspace> \
  --memory-mib <int ≥0> --disk-growth-mib <int ≥0> --seconds <int 1..3600> \
  --result-fd 7 \
  --agent-kind dsh --agent-session-id <id> --agent-task-id <callId> \
  [--concurrency-intent <int ≥1>] [--exclusive-key <key>]... \
  -- <payload argv...>
```

| 参数 | 含义 | 谁负责 |
|---|---|---|
| `--project` | DSH 原生解析出的工作区根（realpath） | DSH session 策略 |
| `--memory-mib` / `--disk-growth-mib` | **本次预计新增需求**，不是硬配额 | 调用方申报，Host 决定是否准予 |
| `--seconds` | 硬截止，1..3600 | Host 强制 |
| `--result-fd` | 结算通道的文件描述符，固定为 `7` | Host 写 |
| `--agent-kind` / `--agent-session-id` / `--agent-task-id` | 仅用于归因 | 插件填充 |
| `--concurrency-intent` | 命令自身打算用多少并发，Host 只记录不强制 | 调用方 |
| `--exclusive-key` | 独占资源意图，如 `tcp-port:3000`；仅真正全机独占任务用 `host:heavy` | 调用方申报，Host 协调 |
| `--` 之后 | payload argv（已由 `sandbox.confine` 处理） | Host 执行 |

约束：

- Host 必须在 payload 自己的进程组里运行它，并向该组发信号；**不得** daemonize 或脱离进程组。
- Host 不得读取、改写或回收其它任务的租约；不得把 payload 的输出当作结算依据。
- Host 不得扩大 payload 的权限：工作区权限由 DSH 原生沙箱决定。
- 端口类任务由调用方传 `exclusive-key: tcp-port:<port>` 并严格绑定该端口，不自动换端口。

## 2. 结算通道（fd 7）

Host 在**退出前**向 fd 7 写**恰好一行** UTF-8 JSON，随后以自己的退出码退出。

成功路径：

```json
{"type":"HOST_NATIVE_RESULT","result":{
  "status":"RELEASED","returncode":0,
  "cancelled":null,"timed_out":false,
  "release":{"status":"RELEASED","cleanup_confirmed":true},
  "group_members":[],
  "budget":{"memory_mib":64,"disk_growth_mib":1,"seconds":20,"exclusive_keys":[]},
  "elapsed_ms":53}}
```

准入拒绝（payload 从未启动）：

```json
{"type":"HOST_NATIVE_BLOCKED","result":{"status":"BLOCKED","reason":"HOST_LEDGER_BUSY"}}
```

取消 / 超时的语义：

| 场景 | `returncode` | `cancelled` | `timed_out` |
|---|---|---|---|
| 正常结束 | payload 退出码 | `null` | `false` |
| 收到 SIGTERM（取消） | `143` | `15` | `false` |
| 收到 SIGINT | `130`（参考实现的约定；插件只校验退出码与 `returncode` 一致，不硬编码具体数值） | `2` | `false` |
| 到期 | `124` | `null` | `true` |

**单行约束**很重要：插件把“读到的行数 ≠ 1”当作未知，不会重跑任务。

## 3. 插件如何判定结算

```
无 rangeError 且 无 control.error 且 outcome.signal === null
且 outcome.exitCode === result.returncode
  ├─ status === RELEASED 且 release.status === RELEASED → RELEASED
  └─ status === CANCELLED_NO_LEASE 且 no_resource_created === true
     且 release === null → NO_LEASE_CREATED
HOST_NATIVE_BLOCKED → BLOCKED_OR_UNKNOWN
其余（含退出码与结算不一致）→ UNKNOWN + 明确错误码，不冒充成功
```

`UNKNOWN` 的语义是“不知道”，不是“失败”，更不是“已释放”。

## 4. 一个最小的合规 Host

`demo/fake-host.mjs` 约 110 行，覆盖以上要求：参数校验、独立进程组、期限、取消转发、单行结算、退出码镜像。

两点必须说清：

- 它的 `cleanup_confirmed: true` 和 `group_members: []` 是**写死的常量**，只用于演示消息形状；真实实现必须实际核对进程组。
- 它**没有**账本、跨任务排队和真实内存核算 —— 这些属于生产准入，不在契约里。

想看不配合规的结算通道会怎样，可以给它加 `--simulate-bad-channel`（写两行，适配器应回答 `UNKNOWN`）
或 `--simulate-blocked=<reason>`（准入拒绝）。

自测：

```sh
node demo/run-demo.mjs
```
