// Validates public/slate.json so a pull request can't break the vote page or the API.
import { readFileSync } from 'node:fs';

const slate = JSON.parse(readFileSync(new URL('../public/slate.json', import.meta.url)));
const errors = [];
const ids = new Set();

if (!Array.isArray(slate.fixed) || slate.fixed.length > 2) errors.push('fixed lists at most two set seats');
for (const s of slate.seats ?? []) {
  if (!/^[a-z0-9-]+$/.test(s.id ?? '')) errors.push(`bad seat id: ${s.id}`);
  if (ids.has(s.id)) errors.push(`duplicate seat id: ${s.id}`);
  ids.add(s.id);
  if (!s.seat || !s.mission) errors.push(`${s.id}: seat and mission are required`);
  if (!['clear', 'close call'].includes(s.confidence)) errors.push(`${s.id}: confidence must be "clear" or "close call"`);
  if (!Array.isArray(s.candidates) || s.candidates.length < 1 || s.candidates.length > 6) {
    errors.push(`${s.id}: needs 1 to 6 candidates`);
    continue;
  }
  for (const c of s.candidates) {
    if (!c.name || !c.bio) errors.push(`${s.id}: every candidate needs a name and a bio`);
    if ((c.bio ?? '').length > 220) errors.push(`${s.id}/${c.name}: bio over 220 characters`);
    if (/https?:/i.test(`${c.bio} ${c.evidence ?? ''}`)) errors.push(`${s.id}/${c.name}: no links in bios`);
  }
}
if (!ids.size) errors.push('no seats');

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`slate ok: ${ids.size} seats`);
