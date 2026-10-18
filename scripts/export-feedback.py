#!/usr/bin/env python3
"""Export everything voters told us, ready to hand to an LLM for a digest.

  scripts/export-feedback.py [--local] > feedback-export.md

Includes vote totals per seat, every write-in with its reason and sniff-test status, and all open feedback.
Paste the output into ChatGPT/Claude/Grok with a prompt like: "Summarize what people want changed, seat by seat, and
which write-ins have real momentum and why."
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = 'next-american-chapter'


def d1(sql, local):
    cmd = ['npx', '-y', 'wrangler@4', 'd1', 'execute', DB, '--local' if local else '--remote', '--json', '--command', sql]
    out = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    if out.returncode:
        sys.exit(out.stderr or out.stdout)
    return json.loads(out.stdout)[0]['results']


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--local', action='store_true')
    args = p.parse_args()

    slate = json.loads((ROOT / 'public' / 'slate.json').read_text())
    names = {s['id']: s for s in slate['seats']}
    votes = d1('SELECT seat, choice, COUNT(*) AS n FROM votes GROUP BY seat, choice', args.local)
    alts = d1('SELECT seat, name, reason, approved FROM alternatives ORDER BY seat, name_key', args.local)
    notes = d1('SELECT text, created_at FROM feedback ORDER BY created_at', args.local)

    print('# The Balanced Ticket: what voters said\n')
    print('## Votes\n')
    for v in votes:
        seat = names.get(v['seat'])
        if not seat:
            continue
        who = 'write-in' if v['choice'] == 'alt' else seat['candidates'][int(v['choice'][1:])]['name']
        print(f"- {seat['seat']}: {who}: {v['n']}")
    print('\n## Write-ins\n')
    for a in alts:
        status = 'passed sniff test' if a['approved'] else 'not yet screened'
        reason = a['reason'] or '(backed an existing write-in)'
        print(f"- {names.get(a['seat'], {}).get('seat', a['seat'])}: **{a['name']}** ({status}): {reason}")
    print('\n## Open feedback\n')
    for n in notes:
        print(f"- {n['text']}")


if __name__ == '__main__':
    main()
