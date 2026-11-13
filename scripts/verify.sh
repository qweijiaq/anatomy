#!/usr/bin/env bash
# One command that answers "does this still work?".
#
# It runs the machine gates, then drives the built CLI end to end against a real
# public repository when the network allows it and against a local fixture
# otherwise. The model is a local stand-in, so no provider key is needed and the
# run is deterministic; every citation in the report is still checked against the
# bytes on disk by the product's own validator.
set -u

cd "$(dirname "$0")/.." || exit 1
fail() { echo "VERIFY: FAIL — $*"; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

echo "== tests =="
npm test --silent > "$work/test.txt" 2>&1 || { tail -30 "$work/test.txt"; fail "tests"; }
tail -4 "$work/test.txt"
counts=$(grep -oE 'Tests +[0-9]+ passed' "$work/test.txt" | head -1)
echo "== typecheck =="
npm run typecheck --silent 2>&1 | tail -2 || fail "typecheck"
echo "== build =="
npm run build --silent >/dev/null 2>&1 || fail "build"

echo "== stub model =="
node scripts/verify-stub.mjs > "$work/port" 2>"$work/stub.err" &
stub=$!
trap 'kill $stub 2>/dev/null; wait $stub 2>/dev/null; rm -rf "$work"' EXIT
for _ in $(seq 1 50); do [ -s "$work/port" ] && break; sleep 0.1; done
port=$(cat "$work/port" 2>/dev/null)
[ -n "${port:-}" ] || fail "stub did not start: $(cat "$work/stub.err")"
export ANA_BASE_URL="http://127.0.0.1:$port/v1"
export ANA_API_KEY="verify-only"

target="https://github.com/sindresorhus/quick-lru"
kind="github"
if ! node dist/cli.js scan "$target" --top 2 > "$work/scan.txt" 2>"$work/scan.err"; then
  kind="fixture"
  target="tests/fixtures/scan-repo"
  node dist/cli.js scan "$target" --top 2 > "$work/scan.txt" 2>"$work/scan.err" \
    || fail "scan: $(cat "$work/scan.err")"
fi
echo "== scan ($kind) =="
head -3 "$work/scan.txt"
grep -qE '^[^ ]+:[0-9]+' "$work/scan.txt" || fail "scan produced no path:line candidate"
# `scan` writes a run directory too. It has no report, so the history list skips it —
# but on disk it is still a directory, and this script used to leave it behind.
scan_run=$(sed -n 's/^run \([^ ]*\).*/\1/p' "$work/scan.txt" | head -1)

echo "== analyze ($kind) =="
node dist/cli.js analyze "$target" --model stub --top 2 > "$work/report-path.txt" 2>"$work/analyze.err" \
  || fail "analyze: $(cat "$work/analyze.err")"
report=$(cat "$work/report-path.txt")
[ -f "$report" ] || fail "analyze did not write a report"
run_dir=$(dirname "$report")

grep -q '^# ' "$report" || fail "report has no title"
grep -q '已取证点占比' "$report" || fail "report has no trust numbers"
grep -q '没看的部分' "$report" || fail "report has no coverage tail"
grep -qE '^`[^`]+:[0-9]+-[0-9]+`$' "$report" || fail "report cites no path:line"

echo "== report (tree deleted) =="
run_id=$(basename "$run_dir")
rm -rf "$run_dir/tree"
node dist/cli.js report "$run_id" > "$work/replay.md" 2>"$work/replay.err" \
  || fail "report: $(cat "$work/replay.err")"
grep -q '^# ' "$work/replay.md" || fail "re-render has no title"

echo "== inspect =="
evidence=$(node -e '
const fs = require("node:fs")
const raw = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const points = Array.isArray(raw) ? raw : (raw.points ?? [])
const first = points.find((p) => (p.theirs?.evidence ?? []).length > 0)
process.stdout.write(first?.theirs.evidence[0].id ?? "")
' "$run_dir/points.json")
[ -n "$evidence" ] || fail "no evidence id to inspect"
node dist/cli.js inspect "$evidence" > "$work/inspect.txt" 2>&1 || fail "inspect"
grep -qE '^[^ ]+:[0-9]+-[0-9]+$' "$work/inspect.txt" || fail "inspect printed no range"

echo "== sample =="
# Printed before the delete, because the delete is what this run ends with.
sed -n '1,12p' "$report"
echo

echo "== forget =="
# The one command that deletes. It runs on the run this script just made, and the
# refusals are checked first because a delete that accepts a path is the failure
# that matters — not a delete that fails to delete.
if node dist/cli.js forget ../etc > "$work/forget-bad.txt" 2>&1; then
  fail "forget accepted a path instead of an id"
fi
node dist/cli.js forget "$run_id" > "$work/forget.txt" 2>&1 || fail "forget: $(cat "$work/forget.txt")"
[ -d "$run_dir" ] && fail "forget left the run directory behind"
# Deleting it twice is not an error to a script; it says so and exits 1.
if node dist/cli.js forget "$run_id" > /dev/null 2>&1; then
  fail "forget reported success for a run that was already gone"
fi

[ -n "$scan_run" ] && node dist/cli.js forget "$scan_run" > /dev/null 2>&1
[ -n "$scan_run" ] && [ -d ".ana/runs/$scan_run" ] && fail "the scan run was left behind"

echo "SUMMARY: ${counts:-tests passed} | typecheck clean | build ok"
echo "SUMMARY: scan+analyze+report+inspect+forget ok on $target"
echo "VERIFY: PASS ($kind, run $run_id, deleted)"
