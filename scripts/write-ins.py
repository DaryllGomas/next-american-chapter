#!/usr/bin/env python3
"""See the top write-ins, and promote one onto the ballot.

  scripts/write-ins.py list [--local] [--min 10]
  scripts/write-ins.py promote <seat-id> "<Name>" --bio "<two short sentences>" [--local] [--dry-run]

promote adds the person to public/slate.json as a new top pick for that seat, then moves everyone who wrote that
name in over to a real vote for them, so nobody loses their vote. Deploy afterwards (npx wrangler deploy).
Run list/promote against the live database by default; --local uses the wrangler dev database.
"""
import argparse
import json
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SLATE = ROOT / 'public' / 'slate.json'
DB = 'next-american-chapter'


def name_key(name):
    # Must match nameKey() in src/worker.js: drop accents, keep letters and digits in any script.
    plain = ''.join(c for c in unicodedata.normalize('NFKD', name) if not unicodedata.combining(c)).lower()
    key = ''.join(c for c in plain if c.isalnum() or c == ' ')
    return re.sub(r'\s+', ' ', key).strip()


def sql_quote(s):
    return "'" + s.replace("'", "''") + "'"


def d1(sql, local):
    cmd = ['npx', '-y', 'wrangler@4', 'd1', 'execute', DB, '--local' if local else '--remote', '--json', '--command', sql]
    out = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    if out.returncode:
        sys.exit(out.stderr or out.stdout)
    return json.loads(out.stdout)[0]['results']


def cmd_list(args):
    rows = d1(
        'SELECT seat, MIN(name) AS name, name_key, COUNT(*) AS n FROM alternatives '
        f'GROUP BY seat, name_key HAVING n >= {int(args.min)} ORDER BY n DESC LIMIT 100',
        args.local,
    )
    if not rows:
        print(f'No write-ins with {args.min}+ backers yet.')
    for r in rows:
        print(f"{r['n']:>6}  {r['seat']:<24} {r['name']}")


def cmd_promote(args):
    slate = json.loads(SLATE.read_text())
    seat = next((s for s in slate['seats'] if s['id'] == args.seat), None)
    if not seat:
        sys.exit(f"Unknown seat {args.seat!r}. Seats: {', '.join(s['id'] for s in slate['seats'])}")
    key = name_key(args.name)
    if any(name_key(c['name']) == key for c in seat['candidates']):
        sys.exit(f'{args.name} is already on the ballot for {args.seat}.')

    choice = f"c{len(seat['candidates'])}"
    move = (
        f"UPDATE votes SET choice = '{choice}' WHERE seat = {sql_quote(args.seat)} AND choice = 'alt' AND voter_hash IN "
        f"(SELECT voter_hash FROM alternatives WHERE seat = {sql_quote(args.seat)} AND name_key = {sql_quote(key)}); "
        f"DELETE FROM alternatives WHERE seat = {sql_quote(args.seat)} AND name_key = {sql_quote(key)};"
    )
    backers = d1(
        f'SELECT COUNT(*) AS n FROM alternatives WHERE seat = {sql_quote(args.seat)} AND name_key = {sql_quote(key)}',
        args.local,
    )[0]['n']
    print(f'{args.name}: {backers} write-in votes on {args.seat} become votes for choice {choice}.')
    if args.dry_run:
        print('Dry run. Would run:\n' + move)
        return

    # Slate first: the worker must accept the new choice before votes point at it. Deploy right after.
    seat['candidates'].append({'name': args.name, 'bio': args.bio, 'writeIn': True})
    SLATE.write_text(json.dumps(slate, indent=2, ensure_ascii=False) + '\n')
    d1(move, args.local)
    print('Done. Now deploy: npx wrangler deploy')


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='cmd', required=True)
    ls = sub.add_parser('list')
    ls.add_argument('--min', type=int, default=3)
    ls.add_argument('--local', action='store_true')
    pr = sub.add_parser('promote')
    pr.add_argument('seat')
    pr.add_argument('name')
    pr.add_argument('--bio', required=True)
    pr.add_argument('--local', action='store_true')
    pr.add_argument('--dry-run', action='store_true')
    args = p.parse_args()
    {'list': cmd_list, 'promote': cmd_promote}[args.cmd](args)


if __name__ == '__main__':
    main()
