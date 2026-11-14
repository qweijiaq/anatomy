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
version=$(node -e 'process.stdout.write(require("./package.json").version)')
claimed=$(grep -oE '[0-9]+ tests' README.md | head -1 | grep -oE '[0-9]+')
if [ -n "$tests" ] && [ -n "$claimed" ] && [ "$tests" != "$claimed" ]; then
  bad docs "README says $claimed tests, the suite ran $tests"
else
  line docs "README and EVIDENCE agree with $version and ${tests:-?} tests"
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

# 7. The documents a handoff rests on.
missing=""
for doc in README.md README.zh-CN.md AGENTS.md docs/desktop.md docs/superpowers/PROGRESS.md docs/superpowers/EVIDENCE.md docs/superpowers/specs/2026-11-12-anatomy-design.md; do
  [ -f "$doc" ] || missing="$missing $doc"
done
if [ -n "$missing" ]; then
  bad docs-files "missing:$missing"
else
  line docs-files "README (en/zh), AGENTS, design spec, desktop, progress, evidence"
fi

echo "-----------------------------------------------"
if [ "$failures" -eq 0 ]; then
  echo "AUDIT: READY — every check above was computed from this checkout."
  exit 0
fi
echo "AUDIT: NOT READY — $failures check(s) failed."
exit 1
