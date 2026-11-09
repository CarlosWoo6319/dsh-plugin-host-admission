#!/usr/bin/env node
// Refuses to build a distributable tarball from a working tree that contains the
// machine-specific patch: it holds absolute paths (host binary, evidence directory)
// that must never leave this machine.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generated = path.join(root, 'cordis.patch.yml');

if (fs.existsSync(generated)) {
  process.stderr.write([
    'guard-pack: 检测到本机生成的 cordis.patch.yml（含绝对路径），拒绝打包。',
    '  处理：移走或删除该文件后再打包；它由 `node scripts/prepare.mjs` 按机器生成，',
    '  不需要随包分发，也不应提交。',
    '',
  ].join('\n'));
  process.exit(1);
}

// Defence in depth: even if the file is renamed, a real home directory must not ship.
// Placeholders such as /Users/you/... are fine; an actual account name is not.
const home = process.env.HOME || '';
const usersPattern = /\/(?:Users|home)\/([^/\s'"`]+)/g;
const allowedNames = new Set(['you', 'yourname', 'demo', 'example', 'user', 'username', 'name', 'shared']);
function leaksAbsolutePath(content) {
  if (home && content.includes(home + '/')) return true;
  for (const match of content.matchAll(usersPattern)) {
    const name = match[1];
    if (name.startsWith('<') || allowedNames.has(name.toLowerCase())) continue;
    return true;
  }
  return false;
}

const inspected = ['README.md', 'docs', 'demo', 'index.mjs', 'cordis.patch.template.yml'];
for (const entry of inspected) {
  const target = path.join(root, entry);
  if (!fs.existsSync(target)) continue;
  const files = fs.statSync(target).isDirectory()
    ? fs.readdirSync(target, { recursive: true }).map(name => path.join(target, name))
    : [target];
  for (const file of files) {
    if (!fs.statSync(file).isFile() || file.endsWith('.png')) continue;
    if (leaksAbsolutePath(fs.readFileSync(file, 'utf8'))) {
      process.stderr.write(`guard-pack: ${path.relative(root, file)} 含绝对机器路径，拒绝打包。\n`);
      process.exit(1);
    }
  }
}

process.stdout.write('guard-pack: OK（无本机 patch、无绝对路径）\n');
