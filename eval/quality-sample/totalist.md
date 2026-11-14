# totalist

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

- 来源：https://github.com/lukeed/totalist
- 根目录：<repo-root>/quality-sample/.runs/90972b8fdc5f/tree/totalist-4b071d3e54d466a4059de89006c752da782c8b02
- 规模：18 个文件 / 11091 字节 / 401 行
- 语言：js 7、ts 2
- 排除：没有文件被排除

## 1. 从引用代码看：这里有一个具体的设计决定

- 类型：数据模型
- 置信度：高

**约束**：待模型补全 —— 待模型补全

**常见做法与代价**

- 待模型补全 —— 待模型补全

**他们怎么做**

待模型补全

`src/async.js:8-8`

```
export async function totalist(dir, callback, pre='') {
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

`src/sync.js:4-4`

```
export function totalist(dir, callback, pre='') {
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

`test/async.js:30-30`

```
	assert.equal(styles.sort(), ['aaa/index.css', 'bbb/ccc/index.css', 'bbb/index.css'].map(normalize).sort(), 'style `name` values are expected');
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

`test/sync.js:29-29`

```
	assert.equal(styles, ['aaa/index.css', 'bbb/ccc/index.css', 'bbb/index.css'].map(normalize), 'style `name` values are expected');
```

**为什么有效**

待模型补全

**代价**

- 待模型补全 —— 待模型补全

## 值得自己去看的位置

扫描共给出 6 个候选点。**分数是规则命中累加，不是质量评分**——它只说明这里同时符合几条启发式，不说明这里一定值得学。

| 位置 | 所在声明 | 类型 | 分 | 命中的规则 |
| --- | --- | --- | --- | --- |
| `src/async.js:8` | `totalist` (function) | complexity | 4 | complexity:self-recursive、idiom:delegates-whole-body |
| `src/sync.js:4` | `totalist` (function) | complexity | 1 | complexity:self-recursive |
| `test/async.js:13` | `fixtures` (const) | test-spec | 1 | test-spec:assertion-density |
| `test/async.js:34` | `fixtures` (const) | test-spec | 1 | test-spec:assertion-density、test-spec:fixture-heavy |
| `test/sync.js:12` | `fixtures` (const) | test-spec | 1 | test-spec:assertion-density |
| `test/sync.js:33` | `fixtures` (const) | test-spec | 1 | test-spec:assertion-density、test-spec:fixture-heavy |

**信号分布**：test-spec 4、complexity 2

## 这个仓库的形状

- 模块：7 个；其中 5 个没有任何文件导入它
- 被依赖最多: `src/async.js` (1)、`src/sync.js` (1)
- 清单文件: `package.json`
- 测试 / CI / 文档：无 / 有 / 有

这些数字来自结构索引，没有经过模型。它们只说明代码长什么样，不说明写得好不好。

## 代码集中在哪

按行数排的前 10 个文件（共 18 个）：

| 文件 | 行 | 字节 | 占全部行数 |
| --- | --- | --- | --- |
| `readme.md` | 109 | 2847 | 27% |
| `package.json` | 55 | 1108 | 14% |
| `test/async.js` | 55 | 1824 | 14% |
| `test/sync.js` | 54 | 1718 | 13% |
| `.github/workflows/ci.yml` | 36 | 828 | 9% |
| `src/async.js` | 22 | 556 | 5% |
| `license` | 21 | 1114 | 5% |
| `src/sync.js` | 15 | 414 | 4% |
| `.editorconfig` | 12 | 182 | 3% |
| `.gitignore` | 10 | 78 | 2% |

行数是文件的物理行数，包含空行和注释——它衡量的是「要翻多久」，不是「逻辑有多重」。


## 没看的部分

**分析口径之外**

- 跳过：报告正文写了 1 个点，另有 0 个已核实但没有写进正文。
- 备注：could not resolve package.json entry "dist/index.js": outside the analysed scope

**没进正文的判断**

- 没有可核对证据的点：0 个
- 被降级的点：0 个
- 被丢弃的点：0 个
