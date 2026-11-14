# ms

## 这次分析在解决什么

该仓库的设计决策如下。

## 最值得学的 1 件事

1. 从引用代码看：这里有一个具体的设计决定

## 这次分析的可信度

- 已取证点占比：66.7%
- 被丢弃证据数：5
- 每点平均证据数：0.67

## 分析口径

每条引用写作 `path:起止行`。想核对就把这条引用原样交给 `ana inspect`（例如 `ana inspect path/to/file.ts:12-20`），取回的是这一轮真正读过的原文；证据存在分析结果里，删了源码树也一样。

- 来源：https://github.com/vercel/ms
- 根目录：<repo-root>/quality-sample/.runs/823cdcfc530e/tree/ms-4ff48cec099f0514c3e9bbca18706c9c21122bfb
- 规模：22 个文件 / 52402 字节 / 1849 行
- 语言：ts 8
- 排除：lockfile 1

## 1. 从引用代码看：这里有一个具体的设计决定

- 类型：数据模型
- 置信度：高

**约束**：待模型补全 —— 待模型补全

**常见做法与代价**

- 待模型补全 —— 待模型补全

**他们怎么做**

待模型补全

`src/index.ts:78-78`

```
    /^(?<value>-?\d*\.?\d+) *(?<unit>milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|months?|mo|years?|yrs?|y)?$/i.exec(
```

**为什么有效**

待模型补全

**代价**

- 待模型补全 —— 待模型补全

## 值得自己去看的位置

扫描共给出 8 个候选点。**分数是规则命中累加，不是质量评分**——它只说明这里同时符合几条启发式，不说明这里一定值得学。

| 位置 | 所在声明 | 类型 | 分 | 命中的规则 |
| --- | --- | --- | --- | --- |
| `src/index.ts:50` | `ms` (function) | abstraction | 4 | abstraction:overload:ms、complexity:self-recursive |
| `src/index.ts:1` | `s` (const) | abstraction | 2 | abstraction:imported-by-4-importing-nothing |
| `src/format.test.ts:19` | — | test-spec | 1 | test-spec:assertion-density |
| `src/format.test.ts:29` | — | test-spec | 1 | test-spec:assertion-density |
| `src/format.test.ts:39` | — | test-spec | 1 | test-spec:assertion-density |
| `src/format.test.ts:49` | — | test-spec | 1 | test-spec:assertion-density |
| `src/format.test.ts:61` | — | test-spec | 1 | test-spec:assertion-density |
| `src/format.test.ts:73` | — | test-spec | 1 | test-spec:assertion-density |

**信号分布**：test-spec 6、abstraction 2

## 这个仓库的形状

- 模块：8 个；其中 7 个没有任何文件导入它
- 被依赖最多: `src/index.ts` (4)
- 入口: `src/index.ts`
- 清单文件: `package.json`
- 测试 / CI / 文档：有 / 有 / 有

这些数字来自结构索引，没有经过模型。它们只说明代码长什么样，不说明写得好不好。

## 代码集中在哪

按行数排的前 10 个文件（共 22 个）：

| 文件 | 行 | 字节 | 占全部行数 |
| --- | --- | --- | --- |
| `src/index.test.ts` | 387 | 10774 | 21% |
| `src/format.test.ts` | 261 | 8058 | 14% |
| `src/index.ts` | 244 | 5864 | 13% |
| `src/parse-strict.test.ts` | 221 | 6329 | 12% |
| `src/parse.test.ts` | 208 | 5086 | 11% |
| `README.md` | 207 | 6444 | 11% |
| `package.json` | 54 | 1474 | 3% |
| `.github/workflows/release.yml` | 49 | 1167 | 3% |
| `.github/workflows/quality.yml` | 36 | 718 | 2% |
| `.github/workflows/test.yml` | 35 | 712 | 2% |

行数是文件的物理行数，包含空行和注释——它衡量的是「要翻多久」，不是「逻辑有多重」。


## 没看的部分

**分析口径之外**

- 跳过：全部 1 个已核实的点都写进了报告。

**没进正文的判断**

- 没有可核对证据的点：1 个
- 被降级的点：1 个
- 被丢弃的点：5 个
- 丢弃原因：sample —— snippet is not on line 60 of src/format.test.ts
- 丢弃原因：sample —— snippet is not on line 60 of src/format.test.ts
- 丢弃原因：sample —— snippet is not on line 60 of src/format.test.ts
- 丢弃原因：sample —— snippet is not on line 60 of src/format.test.ts
- 丢弃原因：sample —— snippet is not on line 60 of src/format.test.ts
- 降级原因：sample —— no verifiable evidence
