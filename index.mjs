// Translation-only adapter. DSH owns workspace permissions; the local host owns resources.
// Nothing here writes a budget ledger, schedules, retries or recovers another task.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

// `@deepseek-ai/dsh-tools` is provided by the installed DSH application, not by this
// package. Inside DSH the bare specifier usually resolves; otherwise we resolve it from
// the application package root. Override with DSH_PACKAGE_ROOT when DSH lives elsewhere.
const DSH_PACKAGE_ROOT =
  process.env.DSH_PACKAGE_ROOT ||
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/package.json';

let defineTool;
try {
  ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
} catch {
  const requireFromDsh = createRequire(DSH_PACKAGE_ROOT);
  ({ defineTool } = await import(requireFromDsh.resolve('@deepseek-ai/dsh-tools')));
}

export const inject = ['tools', 'sandboxPolicy', 'sandbox', 'subprocess'];
export const name = 'host-admission';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function readConfig(config) {
  const raw = config || {};
  if (typeof raw.hostCommand !== 'string' || !raw.hostCommand.trim()) {
    throw new Error('hostCommand is required: point it at the local admission host binary implementing docs/host-contract.md');
  }
  if (typeof raw.artifactRoot !== 'string' || !raw.artifactRoot.trim()) {
    throw new Error('artifactRoot is required: point it at an evidence directory you own and keep writable');
  }
  return {
    hostCommand: fs.realpathSync(raw.hostCommand),
    artifactRoot: fs.realpathSync(raw.artifactRoot),
  };
}

async function readResult(stream) {
  if (!stream) return { error: 'Native private result channel unavailable' };
  const chunks = [];
  let size = 0, overflow = false;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size <= 262144) chunks.push(chunk);
      else overflow = true;
    }
    if (overflow) return { error: 'Private result channel exceeded its bound' };
    const lines = Buffer.concat(chunks).toString('utf8').split('\n').filter(line => line.trim());
    if (lines.length !== 1) return { error: 'Expected exactly one complete native result' };
    const message = JSON.parse(lines[0]);
    if (!['HOST_NATIVE_RESULT', 'HOST_NATIVE_BLOCKED'].includes(message.type) || !message.result) {
      return { error: 'Unrecognized native result channel' };
    }
    return { message };
  } catch (error) {
    return { error: String(error) };
  }
}

