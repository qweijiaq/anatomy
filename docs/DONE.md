# 什么时候算做完

这个文件只回答一个问题：**这个项目做到什么程度，就可以交出去、不再需要继续优化。**

它不解释产品（README 做那件事），也不列证据（`docs/superpowers/EVIDENCE.md` 做那件事）。
它是一条一条**可以判真假**的条件，每条都给出两种核对方式：读一遍，或者跑一条命令。

任何一种方式得到否定，这条就不成立，项目就还没做完。全部成立，这个目标就到此为止——
往后只剩用户报回来的缺陷，那不是"继续优化"，那是修 bug。

---

## 条件

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
| 11 | 干净检出能复现全部 | 见下 | `docs/superpowers/EVIDENCE.md` 的 Clean checkout |
| 12 | 已知的局限写在明处，不藏着 | — | `docs/desktop.md` 的「还没做」、README 的「未做」 |

第 11 条单独写，因为它是一次性的、慢的：

```bash
git clone --depth 1 https://github.com/qweijiaq/anatomy.git /tmp/x && cd /tmp/x
npm ci && npm run verify        # 末行应为 VERIFY: PASS
```

---

## 明确不在这个目标之内

写下来，是因为「还能做什么」永远不会用完，需要有地方把它关掉：

- **`ana publish`** —— 托管版报告。裁定理由在 README 里：报告是绑在证据上的，托管会诱导
  读者把它当成一个页面。
- **打包成 `.dmg` 分发** —— `electron-builder` 未接入。要本地双击运行，`npm run build:bundle`
  已经够用。
- **窗口里的逐条证据交互** —— 报告里的引用可以在 CLI 用 `ana inspect` 取回；窗口不做这件事，
  因为它不做耗时操作。
- **召回率再往上** —— 61% 是这套方法的实测上限，不是没做完的部分。要更高需要另一套候选
  生成方式，那是新项目。

---

## 判定

十二条全部成立时，`npm run audit` 的末行是 `AUDIT: READY`，且本文件每一条的「跑出来核对」
都能照做。这时继续"优化"没有外部依据——**需要的是有人用，然后把不顺手的地方报回来。**
