# When this is done / 什么时候算做完

This file answers exactly one question: **how finished does this project have to be
before it can be handed over and needs no further optimization.**

It does not explain the product (README does that) or list evidence
(`docs/superpowers/EVIDENCE.md` does that). It is a list of conditions that can be
judged true or false, each with two ways to check it: read, or run a command. Any one
failing means the project is not done. All thirteen holding means the objective is
satisfied — and what remains is defects reported by somebody using it, which is fixing
bugs, not "further optimization".

---

## Conditions

| # | Condition | Check by running | Check by reading |
|---|---|---|---|
| 1 | The gate passes | `npm run verify` → `VERIFY: PASS` | `docs/superpowers/verify-output.txt` |
| 2 | Three typecheck configs are clean | `npm run typecheck` | `tsconfig.json`, `tsconfig.test.json`, `tsconfig.desktop.json` |
| 3 | Every command is tested, and the list cannot shrink quietly | `npm test` | `tests/cli.test.ts` |
| 4 | The numbers in the docs match what produces them | `npm run audit` (the `docs` line) | `tests/docs-consistency.test.ts` |
| 5 | Every path the docs name exists | `npm run audit` (the `docs-files` line) | `tests/docs-consistency.test.ts` |
| 6 | Claims carry evidence; fabricated line numbers never reach the page | `npm test` | `tests/evidence.test.ts` |
| 7 | The analysed repository's code is never executed | `npm test` | `tests/structure-python.test.ts`, `tests/acquire.test.ts` |
| 8 | A citation in the report returns the text it cites | `ana inspect <path:start-end>` | `tests/inspect.test.ts` |
| 9 | The store is bounded and the gate leaves nothing behind | `ana forget --keep 3` | the cleanup assertion at the end of `scripts/verify.sh` |
| 10 | The window's bridge cannot drift from the preload | `npm test` | `tests/packaging.test.ts` |
| 11 | A clean checkout reproduces all of it | see below | "Clean checkout" in `docs/superpowers/EVIDENCE.md` |
| 12 | The known limits are stated rather than hidden | — | "还没做" in `docs/desktop.md`, "未做" in the READMEs |
| 13 | A real model still writes points whose evidence checks out | see `docs/superpowers/real-model-eval.md` | that file: five gold repos, 100% evidence rate |

Condition 11 is stated separately because it is slow and one-off:

```bash
git clone --depth 1 https://github.com/qweijiaq/anatomy.git /tmp/x && cd /tmp/x
npm ci && npm run verify        # the last line should read VERIFY: PASS
```

---

## Deliberately out of scope

Written down because "what else could be done" never runs out, and something has to
close it:

- **`ana publish`** — hosted reports. The reason is in the README: a report is bound to
  its evidence, and hosting it invites reading it as a page rather than a document with
  citations.
- **A packaged `.dmg`** — `electron-builder` is not wired in. `npm run build:bundle`
  produces a runnable `out/anatomy.app` for local use.
- **Per-evidence interaction in the window** — a citation can be checked with
  `ana inspect`; the window does not do it, because the window does no slow work.
- **A higher recall number** — 61% is the measured ceiling of this approach, not an
  unfinished part. Going past it needs a different candidate generator, which is a
  different project.

---

## Verdict

When all thirteen hold, `npm run audit` ends with `AUDIT: READY`, and every "check by
running" column above can actually be run. At that point further optimization has no
external basis — what is wanted is somebody using the thing and reporting what drags.

---

# 中文版

回答同一个问题：**这个项目做到什么程度，就可以交出去、不再需要继续优化。**

十三条可判真假的条件，每条给出两种核对方式。任何一条不成立，项目就还没做完。全部成立，
这个目标就到此为止——往后只剩用户报回来的缺陷，那是修 bug，不是"继续优化"。

| # | 条件 | 跑出来核对 | 读出来核对 |
|---|---|---|---|
| 1 | 闸门通过 | `npm run verify` → `VERIFY: PASS` | `docs/superpowers/verify-output.txt` |
| 2 | 三套类型检查无诊断 | `npm run typecheck` | `tsconfig.json`、`tsconfig.test.json`、`tsconfig.desktop.json` |
| 3 | 每条命令都被测到，清单不会悄悄缩小 | `npm test` | `tests/cli.test.ts` |
| 4 | 文档里的数字与产出它的东西一致 | `npm run audit`（`docs` 行） | `tests/docs-consistency.test.ts` |
| 5 | 文档指到的路径都存在 | `npm run audit`（`docs-files` 行） | `tests/docs-consistency.test.ts` |
| 6 | 主张都有证据，编造的行号进不了正文 | `npm test` | `tests/evidence.test.ts` |
| 7 | 被分析的仓库的代码从不执行 | `npm test` | `tests/structure-python.test.ts`、`tests/acquire.test.ts` |
| 8 | 报告里的引用能取回原文 | `ana inspect <path:起止行>` | `tests/inspect.test.ts` |
| 9 | 存档有上限，闸门不留下东西 | `ana forget --keep 3` | `scripts/verify.sh` 结尾的清理断言 |
| 10 | 窗口的桥不会和 preload 脱节 | `npm test` | `tests/packaging.test.ts` |
| 11 | 干净检出能复现全部 | 见上 | `docs/superpowers/EVIDENCE.md` 的 Clean checkout |
| 12 | 已知的局限写在明处，不藏着 | — | `docs/desktop.md` 的「还没做」、README 的「未做」 |
| 13 | 真模型写进正文的点，证据仍然核对得上 | 见 `docs/superpowers/real-model-eval.md` | 那份文件：五个 gold 仓库，已取证率 100% |

明确不做的事、以及判定标准，与上面的英文部分逐条相同。
