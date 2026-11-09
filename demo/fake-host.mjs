#!/usr/bin/env node
// Reference implementation of the host side of the contract described in
// docs/host-contract.md. It is a DEMO DOUBLE, not an admission system: it has no
// ledger, no cross-task queue and no real memory accounting. It exists so the
// adapter and its settlement semantics can be observed without any private binary.
//
//   node demo/fake-host.mjs --project . --memory-mib 64 --disk-growth-mib 1 \
//     --seconds 20 --result-fd 7 -- node -e 'console.log("hello")'
//
// Exit code mirrors the payload, except for the three settled outcomes: deadline -> 124,
// SIGTERM -> 143, SIGINT -> 130. Designed to be spawned by demo/run-demo.mjs or by
// demo/run-adapter.mjs, which supply fd 7 as a pipe. Run by hand without fd 7 it exits 3
// with a message instead of pretending to have settled anything.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

// Flags before `--` are the host's; everything after is the payload. Boolean simulation
// flags may omit a value, so parse by key rather than by strict pairs.
const BOOLEAN_FLAGS = new Set(['simulate-bad-channel']);

function parse(argv) {
  const args = { exclusive: [] }, sep = argv.indexOf('--');
  const head = sep === -1 ? argv : argv.slice(0, sep);
  const payload = sep === -1 ? [] : argv.slice(sep + 1);
  for (let i = 0; i < head.length; i += 1) {
    const token = head[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    const key = eq === -1 ? token.slice(2) : token.slice(2, eq);
    if (BOOLEAN_FLAGS.has(key)) { args[key] = '1'; continue; }
    const value = eq === -1 ? head[++i] : token.slice(eq + 1);
    if (key === 'exclusive-key') args.exclusive.push(value);
    else args[key] = value;
  }
  return { args, payload };
}

function emit(fd, message) {
  try { fs.writeSync(fd, JSON.stringify(message) + '\n'); return true; }
  catch { return false; }
}

// No fd 7 means no settlement channel; the adapter treats that as UNKNOWN, so never
// exit 0 here: fail loudly instead of reporting success we cannot prove.
function emitOrDie(fd, message) {
  if (emit(fd, message)) return;
  process.stderr.write('host: fd 7 (settlement channel) is unavailable; refusing to report success\n');
  process.exit(3);
}

const { args, payload } = parse(process.argv.slice(2));
const resultFd = Number(args['result-fd'] ?? -1);
const project = args.project ?? process.cwd();
const seconds = Number(args.seconds);
const memoryMib = Number(args['memory-mib']);
const diskMib = Number(args['disk-growth-mib']);

const rejected = reason => {
  emitOrDie(resultFd, { type: 'HOST_NATIVE_BLOCKED', result: { status: 'BLOCKED', reason } });
  process.exit(3);
};

if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) rejected('PROJECT_NOT_A_DIRECTORY');
if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600) rejected('SECONDS_MUST_BE_1_TO_3600');
if (!Number.isSafeInteger(memoryMib) || memoryMib < 0) rejected('MEMORY_MIB_MUST_BE_NON_NEGATIVE');
if (!Number.isSafeInteger(diskMib) || diskMib < 0) rejected('DISK_GROWTH_MIB_MUST_BE_NON_NEGATIVE');
if (!payload.length) rejected('EMPTY_PAYLOAD_ARGV');
if (args['simulate-blocked']) rejected(args['simulate-blocked']);
// Deliberately writes two lines, to show how the adapter refuses to guess a settlement.
const doubleReport = Boolean(args['simulate-bad-channel']);

const started = Date.now();
let cancelled = null;
let timedOut = false;
let child = null;
let settled = false;

function killGroup(signal) {
  if (!child || child.pid === undefined) return;
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch { /* already gone */ } }
}

function settle(rawReturncode) {
  if (settled) return;
  settled = true;
  const returncode = timedOut ? 124 : cancelled === 2 ? 130 : cancelled === 15 ? 143 : rawReturncode;
  // One line on fd 7 is the entire settlement channel; the adapter never parses logs.
  emitOrDie(resultFd, {
    type: 'HOST_NATIVE_RESULT',
    result: {
      schema: 'demo.host-native-result/v1', status: 'RELEASED', returncode,
      cancelled, timed_out: timedOut,
      release: { status: 'RELEASED', cleanup_confirmed: true },
      group_members: [],
      budget: { memory_mib: memoryMib, disk_growth_mib: diskMib, seconds, exclusive_keys: args.exclusive },
      dims: { agent_kind: args['agent-kind'] ?? null, session: args['agent-session-id'] ?? null, call: args['agent-task-id'] ?? null },
      elapsed_ms: Date.now() - started,
    },
  });
  if (doubleReport) {
    // Second line on purpose: the adapter must see "not exactly one" and answer UNKNOWN.
    try {
      fs.writeSync(resultFd, JSON.stringify({ type: 'HOST_NATIVE_RESULT', result: { status: 'RELEASED', returncode } }) + '\n');
    } catch { /* the first line already went out */ }
  }
  process.exit(returncode);
}

// Own process group, so a cancel takes the whole workload and nothing else.
child = spawn(payload[0], payload.slice(1), { cwd: project, detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
child.on('error', error => {
  process.stderr.write(`host: payload could not start: ${error.message}\n`);
  settle(127);
});
child.on('exit', (code, signal) => settle(signal ? 128 + (signal === 'SIGKILL' ? 9 : 15) : code ?? 1));

const deadline = setTimeout(() => {
  timedOut = true;
  killGroup('SIGTERM');
  setTimeout(() => killGroup('SIGKILL'), 2000).unref();
}, seconds * 1000);

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    cancelled = signal === 'SIGINT' ? 2 : 15;
    clearTimeout(deadline);
    killGroup('SIGTERM');
    setTimeout(() => killGroup('SIGKILL'), 2000).unref();
  });
}
