#!/usr/bin/env node
// 单正本同步：contracts/schemas/verification-v1.schema.json 是唯一正本，
// stack 技能分发持有字节一致的自包含副本。--check 只校验不写。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CANON = join(PKG, 'schemas', 'verification-v1.schema.json');
const COPY = resolve(PKG, '../nuwax-stack/skills/nuwax-stack/references/verification-v1.schema.json');
const check = process.argv.includes('--check');
const sha = b => createHash('sha256').update(b).digest('hex');

const canonical = readFileSync(CANON);
if (!existsSync(COPY)) {
  if (check) {
    console.error(`FAIL stack 副本不存在：${COPY}（npm run contracts:sync 生成）`);
    process.exit(1);
  }
  mkdirSync(dirname(COPY), { recursive: true });
  writeFileSync(COPY, canonical);
  console.log(`synced stack copy <- canonical (${sha(canonical).slice(0, 12)})`);
  process.exit(0);
}
const copy = readFileSync(COPY);
if (copy.equals(canonical)) {
  console.log(`OK 字节一致 (${sha(canonical).slice(0, 12)})：正本与 stack 副本无漂移`);
  process.exit(0);
}
if (check) {
  console.error(`FAIL 字节漂移：canonical=${sha(canonical).slice(0, 12)} stack=${sha(copy).slice(0, 12)}`);
  console.error('     以正本为准：npm --workspace @nuwax-ai/devkit-contracts run sync');
  process.exit(1);
}
writeFileSync(COPY, canonical);
console.log(`repaired stack copy -> canonical (${sha(canonical).slice(0, 12)})`);
