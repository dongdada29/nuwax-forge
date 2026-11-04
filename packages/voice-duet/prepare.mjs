// Apache-2.0. Prepare a complete, pinned upstream plugin without executing it.
import {execFileSync} from 'node:child_process'
import {readFileSync, mkdirSync, writeFileSync, rmSync, realpathSync} from 'node:fs'
import {resolve, dirname, basename, relative, isAbsolute, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'

export const COMMIT = '143de3f30c61d323568b3863d2e5badeb47123e7'
const here = dirname(fileURLToPath(import.meta.url))
const read = name => readFileSync(join(here, name), 'utf8')
const baseline = JSON.parse(read('baseline.json'))
export const patches = JSON.parse(read('patch.json'))
const sha = value => createHash('sha256').update(value).digest('hex')
const contains = (parent, child) => {
  const rel = relative(parent, child)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../')
}

// Also used by small offline fixtures; production preparation always verifies blobs first.
export function applyPatches(blobs) {
  const out = {...blobs}
  for (const {file, old, new: replacement} of patches) {
    if (!out[file] || out[file].toString().split(old).length !== 2) throw Error('patch_context_drift: ' + file)
    out[file] = Buffer.from(out[file].toString().replace(old, replacement))
  }
  out['src/host/trace.mjs'] = Buffer.from(read('trace.mjs'))
  out['src/host/forge-policy.mjs'] = Buffer.from(read('policy.mjs'))
  return out
}
export function transform(blobs) {
  for (const [file, hash] of Object.entries(baseline)) {
    if (!blobs[file] || sha(blobs[file]) !== hash) throw Error('upstream_file_drift: ' + file)
  }
  const out = applyPatches(blobs)
  out['FORGE-MODIFICATIONS.json'] = Buffer.from(JSON.stringify({
    upstream: 'https://github.com/YuMS/dsh-duet', version: '0.1.10', commit: COMMIT,
    modified: [...new Set([...patches.map(p => p.file), 'src/host/trace.mjs', 'src/host/forge-policy.mjs'])],
    scope: 'Audio-free trace metadata and TLS validation; original entry, client and DSH manifest preserved.'
  }, null, 2) + '\n')
  return out
}
export function prepare(source, destination) {
  const sourceRoot = realpathSync(source)
  const git = args => execFileSync('git', ['--no-optional-locks', '-C', sourceRoot, ...args], {
    maxBuffer:32*1024*1024,
    env:{PATH:process.env.PATH, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null', GIT_NO_REPLACE_OBJECTS:'1'}
  })
  if (realpathSync(git(['rev-parse', '--show-toplevel']).toString().trim()) !== sourceRoot) throw Error('upstream_must_be_repository_root')
  if (git(['rev-parse', 'HEAD']).toString().trim() !== COMMIT) throw Error('upstream_version_mismatch')
  const requested = resolve(destination)
  const dest = join(realpathSync(dirname(requested)), basename(requested))
  if (!contains(realpathSync(process.cwd()), dest)) throw Error('destination_outside_workspace')
  if (contains(sourceRoot, dest) || contains(dest, sourceRoot)) throw Error('destination_overlaps_source')
  const modes = new Map()
  const blobs = Object.fromEntries(git(['ls-tree', '-rz', COMMIT]).toString().split('\0').filter(Boolean).map(row => {
    const [meta, file] = row.split('\t'), [mode, type] = meta.split(' ')
    if (type !== 'blob' || !['100644', '100755'].includes(mode) || file.split('/').some(s => !s || s === '..' || s === '.git') || isAbsolute(file)) throw Error('unsupported_upstream_entry')
    modes.set(file, mode === '100755' ? 0o700 : 0o600)
    return [file, git(['show', `${COMMIT}:${file}`])]
  }))
  const out = transform(blobs) // Validate all inputs before reserving a fresh destination.
  mkdirSync(dest, {mode:0o700}) // Exclusive: never merge or overwrite an existing path.
  try {
    for (const [file, bytes] of Object.entries(out)) {
      const target = join(dest, file)
      mkdirSync(dirname(target), {recursive:true, mode:0o700})
      writeFileSync(target, bytes, {flag:'wx', mode:modes.get(file) || 0o600})
    }
  } catch (error) { rmSync(dest, {recursive:true, force:true}); throw error }
  return dest
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw Error('usage: node prepare.mjs READ_ONLY_UPSTREAM NEW_DIRECTORY')
  console.log(prepare(process.argv[2], process.argv[3]))
}
