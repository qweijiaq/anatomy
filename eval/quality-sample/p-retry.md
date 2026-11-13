# p-retry

## 这次分析在解决什么

该仓库的设计决策如下。

## 最值得学的 1 件事

1. 从引用代码看：这里有一个具体的设计决定

## 这次分析的可信度

- 已取证点占比：100.0%
- 被丢弃证据数：2
- 每点平均证据数：1

## 分析口径

- 来源：https://github.com/sindresorhus/p-retry
- 根目录：/Users/weijia/Desktop/anatomy/eval/quality-sample/.runs/1cc6480ff620/tree/p-retry-ac3c4cdb7f015e1f71825e4274e2323a49b615eb
- 规模：16 个文件 / 135506 字节 / 4251 行
- 语言：js 5、ts 2
- 排除：没有文件被排除

## 1. 从引用代码看：这里有一个具体的设计决定

- 类型：数据模型
- 置信度：高

**约束**：待模型补全（待模型补全）

**常见做法与代价**

- 待模型补全 —— 待模型补全

**他们怎么做**

待模型补全

`index.js:314-314`

```
	// Unreachable: `onAttemptFailure` throws once `retriesLeft` reaches 0, which is the same state the loop condition tests, so the loop is always left by a throw. Kept as a guard against a future change to either side breaking that pairing.
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

`helpers.js:70-70`

```
// Drives both clocks so a test that has to wait can finish at once and still be charged the time it means to. `performance.now` only moves when a wait is scheduled, so a budget can never be spent by the machine being slow, which is what made several of these tests pass or fail on load alone. A wait is charged when it is scheduled, not when it fires, so a timer that is later cleared is still charged, and the order of `delays` cannot show whether one wait was awaited before the next.
```

**为什么有效**

待模型补全

**代价**

- 待模型补全 —— 待模型补全

## 没看的部分

**分析口径之外**

- 跳过：报告正文写了 1 个点，另有 0 个已核实但没有写进正文。

**没进正文的判断**

- 没有可核对证据的点：0 个
- 被降级的点：0 个
- 被丢弃的点：2 个
- 丢弃原因：sample —— snippet is not on line 34 of test-timing.js
- 丢弃原因：sample —— snippet is not on line 34 of test.js
