#!/usr/bin/env bash
# One command that answers "does this still work?".
#
# It runs the machine gates, then drives the built CLI end to end against a real
# public repository when the network allows it and against a local fixture
# otherwise. The model is a local stand-in, so no provider key is needed and the
# run is deterministic; every citation in the report is still checked against the
# bytes on disk by the product's own validator.
# `pipefail` is load-bearing, not decoration: the typecheck gate below pipes into
# `tail`, and a pipeline's exit status is the *last* command's. Without it a
# failing `tsc` was reported as a passing step and the script still printed
# VERIFY: PASS — a gate that cannot fail is worse than no gate, because it is
# believed.
set -u -o pipefail

cd "$(dirname "$0")/.." || exit 1
fail() { echo "VERIFY: FAIL — $*"; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# What the store looked like before this run touched it. The gate deletes the runs it
# knows about, and for three rounds that was read as "the gate leaves nothing behind"
# — it left seven per run, from sections that create a run without naming one. The
# snapshot is the only version of the claim that a new section cannot quietly falsify.
runs_dir=".ana/runs"
apps_dir=".ana/apps"
runs_before=$(ls "$runs_dir" 2>/dev/null | sort)
apps_before=$(ls "$apps_dir" 2>/dev/null | sort)

echo "== tests =="
npm test --silent > "$work/test.txt" 2>&1 || { tail -30 "$work/test.txt"; fail "tests"; }
tail -4 "$work/test.txt"
counts=$(grep -oE 'Tests +[0-9]+ passed' "$work/test.txt" | head -1)
echo "== typecheck =="
# Captured into a variable rather than piped: `$?` after a pipeline is the exit
# status of the pipeline, and `set -o pipefail` covers it, but an explicit check
# states the intent where a reader will look for it.
typecheck_log=$(npm run typecheck --silent 2>&1)
typecheck_status=$?
echo "$typecheck_log" | tail -2
[ "$typecheck_status" -eq 0 ] || fail "typecheck (exit $typecheck_status)"
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

echo "== mcp =="
# The new surface gets gate coverage like everything else. `ana mcp` speaks
# JSON-RPC on stdout, so this drives a real handshake and two tool calls against the
# run this script just made, and checks the replies are answers rather than errors.
# A server that only works when a human types at it is not shipped.
mcp_out=$(printf '%s\n%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"anatomy_report\",\"arguments\":{\"runId\":\"$run_id\"}}}" \
  "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"anatomy_scan\",\"arguments\":{\"repo\":\"$target\",\"top\":2}}}" \
  | node dist/cli.js mcp 2>/dev/null)
printf '%s' "$mcp_out" | grep -q '"name":"anatomy"' || fail "mcp initialize returned no server name"
printf '%s' "$mcp_out" | grep -q 'anatomy_scan' || fail "mcp tools/list listed no tools"
printf '%s' "$mcp_out" | grep -q '"isError":true' && fail "mcp reported a tool error on the happy path"
# The report is JSON-escaped inside the response, so the heading appears as
# `"text":"# …` rather than at the start of a line — an earlier version of this
# check looked for `^# ` and failed against a working server.
printf '%s' "$mcp_out" | grep -q '"text":"# ' || fail "mcp anatomy_report returned no markdown"
echo "  initialize + tools/list + report + scan ok"

echo "== packed package =="
# Everything above runs from the checkout. A user does not: they install a tarball,
# and the two defects found there — an ESM CLI that could not find its own manifest,
# and `electron` listed as a runtime dependency — were invisible from the checkout.
# This step packs, installs into a scratch consumer, and runs the installed binary.
pack_dir="$work/pack"
mkdir -p "$pack_dir/consumer"
npm pack --pack-destination "$pack_dir" > /dev/null 2>&1 || fail "npm pack"
tarball=$(ls "$pack_dir"/anatomy-*.tgz 2>/dev/null | head -1)
[ -n "$tarball" ] || fail "npm pack produced no tarball"
( cd "$pack_dir/consumer" && npm init -y > /dev/null 2>&1 && npm install "$tarball" --no-audit --no-fund > /dev/null 2>&1 ) \
  || fail "installing the tarball"
installed="$pack_dir/consumer/node_modules/.bin/ana"
[ -x "$installed" ] || fail "the installed package has no ana binary"
packed_out=$("$installed" scan tests/fixtures/scan-repo --top 2 2>&1) || fail "the installed ana cannot scan"
printf '%s' "$packed_out" | grep -q '^run ' || fail "the installed ana produced no scan summary"
deps=$(node -e 'const p=require(require("node:path").join(process.argv[1],"package.json"));process.stdout.write(Object.keys(p.dependencies||{}).join(","))' "$pack_dir/consumer/node_modules/anatomy")
case "$deps" in *electron*|*vite*|*react*) fail "the package installs its desktop toolchain ($deps)";; esac
echo "  installed from tarball, scanned ok, runtime deps: $deps"

echo "== sample =="
# Printed before the delete, because the delete is what this run ends with.
sed -n '1,12p' "$report"
echo

echo "== runs =="
# The list has to agree with the store, and the only way to know is to compare it with
# the run this script just produced.
node dist/cli.js runs | grep -q -- "$run_id" || fail "ana runs does not list the run analyze just wrote"
node dist/cli.js runs --json | grep -q "\"$run_id\"" || fail "ana runs --json omits the run"

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

# Anything the run created and no section claimed: removed here, by name, through the
# product's own command — not by `rm`, so the deletion path stays the one users have.
sweep() {
  local dir=$1 before=$2 left=0 id
  [ -d "$dir" ] || return 0
  for id in $(ls "$dir" | sort); do
    echo "$before" | grep -qx -- "$id" && continue
    node dist/cli.js forget "$id" $( [ "$dir" = "$apps_dir" ] && echo --app ) > /dev/null 2>&1
    [ -e "$dir/$id" ] && { left=$((left + 1)); echo "  left behind: $dir/$id"; }
  done
  return "$left"
}
sweep "$runs_dir" "$runs_before" || fail "the gate left $? run(s) behind"
sweep "$apps_dir" "$apps_before" || fail "the gate left $? app director(ies) behind"

echo "SUMMARY: ${counts:-tests passed} | typecheck clean | build ok"
echo "SUMMARY: scan+analyze+report+inspect+forget ok on $target"
echo "VERIFY: PASS ($kind, run $run_id, deleted)"
