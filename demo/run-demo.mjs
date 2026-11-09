#!/usr/bin/env node
// Runs the host-side contract end to end, without DSH and without any private binary.
// Four bounded cases:
//   1. normal task            -> RELEASED, exit 0
//   2. deadline enforced      -> RELEASED, exit 124
//   3. cancelled mid-flight   -> RELEASED, exit 143, host signalled its own group
//   4. admission refused      -> HOST_NATIVE_BLOCKED, exit 3
//
//   node demo/run-demo.mjs        # from the repo root
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const host = path.join(here, 'fake-host.mjs');
const project = path.resolve(here, '..');
// fd 7 is the single settlement channel; the adapter reads exactly one line from it.
const STDIO = ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'pipe'];

function runCase({ label, args, payload, killAfterMs }) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, [host, '--project', project, '--result-fd', '7', ...args, '--', ...payload], { cwd: project, stdio: STDIO });
    let control = '', stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdio[7].on('data', chunk => { control += chunk; });
    if (killAfterMs) setTimeout(() => child.kill('SIGTERM'), killAfterMs);
    child.on('close', (code, signal) => {
      const message = control.trim() ? JSON.parse(control.trim()) : null;
      resolve({ label, code, signal, stdout, stderr, message, ms: Date.now() - started });
    });
  });
}

const cases = [
  {
    label: '正常任务 / normal task',
    args: ['--memory-mib', '64', '--disk-growth-mib', '1', '--seconds', '20', '--agent-kind', 'dsh', '--agent-session-id', 'demo-session', '--agent-task-id', 'demo-call-1'],
    payload: [process.execPath, '-e', 'console.log("payload ran inside the workspace")'],
    expect: r => r.code === 0 && r.message?.result?.status === 'RELEASED' && r.message.result.release.status === 'RELEASED',
    expectText: 'RELEASED, exit 0',
  },
  {
    label: '期限强制 / deadline enforced',
    args: ['--memory-mib', '64', '--disk-growth-mib', '1', '--seconds', '1'],
    payload: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'],
    expectText: 'RELEASED, exit 124, timed_out=true',
    expect: r => r.code === 124 && r.message?.result?.timed_out === true,
  },
  {
    label: '运行中取消 / cancelled mid-flight',
    args: ['--memory-mib', '64', '--disk-growth-mib', '1', '--seconds', '30'],
    payload: [process.execPath, '-e', 'setTimeout(() => {}, 10000)'],
    killAfterMs: 600,
    expectText: 'RELEASED, exit 143, cancelled=15',
    expect: r => r.code === 143 && r.message?.result?.cancelled === 15,
  },
  {
    label: '准入拒绝 / admission refused',
    args: ['--memory-mib', '64', '--disk-growth-mib', '1', '--seconds', '20', '--simulate-blocked', 'HOST_LEDGER_BUSY'],
    payload: [process.execPath, '-e', 'console.log("must never run")'],
    expectText: 'HOST_NATIVE_BLOCKED, exit 3, payload 未启动',
    expect: r => r.code === 3 && r.message?.type === 'HOST_NATIVE_BLOCKED' && r.message.result.reason === 'HOST_LEDGER_BUSY',
  },
];

const line = (text = '') => process.stdout.write(text + '\n');
let failed = 0;

line('Host Admission · host-side contract demo');
line('单元: demo/fake-host.mjs（演示替身，不是生产准入实现）');
line('='.repeat(72));
for (const testCase of cases) {
  const result = await runCase(testCase);
  const ok = testCase.expect(result);
  if (!ok) failed += 1;
  line('');
  line(`${ok ? 'PASS' : 'FAIL'}  ${testCase.label}`);
  line(`  期望: ${testCase.expectText}`);
  line(`  实际: exit=${result.code} signal=${result.signal ?? 'null'} ${result.ms}ms`);
  const settled = result.message?.result ?? result.message ?? null;
  line(`  结算: ${settled ? JSON.stringify({ type: result.message.type, status: settled.status, returncode: settled.returncode, release: settled.release?.status ?? null, cleanup_confirmed: settled.release?.cleanup_confirmed, cancelled: settled.cancelled ?? null, timed_out: settled.timed_out ?? null }) : '(无结算消息)'}`);
  if (result.message?.type === 'HOST_NATIVE_BLOCKED') line(`  原因: ${result.message.result.reason}`);
  const payloadOut = result.stdout.trim();
  if (payloadOut) line(`  payload 输出: ${payloadOut}`);
}
line('');
line('='.repeat(72));
line(failed === 0 ? `全部 ${cases.length} 例通过。` : `${failed} 例失败。`);
line('在 DSH 里，同一协议的 payload 会先经原生 sandbox.confine，权限仍是 workspace-write。');
process.exit(failed === 0 ? 0 : 1);
