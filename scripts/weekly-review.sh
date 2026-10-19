#!/usr/bin/env bash
# Weekly AI review: export votes, write-ins and feedback, have Claude digest them, save the report locally.
# Nothing on the live site changes. Proposed updates go through a normal pull request after Daryll's OK.
# Runs from systemd user timer `balanced-ticket-review.timer` (see README).
set -euo pipefail
cd "$(dirname "$0")/.."
day=$(date +%F)
out=private/reviews
mkdir -p "$out"
python3 -I scripts/export-feedback.py > "$out/$day-raw.md"

prompt='You are reviewing a week of public input for The Balanced Ticket, an open-source, nonpartisan people'"'"'s ticket.
Below are the vote totals, every write-in with its reason, and open feedback. Write a short report for the maintainer:
1. Seat by seat, only where something changed: who is leading, any write-in with real momentum, and why people back them.
2. The top 5 themes in the feedback, with a count and one representative paraphrase each (no quotes of private text).
3. Concrete proposed updates (add a write-in to the slate, add a seat, reword something), each with the evidence.
4. Anything that looks like vote stuffing or coordinated spam.
Be factual and brief. Do not judge anyone'"'"'s politics.'

# The input is public text, so Claude gets no tools at all: a feedback note that says "run this" can't run anything.
claude -p --tools "" --strict-mcp-config "$prompt" < "$out/$day-raw.md" > "$out/$day.md"
command -v notify-send >/dev/null && notify-send "Balanced Ticket weekly review" "Report ready: $PWD/$out/$day.md" || true
echo "$out/$day.md"
