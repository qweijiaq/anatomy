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

- 来源：https://github.com/alecthomas/chroma
- 根目录：/Users/weijia/Desktop/anatomy/eval/quality-sample/.runs/5c9560834e1e/tree/chroma-08dd759d11a8f31603634ecbeb6b35bca6810ffb
- 规模：1566 个文件 / 11100788 字节 / 287655 行
- 语言：go 74、js 3、py 3
- 排除：binary 2

## 1. 从引用代码看：这里有一个具体的设计决定

- 类型：数据模型
- 置信度：高

**约束**：待模型补全（待模型补全）

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

**约束**：待模型补全（待模型补全）

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

**约束**：待模型补全（待模型补全）

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

**约束**：待模型补全（待模型补全）

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

**约束**：待模型补全（待模型补全）

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
