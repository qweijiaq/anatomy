# object.assign

## 这次分析在解决什么

该仓库的设计决策如下。

## 最值得学的 1 件事

1. 从引用代码看：这里有一个具体的设计决定

## 这次分析的可信度

- 已取证点占比：75.0%
- 被丢弃证据数：0
- 每点平均证据数：0.75

## 分析口径

每条引用写作 `path:起止行`。想核对就把这条引用原样交给 `ana inspect`（例如 `ana inspect path/to/file.ts:12-20`），取回的是这一轮真正读过的原文；证据存在分析结果里，删了源码树也一样。

- 来源：https://github.com/ljharb/object.assign
- 根目录：<repo-root>/quality-sample/.runs/66e331d66428/tree/object.assign-7f6aa5ae8a297c4e227648a52fd6e03a564b0f8a
- 规模：30 个文件 / 39012 字节 / 1266 行
- 语言：js 13
- 排除：没有文件被排除

## 1. 从引用代码看：这里有一个具体的设计决定

- 类型：数据模型
- 置信度：高

**约束**：待模型补全 —— 待模型补全

**常见做法与代价**

- 待模型补全 —— 待模型补全

**他们怎么做**

待模型补全

`implementation.js:24-24`

```
		var getSymbols = hasSymbols && ($Object.getOwnPropertySymbols || originalGetSymbols);
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

`hasSymbols.js:30-30`

```
	if (typeof Object.getOwnPropertyNames === 'function' && Object.getOwnPropertyNames(obj).length !== 0) { return false; }
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

`test/tests.js:65-65`

```
		st.deepEqual(assign({ a: 1 }, { b: 2 }, undefined), { a: 1, b: 2 }, 'ignores undefined source');
```

**为什么有效**

待模型补全

**代价**

- 待模型补全 —— 待模型补全

## 值得自己去看的位置

扫描共给出 4 个候选点。**分数是规则命中累加，不是质量评分**——它只说明这里同时符合几条启发式，不说明这里一定值得学。

| 位置 | 所在声明 | 类型 | 分 | 命中的规则 |
| --- | --- | --- | --- | --- |
| `implementation.js:6` | `callBound` (const) | algorithm | 2 | algorithm:named-algorithm |
| `index.js:12` | `bound` (const) | algorithm | 2 | algorithm:named-algorithm |
| `hasSymbols.js:5` | `keys` (const) | complexity | 1 | complexity:guard-ladder |
| `test/tests.js:8` | `mockProperty` (const) | complexity | 1 | complexity:long-function |

**信号分布**：algorithm 2、complexity 2

## 这个仓库的形状

- 模块：13 个；其中 13 个没有任何文件导入它
- 入口: `index.js`
- 清单文件: `package.json`
- 测试 / CI / 文档：无 / 有 / 有

这些数字来自结构索引，没有经过模型。它们只说明代码长什么样，不说明写得好不好。

## 代码集中在哪

按行数排的前 10 个文件（共 30 个）：

| 文件 | 行 | 字节 | 占全部行数 |
| --- | --- | --- | --- |
| `CHANGELOG.md` | 246 | 9715 | 19% |
| `test/tests.js` | 232 | 7853 | 18% |
| `README.md` | 136 | 3819 | 11% |
| `package.json` | 96 | 2345 | 8% |
| `polyfill.js` | 55 | 1299 | 4% |
| `test/shimmed.js` | 52 | 1914 | 4% |
| `test/native.js` | 49 | 1868 | 4% |
| `implementation.js` | 46 | 1424 | 4% |
| `hasSymbols.js` | 43 | 1618 | 3% |
| `bower.json` | 31 | 484 | 2% |

行数是文件的物理行数，包含空行和注释——它衡量的是「要翻多久」，不是「逻辑有多重」。


## 没看的部分

**分析口径之外**

- 跳过：报告正文写了 1 个点，另有 0 个已核实但没有写进正文。

**没进正文的判断**

- 没有可核对证据的点：1 个
- 被降级的点：1 个
- 被丢弃的点：0 个
- 降级原因：sample —— no verifiable evidence
