#!/usr/bin/env bash
# One command, one verdict: what state is this repository in?
#
# `verify` answers "does it still work". This answers the question a reader who was
# handed the project actually asks — is anything left half-done, does the tree agree
# with its own documentation, and can a clean checkout reproduce it. Each line below
# is computed, not asserted: a check that cannot fail is not a check.
#
# It is short on purpose. Reading the whole tree to answer this question takes far
# longer than running it, and the answer should not depend on who is reading.
set -u -o pipefail

cd "$(dirname "$0")/.." || { echo "AUDIT: NOT READY (not a checkout)"; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

failures=0
line() { printf '%-14s %s\n' "$1" "$2"; }
bad() { failures=$((failures + 1)); line "$1" "FAIL — $2"; }

echo "anatomy audit"
echo "-----------------------------------------------"

# 1. The gate. Everything else is secondary to this one, and it prints its own
#    summary, so the audit quotes it rather than repeating it.
if npm run verify --silent > "$work/verify.txt" 2>&1; then
  gate=$(grep -E '^VERIFY: PASS' "$work/verify.txt" | head -1)
  line gate "${gate:-passed}"
  tests=$(grep -oE 'Tests +[0-9]+ passed' "$work/verify.txt" | head -1 | grep -oE '[0-9]+')
  line tests "${tests:-unknown} passed"
else
  bad gate "npm run verify exited non-zero"
  tail -5 "$work/verify.txt" | sed 's/^/               /'
  tests=""
fi

# 2. The tree. A claim about a checkout is a claim about a commit.
if [ -n "$(git status --porcelain)" ]; then
  bad tree "uncommitted changes: $(git status --porcelain | wc -l | tr -d ' ') path(s)"
else
  branch=$(git rev-parse --abbrev-ref HEAD)
  head=$(git rev-parse --short HEAD)
  if git rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
    upstream=$(git rev-parse --short '@{upstream}')
    if [ "$head" = "$upstream" ]; then
      line tree "$branch at $head, clean, pushed"
    else
      bad tree "$branch at $head but upstream is $upstream"
    fi
  else
    line tree "$branch at $head, clean (no upstream configured)"
  fi
fi

# 3. Generated output must not be tracked: it goes stale and it lies about the source.
tracked_artifacts=$(git ls-files | grep -cE '^(dist|dist-renderer|dist-electron|out|\.ana|node_modules)/' || true)
if [ "$tracked_artifacts" -ne 0 ]; then
  bad artefacts "$tracked_artifacts generated path(s) are tracked"
else
  line artefacts "none tracked"
fi

# 4. The numbers the documentation claims, against the numbers just measured.
#
# Every document that states a count is read. The first version of this line grepped
# README.md and printed "README and EVIDENCE agree" — a claim about a file it never
# opened, which is the pattern this repository keeps having to fix. EVIDENCE.md said
# "32 个文件 / 749 个测试" the whole time and nothing noticed.
#
# A document that does not state a number is not a failure; one that states a wrong
# number is, and the message names which.
measure_files=$(ls tests/*.test.ts 2>/dev/null | wc -l | tr -d ' ')
version=$(node -e 'process.stdout.write(require("./package.json").version)')
cli_version=$(node dist/cli.js --version 2>/dev/null | tr -d '[:space:]')

stale=""
# `check_tests <file> <pattern>`: the count a document states must be the count run.
check_tests() {
  local file=$1 pattern=$2 got
  [ -f "$file" ] || return 0
  got=$(grep -oE "$pattern" "$file" | head -1 | grep -oE '^[0-9]+' | tr -d ' ')
  [ -z "$got" ] && return 0
  [ "$got" = "$tests" ] || stale="$stale $file says $got"
}
check_tests README.md '[0-9]+ tests'
# `[^文]` keeps `73 个测试文件` — the count of test files inside the npm tarball —
# out of a check about how many tests the suite runs. Two different numbers that read
# the same until the character after them.
check_tests README.zh-CN.md '[0-9]+ 个测试[^文]'
check_tests docs/superpowers/EVIDENCE.md '[0-9]+ 个测试[^文]'
check_tests docs/superpowers/PROGRESS.md '[0-9]+ 个测试[^文]'

# The file count is stated in two places with a fixed wording, so it can be read.
evidence_files=$(grep -oE '[0-9]+ 个文件 / [0-9]+ 个测试' docs/superpowers/EVIDENCE.md 2>/dev/null | head -1 | grep -oE '^[0-9]+')
progress_files=$(grep -oE '[0-9]+ 个测试文件' docs/superpowers/PROGRESS.md 2>/dev/null | head -1 | grep -oE '^[0-9]+')
[ -n "$evidence_files" ] && [ "$evidence_files" != "$measure_files" ] && stale="$stale EVIDENCE says $evidence_files files"
[ -n "$progress_files" ] && [ "$progress_files" != "$measure_files" ] && stale="$stale PROGRESS says $progress_files files"

[ "$cli_version" = "$version" ] || stale="$stale ana --version says $cli_version"

# The tracked snapshot is a receipt for an older tree; the fresh run above is the
# authority. Saying which commit it belongs to is the difference between a citation
# and a claim.
snapshot=$(grep -oE '\| 提交 \| `[0-9a-f]+`' docs/superpowers/verify-output.txt 2>/dev/null | grep -oE '[0-9a-f]{7,}')
if [ -z "$snapshot" ]; then
  snapshot_note="no snapshot on file"
elif git diff --quiet "$snapshot" HEAD -- . ':!docs/superpowers/verify-output.txt' 2>/dev/null; then
  # The snapshot is written before it is committed, so it always trails HEAD by its
  # own commit. What matters is whether anything else changed between the two —
  # if not, the recorded numbers describe this tree.
  snapshot_note="snapshot ${snapshot:0:7} describes HEAD's tree"
else
  snapshot_note="snapshot ${snapshot:0:7} predates HEAD"
fi

if [ -n "$stale" ]; then
  bad docs "stale numbers:$stale (measured: $tests tests, $measure_files files)"
else
  line docs "README (en/zh), EVIDENCE and PROGRESS say $tests tests / $measure_files files; v$version; $snapshot_note"
fi

# 5. Markers that mean somebody stopped mid-thought.
# This script names the markers it looks for, so it is excluded from its own scan.
markers=$(grep -rInE '\b(TODO|FIXME|XXX|HACK)\b' src renderer/src electron scripts 2>/dev/null \
  --exclude=audit.sh | wc -l | tr -d ' ')
if [ "$markers" -ne 0 ]; then
  bad markers "$markers TODO/FIXME in source"
  grep -rInE '\b(TODO|FIXME|XXX|HACK)\b' src renderer/src electron scripts 2>/dev/null \
    --exclude=audit.sh | head -5 | sed 's/^/               /'
else
  line markers "none in src, renderer, electron, scripts"
fi

# 6. The surfaces that are documented as existing.
# Only the `Commands:` block: option lines start with `--`, which the same pattern
# would also match.
commands=$(node dist/cli.js --help 2>/dev/null | sed -n '/^Commands:/,/^Options:/p' | grep -cE '^  [a-z][a-z-]* ')
tools=$(grep -ohE "name: 'anatomy_[a-z_]+'" src/commands/mcp.ts 2>/dev/null | wc -l | tr -d ' ')
line surface "$commands CLI commands, $tools MCP tools"

# 7. The documents a handoff rests on — and every `docs/` path they point at.
#
# Listing the files this script happens to know about was not enough: AGENTS.md
# pointed twice at documents that did not exist (`docs/architecture.md` and
# `docs/decisions/`), and each time the list was satisfied. So the paths are read out
# of the documents themselves.
missing=""
for doc in README.md README.zh-CN.md AGENTS.md docs/desktop.md docs/superpowers/PROGRESS.md docs/superpowers/EVIDENCE.md docs/superpowers/specs/2026-11-12-anatomy-design.md; do
  [ -f "$doc" ] || missing="$missing $doc"
done

# A `docs/...` path named in a handoff document must exist. Paths under `out/` and
# `.ana/` are produced by running the project, so they are not expected here.
for doc in README.md README.zh-CN.md AGENTS.md docs/desktop.md; do
  [ -f "$doc" ] || continue
  for path in $(grep -oE '`docs/[A-Za-z0-9_./-]+`' "$doc" | tr -d '`' | sort -u); do
    case "$path" in
      *out/*|\.ana/*) continue ;;
    esac
    [ -e "$path" ] || missing="$missing $path (named in $doc)"
  done
done

if [ -n "$missing" ]; then
  bad docs-files "missing:$missing"
else
  line docs-files "every document named, and every docs/ path they point at"
fi

echo "-----------------------------------------------"
if [ "$failures" -eq 0 ]; then
  echo "AUDIT: READY — every check above was computed from this checkout."
  exit 0
fi
echo "AUDIT: NOT READY — $failures check(s) failed."
exit 1
