#!/usr/bin/env node
// Entry point for every hook in hooks/hooks.json. A reminder must never break the
// session, so any failure here exits 0 and says nothing.
import fs from 'node:fs';
import { handle } from './lib.mjs';

let result = {};
try {
  result = handle(JSON.parse(fs.readFileSync(0, 'utf8')), process.env) || {};
} catch {
  process.exit(0);
}

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.code || 0;
