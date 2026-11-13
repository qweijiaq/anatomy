#!/usr/bin/env bash
# Record one `npm run verify` run into docs/superpowers/verify-output.txt.
#
# The header carries the commit it was generated at and the shape of the tree at
# that moment, because a read-only reviewer cannot execute the gate. Without those
# two facts the transcript is just text claiming a result; with them, `git log -1 --
# docs/superpowers/verify-output.txt` and `git show <sha>:package.json` let someone
# tie the numbers to a commit without running anything.
set -u -o pipefail

cd "$(dirname "$0")/.." || exit 1

commit=$(git rev-parse HEAD)
tracked=$(git ls-files | wc -l | tr -d ' ')
# Top-level only: the fixtures contain test files of their own, and counting those
# would make the recorded number disagree with what vitest actually runs.
test_files=$(git ls-files 'tests/*.test.ts' | grep -cE '^tests/[^/]+\.test\.ts$')
stamp=$(date '+%Y-%m-%d %H:%M')

log=$(npm run verify 2>&1)
status=$?
last=$(printf '%s\n' "$log" | grep -E '^VERIFY: ' | tail -1)

cat > docs/superpowers/verify-output.txt <<REPORT
# verify.sh 输出 — 快照

**这是一次运行的历史记录，不是实时数据。** 要当前输出就重新跑 \`npm run verify\`。

| | |
|---|---|
| 生成于 | ${stamp} |
| 提交 | \`${commit}\` |
| 退出码 | ${status} |
| 当时跟踪的文件数 | ${tracked} |
| 当时的测试文件数 | ${test_files} |

一行就能把这份记录钉在树上：\`git show ${commit}:package.json | grep version\`。
若当前 HEAD 与上面的提交不同，数字就属于旧树，以重跑为准。

\`\`\`
${log}
\`\`\`

末行：\`${last}\`
REPORT

echo "$last"
exit "$status"
