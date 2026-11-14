#!/usr/bin/env bash
# Record one `npm run audit` into docs/superpowers/audit-output.txt.
#
# Why a file at all: every other proof in this repository is a command you run. A
# reader who cannot run commands — a reviewer without the toolchain, an agent whose
# shell is denied — has had to reconstruct the verdict from source, which takes far
# more steps than this project wants to demand of anyone. The receipt is the same
# eight lines the audit prints, with the commit they belong to in the header, so the
# claim can be tied to a tree instead of to a memory.
set -u -o pipefail

cd "$(dirname "$0")/.." || exit 1

commit=$(git rev-parse HEAD)
short=$(git rev-parse --short HEAD)
stamp=$(date '+%Y-%m-%d %H:%M')
# The file this script writes is not a change to the reason for the verdict; counting
# it would make every recorded run describe the previous record instead of the tree.
dirty=$(git status --porcelain | grep -v 'docs/superpowers/audit-output.txt' || true)
clean=$( [ -z "$dirty" ] && echo clean || echo "dirty" )

log=$(npm run audit --silent 2>&1)
status=$?

cat > docs/superpowers/audit-output.txt <<REPORT
# audit 输出 — 快照

**这是一次运行的历史记录，不是实时数据。** 要当前结论就重新跑 \`npm run audit\`。

| | |
|---|---|
| 生成于 | ${stamp} |
| 提交 | \`${commit}\` |
| 工作区 | ${clean} |
| 退出码 | ${status} |

一行就能把这份记录钉在树上：\`git show ${commit}:package.json | grep version\`。
若当前 HEAD 与上面的提交不同，先看 \`git diff ${short} HEAD --stat\`：只动了这份记录，
结论就仍然成立；动了别的，以重跑为准。

\`\`\`
${log}
\`\`\`
REPORT

printf '%s\n' "$log" | grep -E '^AUDIT: ' || true
exit "$status"
