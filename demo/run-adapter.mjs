#!/usr/bin/env node
// Exercises the REAL adapter (index.mjs), not just the host side. It is imported with a
// stub `@deepseek-ai/dsh-tools` and a stub execution context, so the settlement mapping,
// the fd 7 parsing, the cancellation path and the error branches all actually run.
//
// This is not DSH: sandbox.confine is a pass-through here. What it proves is the adapter's
// own logic; what it cannot prove is DSH's native confinement (that needs a real session).
//
//   node demo/run-adapter.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const STDIO = ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'pipe'];

// --- isolate the adapter so it can be imported outside DSH -------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-admission-adapter-'));
const pkg = path.join(tmp, 'pkg');
const stub = path.join(pkg, 'node_modules', '@deepseek-ai', 'dsh-tools');
fs.mkdirSync(stub, { recursive: true });
fs.writeFileSync(path.join(stub, 'package.json'), JSON.stringify({
  name: '@deepseek-ai/dsh-tools', version: '0.0.0-stub', type: 'module', exports: { '.': './index.mjs' },
}));
fs.writeFileSync(path.join(stub, 'index.mjs'), 'export const defineTool = definition => definition;\n');
fs.copyFileSync(path.join(repo, 'index.mjs'), path.join(pkg, 'index.mjs'));

const hostBase = path.join(tmp, 'fake-host.mjs');
fs.copyFileSync(path.join(here, 'fake-host.mjs'), hostBase);
fs.chmodSync(hostBase, 0o755);

// Wrappers let one demo file reach the fake host's extra simulation flags.
function hostWrapper(name, extraFlags = '') {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${hostBase}" ${extraFlags} "$@"\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

const artifacts = path.join(tmp, 'artifacts');
fs.mkdirSync(artifacts);

const adapter = await import(pathToFileURL(path.join(pkg, 'index.mjs')).href);

// --- stub execution context -------------------------------------------------
function spawnHandle(opts) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const child = spawn(opts.argv[0], opts.argv.slice(1), { cwd: opts.cwd, env, stdio: STDIO });
  const maxBytes = 65536;
  const collected = { stdout: '', stderr: '', stdoutLossy: false, stderrLossy: false };
  let stdoutSize = 0, stderrSize = 0;
  child.stdout.on('data', chunk => {
    stdoutSize += chunk.length;
    if (stdoutSize <= maxBytes) collected.stdout += chunk.toString('utf8');
    else collected.stdoutLossy = true;
  });
  child.stderr.on('data', chunk => {
    stderrSize += chunk.length;
    if (stderrSize <= maxBytes) collected.stderr += chunk.toString('utf8');
    else collected.stderrLossy = true;
  });
  const done = new Promise(resolve => child.on('close', (code, signal) => resolve({ exitCode: code, signal })));
  if (opts.signal) {
    opts.signal.addEventListener('abort', () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } }, { once: true });
  }
  async function* control() {
    for await (const chunk of child.stdio[7]) yield Buffer.from(chunk);
  }
  return {
    control: control(),
    done,
    waitForExit: () => done.then(() => undefined),
    collected: {
      stdout: { readFrom: () => ({ text: collected.stdout, lossy: collected.stdoutLossy }) },
      stderr: { readFrom: () => ({ text: collected.stderr, lossy: collected.stderrLossy }) },
    },
  };
}

function makeTool(hostCommand) {
  let definition = null;
  adapter.apply({
    tools: { register: value => { definition = value; } },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: repo }) },
    sandbox: { confine: async argv => ({ argv }) },
    subprocess: { spawn: spawnHandle },
  }, { hostCommand, artifactRoot: artifacts });
  if (!definition) throw new Error('adapter did not register a tool');
  return definition;
}

const call = (tool, args, { abortAfterMs } = {}) => {
  const controller = new AbortController();
  if (abortAfterMs) setTimeout(() => controller.abort(), abortAfterMs);
  const exec = { agent: { session: { header: { id: `adapter-demo-${Math.random().toString(16).slice(2)}` } } }, callId: `call-${Date.now()}`, signal: controller.signal };
  return tool.execute(args, exec).then(raw => JSON.parse(raw));
};

const base = seconds => ({
  description: 'adapter demo task', memory_mib: 64, disk_growth_mib: 1, seconds,
  budget_reason: 'demo: bounded foreground task',
  argv: [process.execPath, '-e', 'console.log("payload ran")'],
});

const cases = [
  {
    label: '正常任务 → RELEASED',
    host: () => hostWrapper('host-normal.sh'),
    run: tool => call(tool, base(20)),
    expect: r => r.settlement === 'RELEASED' && r.returncode === 0 && r.receipt_saved === true,
  },
  {
    label: '期限到点 → returncode 124',
    host: () => hostWrapper('host-normal.sh'),
    run: tool => call(tool, { ...base(1), argv: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'] }),
    expect: r => r.settlement === 'RELEASED' && r.returncode === 124,
  },
  {
    label: '运行中取消 → returncode 143',
    host: () => hostWrapper('host-normal.sh'),
    run: tool => call(tool, { ...base(30), argv: [process.execPath, '-e', 'setTimeout(() => {}, 10000)'] }, { abortAfterMs: 700 }),
    expect: r => r.settlement === 'RELEASED' && r.returncode === 143,
  },
  {
    label: '准入拒绝 → BLOCKED_OR_UNKNOWN',
    host: () => hostWrapper('host-blocked.sh', '--simulate-blocked HOST_LEDGER_BUSY'),
    run: tool => call(tool, base(20)),
    expect: r => r.settlement === 'BLOCKED_OR_UNKNOWN' && r.blocked_reason === 'HOST_LEDGER_BUSY',
  },
  {
    label: '结算通道两行 → UNKNOWN（不猜，报出具体原因）',
    host: () => hostWrapper('host-bad-channel.sh', '--simulate-bad-channel'),
    run: tool => call(tool, base(20)),
    expect: r => r.settlement === 'UNKNOWN' && typeof r.error === 'string' && r.error.length > 0,
  },
  {
    label: '参数越界 → 插件层拒绝，无 Host 调用',
    host: () => hostWrapper('host-normal.sh'),
    run: tool => call(tool, base(0)),
    expect: r => r instanceof Error && /1\.\.3600 seconds/.test(r.message),
  },
];

const line = (text = '') => process.stdout.write(text + '\n');
let failed = 0;

line('Host Admission · adapter demo（真实 index.mjs + stub ctx）');
line('注意：sandbox.confine 在这里是直通；DSH 原生沙箱需要在真实会话里验证。');
line('='.repeat(72));
try {
  for (const testCase of cases) {
    const tool = makeTool(testCase.host());
    let result, threw = null;
    try { result = await testCase.run(tool); } catch (error) { threw = error; }
    const subject = threw ?? result;
    const ok = testCase.expect(subject);
    if (!ok) failed += 1;
    line('');
    line(`${ok ? 'PASS' : 'FAIL'}  ${testCase.label}`);
    if (threw) line(`  抛出: ${threw.message}`);
    else line(`  返回: ${JSON.stringify({ settlement: result.settlement, returncode: result.returncode, host_status: result.host_status, error: result.error, blocked_reason: result.blocked_reason, receipt_saved: result.receipt_saved })}`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

line('');
line('='.repeat(72));
line(failed === 0 ? `全部 ${cases.length} 例通过。` : `${failed} 例失败。`);
line('证据文件（本 demo 每次调用一个，写在临时目录）：schema dsh.host-admission-call/v1');
process.exit(failed === 0 ? 0 : 1);
