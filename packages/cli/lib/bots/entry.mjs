#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { botPlan, checkBot, prepareBot } from './profile.mjs';
import { runBotForeground } from './launch.mjs';

const HELP = `DS-Bot integration (original plugin on real DSH; no model call during prepare/check)
Usage: node packages/cli/lib/bots/entry.mjs <plan|prepare|check|run> --root <new-absolute-directory> --dsh <absolute-dsh-path> [--json]
  plan     Show pinned artifact, owned paths and native DSH commands; no writes
  prepare  Create an isolated web profile; install verified ds-bot@0.2.7 without scripts
           Optional --tarball <absolute-original-npm-tgz> avoids artifact download
  check    Check DSH version, artifact, original exports/files and composed entries
  run      Explicit foreground web host on 127.0.0.1; --port <0..65535>, default 0
           Optional --open opens the native local link in your default browser
           Ctrl-C stops the host; reuse the same root to keep the team
Requires DSH 0.2.1-rc.5. No existing profile or credentials are imported.
First-use walkthrough: docs/BOT-QUICKSTART.md
`;

export function parseBotArgs(argv) {
  if (argv.length === 0 || (argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0]))) return { help: true };
  const [command, ...rest] = argv;
  if (!['plan', 'prepare', 'check', 'run'].includes(command)) throw new Error('Expected plan, prepare, check or run');
  const options = {}; const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (!['--root', '--dsh', '--tarball', '--port', '--json', '--open'].includes(key) || seen.has(key)) throw new Error('Unknown or duplicate option: ' + key);
    seen.add(key);
    if (key === '--json') { options.json = true; continue; }
    if (key === '--open') { options.open = true; continue; }
    if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) throw new Error('Missing value: ' + key);
    options[{ '--root': 'root', '--dsh': 'binary', '--tarball': 'tarball', '--port': 'port' }[key]] = rest[++i];
  }
  if (options.tarball && command !== 'prepare') throw new Error('--tarball is only supported by prepare');
  if (options.open && command !== 'run') throw new Error('--open is only supported by run');
  if (options.port !== undefined && command !== 'run') throw new Error('--port is only supported by run');
  if (options.port !== undefined) {
    if (!/^\d+$/.test(options.port)) throw new Error('--port must be an integer from 0 to 65535');
    options.port = Number(options.port);
  }
  if (options.json && command === 'run') throw new Error('run streams the original host output; --json is not supported');
  botPlan(options);
  return { command, options };
}

export async function main(argv = process.argv.slice(2)) {
  return runBotCommand(parseBotArgs(argv));
}

export async function runBotCommand(parsed) {
  if (parsed.help) { process.stdout.write(HELP); return; }
  const { command, options } = parsed;
  if (command === 'run') {
    process.exitCode = await runBotForeground(options);
    return;
  }
  const result = command === 'plan' ? botPlan(options) : command === 'prepare' ? await prepareBot(options) : checkBot(options);
  process.stdout.write(options.json ? JSON.stringify(result, null, 2) + '\n' : `${command}: ${result.pin.name}@${result.pin.version}; DSH ${result.dshVersion ?? result.pin.dshVersion}; profile ${result.paths.profile}\nroot: ${result.paths.root}\ninstallation: ${result.acceptance.installation}; composition: ${result.acceptance.composition}; host/UI/model behavior: not run\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const message = error?.code ? `Operation failed (${error.code})` : error.message;
    process.stderr.write('forge bots: ' + message + '\n');
    process.exitCode = 1;
  });
}
