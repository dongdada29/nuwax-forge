import { USAGE } from './args.mjs';

export async function runHelp() {
  process.stdout.write(USAGE + '\n');
}
