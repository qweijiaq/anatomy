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

- 来源：https://github.com/ljharb/object.assign
- 根目录：/Users/weijia/Desktop/anatomy/eval/quality-sample/.runs/0f1f405d1d5a/tree/object.assign-7f6aa5ae8a297c4e227648a52fd6e03a564b0f8a
- 规模：30 个文件 / 39012 字节 / 1266 行
- 语言：js 13
- 排除：没有文件被排除

## 1. 从引用代码看：这里有一个具体的设计决定

- 类型：数据模型
- 置信度：高

**约束**：待模型补全（待模型补全）

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

**约束**：待模型补全（待模型补全）

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

**约束**：待模型补全（待模型补全）

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

## 没看的部分

**分析口径之外**

- 跳过：报告正文写了 1 个点，另有 0 个已核实但没有写进正文。

**没进正文的判断**

- 没有可核对证据的点：1 个
- 被降级的点：1 个
- 被丢弃的点：0 个
- 降级原因：sample —— no verifiable evidence
