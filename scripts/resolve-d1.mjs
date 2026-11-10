#!/usr/bin/env node
// Injects D1_DATABASE_ID into wrangler.toml at build time, so the repo never
// needs to contain a real database id and nothing has to be edited by hand.
import { readFile, writeFile } from 'node:fs/promises';

const id = (process.env.D1_DATABASE_ID || '').trim();
const path = 'wrangler.toml';
const toml = await readFile(path, 'utf8');

if (!id) {
  console.log('D1_DATABASE_ID not set — leaving wrangler.toml untouched.');
  process.exit(0);
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
  console.error('D1_DATABASE_ID does not look like a UUID. Check vars.D1_DATABASE_ID.');
  process.exit(1);
}

const next = toml.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${id}"`);
if (next === toml && !toml.includes(id)) {
  console.error('Could not find database_id in wrangler.toml');
  process.exit(1);
}
await writeFile(path, next);
console.log(`wrangler.toml → D1 ${id}`);
