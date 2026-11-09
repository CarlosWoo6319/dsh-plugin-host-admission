#!/usr/bin/env node
// Writes ./cordis.patch.yml for THIS machine. Run it in the repository clone BEFORE
// installing the bundle, because the patch must point at the directory DSH will load.
// Paths cannot be committed: the host binary and evidence directory are machine-specific.
//
//   node scripts/prepare.mjs \
//     --host "/Users/you/.local/bin/your-host" \
//     --artifacts "/Users/you/Library/Application Support/<…>/calls" \
//     [--bundle-dir "/the/directory/you/will/install/as/a/bundle"]
//
// Nothing here writes to your DSH profile, starts or stops a task, or edits a bundle
// that DSH is already using.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  process.stderr.write(`prepare: ${message}\n`);
  process.exit(1);
}

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = (process.argv[i] ?? '').replace(/^--/, '');
  if (!key || !process.argv[i + 1]) fail(`expected --key value pairs, got "${process.argv[i] ?? ''}"`);
  args[key] = process.argv[i + 1];
}
for (const key of Object.keys(args)) {
  if (!['host', 'artifacts', 'bundle-dir'].includes(key)) fail(`unknown option --${key}`);
}

if (!args.host) fail('--host <absolute path of your admission host binary> is required');
if (!args.artifacts) fail('--artifacts <absolute evidence directory you own> is required');

// Default target is this repository clone: install THAT directory as the bundle.
const bundleDir = path.resolve(args['bundle-dir'] ?? root);
const entry = path.join(bundleDir, 'index.mjs');
if (!fs.existsSync(entry)) fail(`${bundleDir} does not contain index.mjs`);
if (!fs.existsSync(path.join(bundleDir, 'cordis.patch.template.yml'))) {
  fail(`${bundleDir} does not contain cordis.patch.template.yml (run this from the repository clone)`);
}

const hostPath = path.resolve(args.host);
if (!fs.existsSync(hostPath)) fail(`host binary not found: ${hostPath}`);
try { fs.accessSync(hostPath, fs.constants.X_OK); } catch { fail(`host binary is not executable: ${hostPath}`); }

const artifactsDir = path.resolve(args.artifacts);
if (fs.existsSync(artifactsDir) && !fs.statSync(artifactsDir).isDirectory()) {
  fail(`--artifacts must be a directory, but it is a file: ${artifactsDir}`);
}
if (!fs.existsSync(artifactsDir)) fs.mkdirSync(artifactsDir, { recursive: true });

let template;
try { template = fs.readFileSync(path.join(bundleDir, 'cordis.patch.template.yml'), 'utf8'); }
catch { fail('cannot read cordis.patch.template.yml'); }

const quote = value => `'${value.replace(/'/g, "''")}'`;
const body = template
  .split('\n')
  .filter(line => !line.startsWith('#'))            // drop template header, it is not valid output context
  .join('\n')
  .replace('__PLUGIN_ENTRY__', quote(pathToFileURL(entry).href))
  .replace('__HOST_COMMAND__', quote(hostPath))
  .replace('__ARTIFACT_ROOT__', quote(artifactsDir));

const patch = [
  `# Generated for this machine by scripts/prepare.mjs — do not commit, do not redistribute.`,
  `# entry: ${pathToFileURL(entry).href}`,
  `# host:  ${hostPath}`,
  body.replace(/^\n+/, ''),
].join('\n');

const target = path.join(bundleDir, 'cordis.patch.yml');
fs.writeFileSync(target, patch, { mode: 0o600 });

process.stdout.write([
  '已生成：' + target,
  '  bundle-dir  ' + bundleDir + '   ← 安装这个目录',
  '  entry       ' + pathToFileURL(entry).href,
  '  hostCommand ' + hostPath,
  '  artifactRoot ' + artifactsDir,
  '',
  '下一步（顺序不能反）：',
  '  1. 在 DSH 插件页把上面的 bundle-dir 作为本地 bundle 安装；',
  '  2. 重载后，新建会话，在首个 Turn 之前选择预设「本机任务准入」；',
  '  3. 按 docs/install.md 的 A–E 五步验证。',
  '',
  '注意：这个目录不要移动或删除——安装记录指向它。升级时换新目录重装。',
  '',
].join('\n'));
