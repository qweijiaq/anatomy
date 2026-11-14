# cast

## 这次分析在解决什么

该仓库的设计决策如下。

## 最值得学的 1 件事

1. 从引用代码看：这里有一个具体的设计决定

## 这次分析的可信度

- 已取证点占比：100.0%
- 被丢弃证据数：0
- 每点平均证据数：1

## 分析口径

每条引用写作 `path:起止行`。想核对就把这条引用原样交给 `ana inspect`（例如 `ana inspect path/to/file.ts:12-20`），取回的是这一轮真正读过的原文；证据存在分析结果里，删了源码树也一样。

- 来源：https://github.com/spf13/cast
- 根目录：<repo-root>/quality-sample/.runs/93e979a58bca/tree/cast-d8e892d16caba3fc13f781dcf4b3f4dd8976999c
- 规模：39 个文件 / 112119 字节 / 4358 行
- 语言：go 21
- 排除：没有文件被排除

## 1. 从引用代码看：这里有一个具体的设计决定

- 类型：数据模型
- 置信度：高

**约束**：待模型补全 —— 待模型补全

**常见做法与代价**

- 待模型补全 —— 待模型补全

**他们怎么做**

待模型补全

`basic.go:3-3`

```
// Use of this source code is governed by an MIT-style
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

`map.go:14-14`

```
func toMapE[K comparable, V any](i any, keyFn func(any) K, valFn func(any) V) (map[K]V, error) {
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

`slice.go:3-3`

```
// Use of this source code is governed by an MIT-style
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

`time.go:37-37`

```
		// For now, using json.Number's own Int64 method should be good enough to preserve backwards compatibility.
```

**为什么有效**

待模型补全

**代价**

- 待模型补全 —— 待模型补全

## 值得自己去看的位置

扫描共给出 8 个候选点。**分数是规则命中累加，不是质量评分**——它只说明这里同时符合几条启发式，不说明这里一定值得学。

| 位置 | 所在声明 | 类型 | 分 | 命中的规则 |
| --- | --- | --- | --- | --- |
| `basic.go:17` | `ToBoolE` (function) | complexity | 4 | complexity:guard-ladder、abstraction:type-switch |
| `basic.go:70` | `ToStringE` (function) | complexity | 4 | complexity:guard-ladder、complexity:long-function、abstraction:type-switch |
| `map.go:65` | `ToStringMapStringSliceE` (function) | complexity | 4 | complexity:guard-ladder、complexity:long-function、abstraction:type-switch |
| `slice.go:82` | `ToStringSliceE` (function) | complexity | 4 | complexity:guard-ladder、abstraction:type-switch |
| `time.go:26` | `ToTimeInDefaultLocationE` (function) | complexity | 4 | complexity:guard-ladder、abstraction:type-switch |
| `time.go:64` | `ToDurationE` (function) | complexity | 4 | complexity:guard-ladder、abstraction:type-switch |
| `map.go:21` | `toMapE` (function) | abstraction | 2 | abstraction:type-switch |
| `map.go:148` | `toStringMapIntE` (function) | abstraction | 2 | abstraction:type-switch |

**信号分布**：complexity 6、abstraction 2

## 代码集中在哪

按行数排的前 10 个文件（共 39 个）：

| 文件 | 行 | 字节 | 占全部行数 |
| --- | --- | --- | --- |
| `number.go` | 549 | 10248 | 13% |
| `number_test.go` | 466 | 13905 | 11% |
| `time_test.go` | 292 | 10918 | 7% |
| `map_test.go` | 290 | 11072 | 7% |
| `slice_test.go` | 284 | 7319 | 7% |
| `zz_generated.go` | 261 | 5896 | 6% |
| `cast_test.go` | 241 | 4663 | 6% |
| `map.go` | 212 | 4366 | 5% |
| `number_internal_test.go` | 187 | 4313 | 4% |
| `basic_test.go` | 166 | 3541 | 4% |

行数是文件的物理行数，包含空行和注释——它衡量的是「要翻多久」，不是「逻辑有多重」。


## 没看的部分

**分析口径之外**

- 跳过：报告正文写了 1 个点，另有 0 个已核实但没有写进正文。

**没进正文的判断**

- 没有可核对证据的点：0 个
- 被降级的点：0 个
- 被丢弃的点：0 个
