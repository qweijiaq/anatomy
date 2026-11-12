# dset

## 这次分析在解决什么

该仓库的设计决策如下。

## 最值得学的 1 件事

1. 从引用代码看：这里有一个具体的设计决定

## 这次分析的可信度

- 已取证点占比：100.0%
- 被丢弃证据数：0
- 每点平均证据数：1

## 分析口径

- 来源：https://github.com/lukeed/dset
- 根目录：/Users/weijia/Desktop/anatomy/eval/quality-sample/.runs/77774fe084ea/tree/dset-05b1ec0f8cebe3b5d5667285bc7da90f38a7215e
- 规模：23 个文件 / 27450 字节 / 1275 行
- 语言：js 12、ts 2
- 排除：没有文件被排除

## 1. 从引用代码看：这里有一个具体的设计决定

- 类型：数据模型
- 置信度：高

**约束**：待模型补全（待模型补全）

**常见做法与代价**

- 待模型补全 —— 待模型补全

**他们怎么做**

待模型补全

`src/merge.js:24-24`

```
		t = t[k] = (i === l) ? merge(t[k],val) : (typeof(x=t[k])===typeof keys) ? x : (keys[i]*0 !== 0 || !!~(''+keys[i]).indexOf('.')) ? {} : [];
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

`test/suites/arrays.js:47-47`

```
	arrays('should create object from decimal-like key :: array :: zero :: string', () => {
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

`test/suites/objects.js:4-4`

```
const prepare = x => ({ input: x, copy: JSON.parse(JSON.stringify(x)) });
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

`test/suites/pollution.js:41-41`

```
	pollution('should protect against ["__proto__"] assignment :: implicit string', () => {
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

`test/suites/preserve.js:30-30`

```
	preserves('should overwrite existing non-object values as object', () => {
```

**为什么有效**

待模型补全

**代价**

- 待模型补全 —— 待模型补全

## 没看的部分

**分析口径之外**

- 跳过：synthesis chose 1 of 5 rendered points
- 备注：could not resolve package.json entry "dist/index.js": outside the analysed scope

**没进正文的判断**

- 没有可核对证据的点：0 个
- 被降级的点：0 个
- 被丢弃的点：0 个
