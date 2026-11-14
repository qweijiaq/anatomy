# 真模型跑出来的数字

这份文件回答一个此前从未被量化的问题：**换成真模型，报告质量是多少。**

在此之前所有数字都来自确定性 stub——`npm run verify`、`npm run eval:recall`、`eval/quality-sample`
全部如此。stub 能证明管线的形状，不能证明判断力。

## 条件

| | |
|---|---|
| 模型 | `deepseek-chat`（provider 报回 `deepseek-flash`） |
| 端点 | `https://api.deepseek.com/v1` |
| 参数 | `--top 8 --points 4` |
| 日期 | 2026-11-14 |
| 仓库 | gold 集里的五个小仓库 |
| 判读 | 每个候选一次调用，综述一次，没有任何人工挑选 |

## 结果

| 仓库 | 进正文的点 | 已取证点占比 | 被丢弃证据 | 每点平均证据 | 引用条数 |
|---|---|---|---|---|---|
| `unjs/defu` | 2 | 100% | 3 | 3.5 | 7 |
| `sindresorhus/delay` | 2 | 100% | 1 | 3.5 | 7 |
| `jorgebucaran/colorette` | 2 | 100% | 0 | 2.0 | 4 |
| `spf13/cast` | 4 | 100% | 4 | 3.25 | 13 |
| `sindresorhus/debounce-fn` | 1 | 100% | 0 | 2.5 | 3 |

**五份报告的已取证点占比都是 100%。** 这是产品最核心的那条不变量：写进正文的每一条，
都核对到了具体的行，而且片段逐字相同。丢弃数是「模型写了但核对不过」的条数——它不为零，
说明校验器在工作，而不是没得可丢。

产出点数为 1–4，gold 集的金标是 3–4 条，量级相当。

## 正文长什么样

`unjs/defu` 的两条（原文照抄）：

```
## 1. 用工厂函数把合并策略参数化为可复用的 defu 变体
## 2. 用穷举式反例表锁定 isPlainObject 的边界语义
```

`pallets/click`（91 个模块、3 万行，Python）的三条：

```
1. 无法取得底层二进制流时退回原文本流，宁可乱码也不抛异常
2. 用 _FixupStream 适配器补齐旧式/被篡改流缺失的 io 接口
3. 公共 API 只做薄转发，平台实现延迟到调用时导入
```

这三条只有在真的读过 `_compat.py` 和 `_compat.py` 里的适配器分支之后才写得出来，
不是注释的改写。

## 这份数字不能说明什么

- **不能说明召回率。** 候选召回仍然是 `eval:recall` 的 61%（那个数字与模型无关，是扫描层
  的事）。
- **不能说明文笔好坏。** 一份报告读起来是否值得，需要人读。这五份里有两条我判断是好的，
  一条（`debounce-fn` 只出 1 个点）偏薄。
- **不能外推到别的模型。** 换 provider、换模型名，这些数字要重跑。

## 怎么重跑

```bash
export ANA_API_KEY=... ANA_BASE_URL=... ANA_MODEL=...
for repo in https://github.com/unjs/defu https://github.com/sindresorhus/delay; do
  node dist/cli.js analyze "$repo" --top 8 --points 4
done
node dist/cli.js runs | head
```

`runs` 每行末尾是 run id，`ana report <id>` 重看，`ana inspect <path:起止行>` 核对任意一条引用。
