# chroma

## 这次分析在解决什么

该仓库的设计决策如下。

## 最值得学的 1 件事

1. 从引用代码看：这里有一个具体的设计决定

## 这次分析的可信度

- 已取证点占比：100.0%
- 被丢弃证据数：2
- 每点平均证据数：1

## 分析口径

每条引用写作 `path:起止行`。想核对就把这条引用原样交给 `ana inspect`（例如 `ana inspect path/to/file.ts:12-20`），取回的是这一轮真正读过的原文；证据存在分析结果里，删了源码树也一样。

- 来源：https://github.com/alecthomas/chroma
- 根目录：<repo-root>/quality-sample/.runs/97bcde1904fa/tree/chroma-08dd759d11a8f31603634ecbeb6b35bca6810ffb
- 规模：1566 个文件 / 11100788 字节 / 287655 行
- 语言：go 74、js 3、py 3
- 排除：binary 2

## 1. 从引用代码看：这里有一个具体的设计决定

- 类型：数据模型
- 置信度：高

**约束**：待模型补全 —— 待模型补全

**常见做法与代价**

- 待模型补全 —— 待模型补全

**他们怎么做**

待模型补全

`delegate.go:56-56`

```
func (d *delegatingLexer) Tokenise(options *TokeniseOptions, text string) (iter.Seq[Token], error) { // nolint: gocognit
```

**为什么有效**

待模型补全

**代价**

- 待模型补全 —— 待模型补全

## 2. 从引用代码看：这里有一个具体的设计决定

- 类型：数据模型
- 置信度：高

**约束**：待模型补全 —— 待模型补全

**常见做法与代价**

- 待模型补全 —— 待模型补全

**他们怎么做**

待模型补全

`_tools/pygments2chroma_xml.py:113-113`

```
        return functools.reduce(lambda a, b: a + b, (process_state_action(a) for a in action))
```

**为什么有效**

待模型补全

**代价**

- 待模型补全 —— 待模型补全

## 3. 从引用代码看：这里有一个具体的设计决定

- 类型：数据模型
- 置信度：高

**约束**：待模型补全 —— 待模型补全

**常见做法与代价**

- 待模型补全 —— 待模型补全

**他们怎么做**

待模型补全

`formatters/html/html.go:307-307`

```
			fmt.Fprintf(w, "<span%s%s>%s\n</span>", f.styleAttr(css, chroma.LineNumbersTable), f.lineIDAttribute(line), f.lineTitleWithLinkIfNeeded(css, lineDigits, line))
```

**为什么有效**

待模型补全

**代价**

- 待模型补全 —— 待模型补全

## 4. 从引用代码看：这里有一个具体的设计决定

- 类型：数据模型
- 置信度：高

**约束**：待模型补全 —— 待模型补全

**常见做法与代价**

- 待模型补全 —— 待模型补全

**他们怎么做**

待模型补全

`regexp.go:232-232`

```
			ruleIndex, rule, groups, namedGroups, err := matchRules(l.Text, l.Pos, selectedRule)
```

**为什么有效**

待模型补全

**代价**

- 待模型补全 —— 待模型补全

## 5. 从引用代码看：这里有一个具体的设计决定

- 类型：数据模型
- 置信度：高

**约束**：待模型补全 —— 待模型补全

**常见做法与代价**

- 待模型补全 —— 待模型补全

**他们怎么做**

待模型补全

`lexers/raku.go:50-50`

