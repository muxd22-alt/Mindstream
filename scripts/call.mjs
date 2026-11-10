#!/usr/bin/env node
// Tiny helper used by GitHub Actions to call the Worker's /internal/* endpoints.
// Usage: node scripts/call.mjs /internal/scout '{"persona_ids":["elon"]}'
const [, , path, body = '{}', method = 'POST'] = process.argv;

const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const token = process.env.INTERNAL_TOKEN || '';

if (!base) {
  console.error('PUBLIC_BASE_URL is not set');
  process.exit(1);
}
if (!token) {
  console.error('INTERNAL_TOKEN is not set');
  process.exit(1);
}

const res = await fetch(`${base}${path}`, {
  method,
  headers: { 'content-type': 'application/json', 'x-internal-token': token },
  body: method === 'GET' ? undefined : body,
});

const text = await res.text();
console.log(`${method} ${path} → ${res.status}`);
console.log(text.slice(0, 4000));

if (!res.ok) process.exit(1);
