#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { initializeBridge } from './bridge.mjs';
if (process.argv.length !== 3) throw new Error('Usage: node integrations/ds-bot-forge/setup.mjs /absolute/operator-config.json');
console.log(JSON.stringify(initializeBridge(JSON.parse(readFileSync(process.argv[2], 'utf8'))), null, 2));
