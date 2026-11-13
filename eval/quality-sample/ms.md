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

- 来源：https://github.com/vercel/ms
- 根目录：/Users/weijia/Desktop/anatomy/eval/quality-sample/.runs/8d3c3d704f55/tree/ms-4ff48cec099f0514c3e9bbca18706c9c21122bfb
- 规模：22 个文件 / 52402 字节 / 1849 行
- 语言：ts 8
- 排除：lockfile 1

## 1. 从引用代码看：这里有一个具体的设计决定

- 类型：数据模型
- 置信度：高

**约束**：待模型补全（待模型补全）

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