```
		colonPairPattern         = `(?<!:)(?<colon>:)(?<key>\w[\w'-]*)(?<opening_delimiters>` + colonPairOpeningBrackets + `)`
```

**为什么有效**

待模型补全

**代价**

- 待模型补全 —— 待模型补全

## 值得自己去看的位置

扫描共给出 8 个候选点。**分数是规则命中累加，不是质量评分**——它只说明这里同时符合几条启发式，不说明这里一定值得学。

| 位置 | 所在声明 | 类型 | 分 | 命中的规则 |
| --- | --- | --- | --- | --- |
| `delegate.go:56` | `Tokenise` (function) | decision-trace | 6 | complexity:deep-nesting、complexity:guard-ladder、complexity:long-function、complexity:self-recursive、decision-trace:because、decision-trace:explains-the-next-declaration、evolution:removed |
| `_tools/pygments2chroma_xml.py:77` | `resolve_emitter` (function) | custom-infra | 5 | custom-infra:emitter、complexity:deep-nesting、complexity:self-recursive |
| `cmd/chromad/static/index.js:221` | `init` (function) | custom-infra | 5 | custom-infra:debounce、abstraction:returns-a-function |
| `formatters/html/html.go:271` | `writeHTML` (function) | decision-trace | 5 | decision-trace:because、decision-trace:deliberately、complexity:deep-nesting、complexity:long-function |
| `formatters/html/html.go:677` | `newStyleCache` (function) | decision-trace | 5 | complexity:Mutex、decision-trace:because |
| `regexp.go:191` | `Iterator` (function) | decision-trace | 5 | complexity:deep-nesting、complexity:long-function、complexity:self-recursive、decision-trace:explains-the-next-declaration、decision-trace:instead of |
| `cmd/chromad/static/index.js:4` | `init` (function) | complexity | 4 | complexity:deep-nesting、complexity:long-function、abstraction:returns-a-function |
| `lexers/raku.go:33` | `rakuRules` (function) | complexity | 4 | complexity:deep-nesting、complexity:long-function、data-integrity:explicit-transaction |

**信号分布**：decision-trace 4、complexity 2、custom-infra 2

## 这个仓库的形状

- 模块：6 个；其中 4 个没有任何文件导入它
- 被依赖最多: `cmd/chromad/static/base64.js` (1)、`cmd/chromad/static/chroma.js` (1)
- 入口: `bin/.binaryen-133.pkg`、`bin/.biome-2.6.3.pkg`、`bin/.bit-0.57.0.pkg`、`bin/.caddy-2.11.7.pkg`、`bin/.enumer-1.6.3.pkg`、`bin/.esbuild-0.28.2.pkg`、`bin/.go-1.27.3.pkg`、`bin/.golangci-lint-2.15.0.pkg`、`bin/.goreleaser-1.26.2.pkg`、`bin/.hyperfine-2.0.0.pkg`、`bin/.lefthook-2.2.2.pkg`、`bin/.python3-3.15.1.pkg`、`bin/.reflex-0.3.2.pkg`、`bin/.svu-3.4.1.pkg`、`bin/.tinygo-0.43.0.pkg`、`bin/.typescript-7.0.2.pkg`、`bin/.uv-0.13.5.pkg`、`bin/.watchexec-2.8.0.pkg`、`bin/README.hermit.md`、`bin/activate-hermit`、`bin/chroma`、`bin/chromad`、`bin/hermit`、`bin/hermit.hcl`
- 清单文件: `_tools/pyproject.toml`、`go.mod`
- 测试 / CI / 文档：有 / 有 / 有

这些数字来自结构索引，没有经过模型。它们只说明代码长什么样，不说明写得好不好。

## 代码集中在哪

按行数排的前 10 个文件（共 1566 个）：

| 文件 | 行 | 字节 | 占全部行数 |
| --- | --- | --- | --- |
| `cmd/chromad/static/bulma.css` | 21564 | 763923 | 7% |
| `lexers/testdata/openedgeabl.expected` | 21196 | 922652 | 7% |
| `lexers/testdata/zig.expected` | 14993 | 622758 | 5% |
| `lexers/testdata/v/v.expected` | 10363 | 398429 | 4% |
| `lexers/testdata/ring.expected` | 8631 | 325556 | 3% |
| `lexers/testdata/fsharp/fsharp.expected` | 6825 | 244232 | 2% |
| `lexers/testdata/openedgeabl.actual` | 5159 | 154699 | 2% |
| `lexers/testdata/wat.expected` | 4895 | 195050 | 2% |
| `lexers/lexers_gen.go` | 4496 | 73149 | 2% |
| `lexers/testdata/tal.expected` | 4212 | 181717 | 1% |

行数是文件的物理行数，包含空行和注释——它衡量的是「要翻多久」，不是「逻辑有多重」。


## 没看的部分

**分析口径之外**

- 跳过：报告正文写了 1 个点，另有 0 个已核实但没有写进正文。
- 备注：unanalysed language: other (actual) (68%)

**没进正文的判断**

- 没有可核对证据的点：0 个
- 被降级的点：0 个
- 被丢弃的点：2 个
- 丢弃原因：sample —— snippet is not on line 29 of cmd/chromad/static/index.js
- 丢弃原因：sample —— snippet is not on line 29 of cmd/chromad/static/index.js