export function apply(ctx, config) {
  const settings = readConfig(config);

  ctx.tools.register(defineTool({
    name: 'host_run',
    description: '在当前原生工作区运行前台测试、构建或开发任务，由本地准入 Host 准入和结算。每次按预计新增需求申报 memory_mib、disk_growth_mib、seconds，并在 budget_reason 说明依据；不要把驻留模型或总内存重复计入每次增量。普通读写用原生文件工具。命令在工作区项目根执行，不自动改目录、安装或重试；worker 数由命令自身设置，concurrency_intent 仅记录实际意图。声明不是硬配额。保持工作区权限，不支持权限升级。端口服务须传 exclusive_keys（如 tcp-port:3000）并严格绑定；仅真正全机独占任务使用 host:heavy，不把普通CPU工作串行化。不得daemonize、脱离进程组或停止他人任务。',
    parameters: {
      description: { type: 'string', required: true },
      argv: { type: 'array', required: true, items: { type: 'string' } },
      memory_mib: { type: 'integer', required: true },
      disk_growth_mib: { type: 'integer', required: true },
      seconds: { type: 'integer', required: true },
      budget_reason: { type: 'string', required: true },
      concurrency_intent: { type: 'integer' },
      exclusive_keys: { type: 'array', items: { type: 'string' } },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      for (const key of ['memory_mib', 'disk_growth_mib']) {
        if (!Number.isSafeInteger(args[key]) || args[key] < 0) throw new Error(`${key} must be a non-negative safe integer`);
      }
      if (!Number.isSafeInteger(args.seconds) || args.seconds < 1 || args.seconds > 3600) {
        throw new Error('Host deadline is 1..3600 seconds');
      }
      if (args.concurrency_intent !== undefined && (!Number.isSafeInteger(args.concurrency_intent) || args.concurrency_intent < 1)) {
        throw new Error('concurrency_intent must be a positive safe integer');
      }
      if (!args.argv.length || args.argv.some(v => v.includes('\0')) || !args.description.trim() || !args.budget_reason.trim()) {
        throw new Error('Expected exact nonempty argv, task description and budget rationale');
      }

      const policy = ctx.sandboxPolicy.resolve({ session: exec.agent.session });
      if (policy.mode !== 'workspace-write') throw new Error('Host Admission requires the native workspace-write policy');
      const workspace = fs.realpathSync(policy.workspaceRoot);

      // Payload stays inside the native confinement; the host never widens it.
      const confined = await ctx.sandbox.confine(args.argv, policy, exec.signal);
      exec.signal.throwIfAborted();

      const sessionId = exec.agent.session.header.id, callId = exec.callId;
      const extra = args.concurrency_intent === undefined ? [] : ['--concurrency-intent', String(args.concurrency_intent)];
      for (const key of args.exclusive_keys || []) extra.push('--exclusive-key', key);

      const handle = ctx.subprocess.spawn({
        argv: [settings.hostCommand, '--project', workspace,
          '--memory-mib', String(args.memory_mib),
          '--disk-growth-mib', String(args.disk_growth_mib),
          '--seconds', String(args.seconds),
          '--result-fd', '7',
          '--agent-kind', 'dsh', '--agent-session-id', sessionId, '--agent-task-id', callId,
          ...extra, '--', ...confined.argv],
        cwd: workspace,
        // Keep the parent agent's own session variables out of the payload's view.
        env: { CODEX_THREAD_ID: undefined, CODEX_SESSION_ID: undefined, CODEX_TURN_ID: undefined },
        stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 }, control: 'pipe' },
        graceMs: 30000, signal: exec.signal,
      });

      // Drain the existing native channel while the command runs. No new process owner.
      const controlPromise = readResult(handle.control);
      let outcome, rangeError = null;
      try { outcome = await handle.done; }
      catch (error) { outcome = { error: String(error) }; }
      try { await handle.waitForExit(); }
      catch (error) { rangeError = String(error); }
      const control = await controlPromise;
      const stdout = handle.collected.stdout.readFrom(0), stderr = handle.collected.stderr.readFrom(0);

      const host = control.message?.result;
      let settlement = 'UNKNOWN';
      if (!rangeError && !control.error && outcome.signal === null && outcome.exitCode === host?.returncode) {
        if (host.status === 'RELEASED' && host.release?.status === 'RELEASED') settlement = 'RELEASED';
        else if (host.status === 'CANCELLED_NO_LEASE' && host.no_resource_created === true && host.release === null) settlement = 'NO_LEASE_CREATED';
      }
      if (!rangeError && control.message?.type === 'HOST_NATIVE_BLOCKED') settlement = 'BLOCKED_OR_UNKNOWN';
      const resultMismatch = control.message?.type === 'HOST_NATIVE_RESULT' &&
        (outcome.signal !== null || outcome.exitCode !== host?.returncode);
      const resultError = control.error ?? rangeError ?? outcome.error ??
        (settlement === 'UNKNOWN' ? (resultMismatch ? 'EXIT_RESULT_MISMATCH' : 'HOST_SETTLEMENT_UNKNOWN') : null);

      let receiptSaved = false;
      try {
        // Finite local evidence only: no business stdout/stderr/argv is persisted here.
        const evidence = {
          schema: 'dsh.host-admission-call/v1', observed_at: new Date().toISOString(),
          sessionId, callId, workspace, policy,
          budget: {
            memory_mib: args.memory_mib, disk_growth_mib: args.disk_growth_mib, seconds: args.seconds,
            concurrency_intent: args.concurrency_intent, exclusive_keys: args.exclusive_keys || [],
            reason: args.budget_reason,
          },
          command_sha256: sha(JSON.stringify(args.argv)), outcome, rangeError, control, settlement,
        };
        const key = sha(sessionId + '\0' + callId) + '-' + crypto.randomUUID();
        fs.writeFileSync(`${settings.artifactRoot}/${key}.json`, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        receiptSaved = true;
      } catch { /* Evidence failure does not rerun or invalidate completed work. */ }

      return JSON.stringify({
        host_status: settlement === 'UNKNOWN' ? 'UNKNOWN' : host?.status ?? 'BLOCKED_OR_UNKNOWN',
        returncode: outcome.exitCode ?? null,
        host_returncode: host?.returncode ?? null,
        settlement,
        error: resultError,
        blocked_reason: control.message?.type === 'HOST_NATIVE_BLOCKED' ? host?.reason : undefined,
        stdout: stdout.text, stderr: stderr.text,
        stdout_truncated: stdout.lossy, stderr_truncated: stderr.lossy,
        receipt_saved: receiptSaved,
      });
    },
  }));
}
