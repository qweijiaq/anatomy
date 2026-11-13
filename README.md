<p align="center">
  <img src="docs/assets/banner.svg" alt="anatomy — evidence-backed design notes for a repository" width="100%">
</p>

<h1 align="center">anatomy</h1>

<p align="center">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-2f7d5d"></a>
  <a href="package.json"><img alt="node" src="https://img.shields.io/badge/node-%E2%89%A522.14-17191d"></a>
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a> · <a href="docs/desktop.md">Desktop app</a>
</p>

Takes an open-source repository apart into **design notes backed by line-level evidence**: the decisions worth learning, what they cost, and the exact line to read. A claim that fails verification never appears in the report.

Source code is public; the scarce thing is judgement — picking the twenty decisions worth studying out of two hundred thousand lines.

```bash
npm install
npm run verify        # the last line should read VERIFY: PASS
```

That is the whole check. It runs the tests, the typecheck, the build, and then the
CLI end to end against a local stub model — no API key and no network — and it
cleans up after itself. Nothing else needs to run to know the repository is sound.

Do not use `npm start` or `npm run dev:*` for this: they open a window and never
exit.

## Desktop app

```bash
npm run build:desktop && npm run start:desktop
```

Paste a repository URL into the window and the analysis runs. The model key is configured inside the app and encrypted on the machine (the renderer never sees it). The provider presets are the same set as reading-notes, including Anthropic's native protocol. Details in [docs/desktop.md](docs/desktop.md).

## Commands

Four that need source:

```bash
ana scan <repo>                  # zero model calls: tells you where to look
ana analyze <repo> [--top 12]    # full analysis, writes a report
ana report <runId>               # re-render from stored artefacts (works after the tree is deleted)
ana inspect <evidenceId>         # print one piece of evidence: file and verbatim snippet
```

Four that do not, via [REA](https://github.com/morluto/rea) — no model called at all:

```bash
ana inspect-app <dir>            # reconstruct from shipped artefacts: modules, IPC, contextBridge, storage
ana app-report <name>            # the facts report for one application
ana app-diff <a> <b>             # what changed on the boundary between two builds
ana forget <id> [--app]          # delete one stored analysis
```

`inspect-app` needs Node ^22.23.4 || ^24.22.1 || >=26.12.1 and a `rea` it can run
(`npx rea-agents setup`, or point `ANA_REA` at its `scripts/rea.mjs`). A whole
application takes minutes; `--path preload.cjs` analyses only the small files that
declare the boundary, usually in a second or two.

`<repo>` is a GitHub URL, any tarball URL, or a local directory. It analyses the latest release tag by default; `--ref` overrides it, `--subpath` narrows a monorepo to one subtree.

A real run needs model credentials:

```bash
export ANA_MODEL=gpt-4o-mini  ANA_API_KEY=sk-...
node dist/cli.js analyze https://github.com/sindresorhus/quick-lru --top 8
```

## What a report looks like

The opening of a real run (`sindresorhus/quick-lru`), report body in Chinese:

```markdown
# quick-lru

## 这次分析在解决什么

一个小型工具库，用语言内建结构替代显式的数据结构。

## 最值得学的 1 件事

1. 用插入顺序维护淘汰顺序，不额外维护链表

## 这次分析的可信度

- 已取证点占比：100.0%
- 被丢弃证据数：0
- 每点平均证据数：1

## 分析口径

- 来源：https://github.com/sindresorhus/quick-lru
- 规模：13 个文件 / 62687 字节 / 2606 行
```

Every point in the body carries a locator such as `index.js:1-1` and a verbatim snippet. The report always ends with "what I did not read", listing unsupported languages, candidates dropped by the budget, and withheld points.

## Two invariants

The whole value of the product rests on these two, and the code is organised around them:

1. **No fabrication.** Everything the model writes is a claim pending verification. `src/kernel/evidence.ts` compares the snippet against the bytes on disk, and `src/writing/judge.ts` rejects any line number the model was never shown. Only what passes both reaches the page.
2. **The analysed repository is never executed.** No `git clone`, no dependency install, no scripts. Python is parsed with `ast`; the sidecar starts with `-I` and a sanitised environment so a repository cannot shadow the standard library with its own `ast.py`.

## Structure

```
src/kernel/     LLM-free forensic kernel: acquire, profile, structure map, signals, evidence check, budget
src/writing/    the only layer that spends tokens: prompts, judge, ranking, synthesis
src/render/     one dataset, two renderings: narrative + collapsible recipe, and JSON
src/app/        REA adapter: the call, its progress, fact grouping, diffs
src/commands/   scan / analyze / report / inspect / inspect-app / app-report / app-diff / forget
eval/           gold set and recall scripts (npm run eval)
```

## Known blind spots

29 gold repositories, 90 annotated points, current candidate recall **60%**.

Which means four annotated points in ten never become candidates at all, and no model can write about a line it was never shown. The number stays in the repository because that is more useful than hiding it:

```bash
npm run eval:recall
```

## Not built yet

- MCP server, `ana publish`.
- Structure analysis for languages other than TypeScript/JavaScript and Python.
- **A judgement report for an application without source.** REA reconstructs what
  the code does; inferring why it was designed that way needs a second verifier
  (against `evidence_id` rather than bytes on disk), and until that exists the
  honest output is the facts report.

Design, plan and execution records live in `docs/superpowers/PROGRESS.md`.
