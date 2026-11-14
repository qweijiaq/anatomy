/**
 * Every word in the report that this code writes, in both languages.
 *
 * The report is a fixed structure around prose a model wrote: headings, field
 * labels, units, and the fallbacks used when a field is missing. Those were Chinese
 * literals scattered through the renderer, which made `--lang en` produce an English
 * body under Chinese headings — a half-finished feature the README described as
 * "只做到一半" rather than claiming something untrue.
 *
 * They live here now, so the claim can be made honestly. The model's prose still
 * comes from the prompt (which has had an English variant for longer), and this
 * file supplies everything around it.
 *
 * ## What is *not* here
 *
 * Model output is never translated — titles, mechanisms and trade-offs arrive in
 * whichever language was asked for, and the snippet is always verbatim source. This
 * table only covers our own strings. A missing entry would be a visible bug rather
 * than a silent mix, because `Labels` is a total type: adding a field here fails to
 * compile until both languages provide it.
 */

export type Lang = 'zh' | 'en'

export type Labels = {
  // --- brief ---
  problemHeading: string
  problemFallback: string
  topHeading: (count: number) => string
  /** The same section when nothing was selected: a count of zero is not a heading. */
  topHeadingEmpty: string
  topEmpty: string
  notInBody: string
  trustHeading: string
  evidenceRate: string
  droppedEvidence: string
  avgEvidence: string
  scopeHeading: string
  /** 报告里每条引用读起来是什么、怎么把它交回 `ana inspect`。 */
  howToCheck: string
  source: string
  root: string
  scaleLabel: string
  scale: (files: string, bytes: string, lines: string) => string
  languages: string
  excluded: string
  /** The label/value separator: full-width for Chinese, `: ` for English. */
  colon: string
  unknown: string
  unidentified: string
  nothingExcluded: string
  listSeparator: string

  // --- a point ---
  kind: string
  confidence: string
  untitled: string
  unclassified: string
  unlabeled: string
  kinds: Record<string, string>
  confidences: Record<string, string>
  constraint: string
  constraintMissing: string
  alternatives: string
  alternativesMissing: string
  unnamedApproach: string
  theirs: string
  theirsMissing: string
  mechanism: string
  mechanismMissing: string
  tradeoffs: string
  tradeoffsMissing: string
  unnamedCost: string
  unknowns: string

  // --- recipe ---
  recipeSummary: string
  prereqs: string
  noPrereqs: string
  minimalForm: string
  noMinimalForm: string
  avoidWhen: string
  noAvoidWhen: string

  // --- empty state ---
  emptyHeading: string
  emptyLede: string
  noClues: string
  notePrefix: string
  skipPrefix: string
  notRenderedPrefix: string
  droppedPrefix: string
  downgradedPrefix: string
  unknownPoint: string

  // --- tail ---
  tailHeading: string
  nothingOmitted: string
  outsideHeading: string
  noSkippedInput: string
  withheldHeading: string
  notRenderedCount: (count: number) => string
  downgradedCount: (count: number) => string
  droppedCount: (count: number) => string
  droppedReason: string
  downgradedReason: string

  // --- appendix ---
  appendixCandidatesHeading: string
  appendixCandidatesLede: (count: number) => string
  appendixPosition: string
  appendixSymbol: string
  appendixKind: string
  appendixScore: string
  appendixRules: string
  appendixNoSymbol: string
  appendixMore: (count: number) => string
  appendixDistribution: string
  appendixShapeHeading: string
  appendixModules: (modules: number, orphans: number) => string
  appendixHubs: string
  appendixUnresolved: (count: number) => string
  appendixEntries: string
  appendixManifests: string
  appendixTooling: (tests: string, ci: string, docs: string) => string
  appendixShapeNote: string
  appendixFilesHeading: string
  appendixFilesLede: (shown: number, total: number) => string
  appendixFilePath: string
  appendixFileLines: string
  appendixFileBytes: string
  appendixFileShare: string
  appendixFilesNote: string
  yes: string
  no: string
}

const ZH: Labels = {
  problemHeading: '这次分析在解决什么',
  problemFallback: '这次没有拿到对仓库整体问题的概括。',
  topHeading: (count) => `最值得学的 ${count} 件事`,
  topHeadingEmpty: '最值得学的点',
  topEmpty: '这次没有选出最值得学的条目。',
  notInBody: '（未进正文）',
  trustHeading: '这次分析的可信度',
  evidenceRate: '已取证点占比',
  droppedEvidence: '被丢弃证据数',
  avgEvidence: '每点平均证据数',
  scopeHeading: '分析口径',
  // A citation without this line is a dead end: the report prints `path:7-8` and the
  // window has no way to ask what those bytes were, so the reader who doubts a claim
  // has to find the file themselves. The command existed; the page never said so.
  howToCheck:
    '每条引用写作 `path:起止行`。想核对就把这条引用原样交给 `ana inspect`（例如 `ana inspect lib/store.mjs:7-8`），取回的是这一轮真正读过的原文；证据存在分析结果里，删了源码树也一样。',

  source: '来源',
  root: '根目录',
  scaleLabel: '规模',
  scale: (files, bytes, lines) => `${files} 个文件 / ${bytes} 字节 / ${lines} 行`,
  languages: '语言',
  excluded: '排除',
  colon: '：',
  unknown: '未知',
  unidentified: '未识别',
  nothingExcluded: '没有文件被排除',
  listSeparator: '、',

  kind: '类型',
  confidence: '置信度',
  untitled: '（无标题）',
  unclassified: '未分类',
  unlabeled: '未标注',
  kinds: {
    architecture: '架构',
    algorithm: '算法',
    'data-model': '数据模型',
    'api-design': '接口设计',
    performance: '性能',
    testing: '测试',
    tooling: '工具链',
    process: '流程',
  },
  confidences: { high: '高', medium: '中', low: '低' },
  constraint: '约束',
  constraintMissing: '（没有记录约束）',
  alternatives: '常见做法与代价',
  alternativesMissing: '（没有记录常见做法）',
  unnamedApproach: '（未命名做法）',
  theirs: '他们怎么做',
  theirsMissing: '（没有记录做法）',
  mechanism: '为什么有效',
  mechanismMissing: '（没有记录原理）',
  tradeoffs: '代价',
  tradeoffsMissing: '（没有记录代价）',
  unnamedCost: '（未命名代价）',
  unknowns: '还不确定的地方',

  recipeSummary: '要在自己项目里用',
  prereqs: '前置条件',
  noPrereqs: '（没有额外前置条件）',
  minimalForm: '最小形态',
  noMinimalForm: '（没有给出最小形态）',
  avoidWhen: '什么情况下别用',
  noAvoidWhen: '（没有记录适用边界）',

  emptyHeading: '没找到值得学的点',
  emptyLede: '这次没有找到既能核对到具体代码、又值得学习的点。原因如下：',
  noClues: '这次分析没有留下可用的线索：既没有被跳过的部分，也没有可复述的备注。',
  notePrefix: '备注',
  skipPrefix: '跳过',
  notRenderedPrefix: '没有可核对的证据',
  droppedPrefix: '被丢弃',
  downgradedPrefix: '被降级',
  unknownPoint: '（未知点）',

  tailHeading: '没看的部分',
  nothingOmitted: '没有需要声明的遗漏。',
  outsideHeading: '分析口径之外',
  noSkippedInput: '（没有声明被跳过的输入）',
  withheldHeading: '没进正文的判断',
  notRenderedCount: (count) => `没有可核对证据的点：${count} 个`,
  downgradedCount: (count) => `被降级的点：${count} 个`,
  droppedCount: (count) => `被丢弃的点：${count} 个`,
  droppedReason: '丢弃原因',
  downgradedReason: '降级原因',

  appendixCandidatesHeading: '值得自己去看的位置',
  appendixCandidatesLede: (count) =>
    `扫描共给出 ${count} 个候选点。**分数是规则命中累加，不是质量评分**——` +
    '它只说明这里同时符合几条启发式，不说明这里一定值得学。',
  appendixPosition: '位置',
  appendixSymbol: '所在声明',
  appendixKind: '类型',
  appendixScore: '分',
  appendixRules: '命中的规则',
  appendixNoSymbol: '—',
  appendixMore: (count) => `按分数排在后面的 ${count} 个没有列出。`,
  appendixDistribution: '信号分布',
  appendixShapeHeading: '这个仓库的形状',
  appendixModules: (modules, orphans) =>
    `模块：${modules} 个；其中 ${orphans} 个没有任何文件导入它`,
  appendixHubs: '被依赖最多',
  appendixUnresolved: (count) => `未解析的导入：${count} 条（多半是外部依赖或路径别名）`,
  appendixEntries: '入口',
  appendixManifests: '清单文件',
  appendixTooling: (tests, ci, docs) => `测试 / CI / 文档：${tests} / ${ci} / ${docs}`,
  appendixShapeNote: '这些数字来自结构索引，没有经过模型。它们只说明代码长什么样，不说明写得好不好。',
  appendixFilesHeading: '代码集中在哪',
  appendixFilesLede: (shown, total) => `按行数排的前 ${shown} 个文件（共 ${total} 个）：`,
  appendixFilePath: '文件',
  appendixFileLines: '行',
  appendixFileBytes: '字节',
  appendixFileShare: '占全部行数',
  appendixFilesNote:
    '行数是文件的物理行数，包含空行和注释——它衡量的是「要翻多久」，不是「逻辑有多重」。',
  yes: '有',
  no: '无',
}

const EN: Labels = {
  problemHeading: 'What this analysis is about',
  problemFallback: 'This run produced no summary of the repository as a whole.',
  topHeading: (count) => `The ${count} things most worth learning`,
  topHeadingEmpty: 'What is most worth learning',
  topEmpty: 'Nothing was selected as most worth learning.',
  notInBody: ' (not in the body)',
  trustHeading: 'How much of this is verifiable',
  evidenceRate: 'Points with followed evidence',
  droppedEvidence: 'Evidence items dropped',
  avgEvidence: 'Average evidence per point',
  scopeHeading: 'What was analysed',
  howToCheck:
    'Every citation is written `path:start-end`. Hand one to `ana inspect` to read the same bytes back (for example `ana inspect lib/store.mjs:7-8`) — the evidence is stored with the run, so this works after the source tree is gone.',
  source: 'Source',
  root: 'Root',
  scaleLabel: 'Size',
  scale: (files, bytes, lines) => `${files} files / ${bytes} bytes / ${lines} lines`,
  languages: 'Languages',
  excluded: 'Excluded',
  colon: ': ',
  unknown: 'unknown',
  unidentified: 'none identified',
  nothingExcluded: 'no file was excluded',
  listSeparator: ', ',

  kind: 'Kind',
  confidence: 'Confidence',
  untitled: '(untitled)',
  unclassified: 'unclassified',
  unlabeled: 'unlabelled',
  kinds: {
    architecture: 'architecture',
    algorithm: 'algorithm',
    'data-model': 'data model',
    'api-design': 'API design',
    performance: 'performance',
    testing: 'testing',
    tooling: 'tooling',
    process: 'process',
  },
  confidences: { high: 'high', medium: 'medium', low: 'low' },
  constraint: 'Constraint',
  constraintMissing: '(no constraint recorded)',
  alternatives: 'The usual approaches, and what they cost',
  alternativesMissing: '(no alternatives recorded)',
  unnamedApproach: '(unnamed approach)',
  theirs: 'What they did',
  theirsMissing: '(no approach recorded)',
  mechanism: 'Why it works',
  mechanismMissing: '(no mechanism recorded)',
  tradeoffs: 'What it costs',
  tradeoffsMissing: '(no cost recorded)',
  unnamedCost: '(unnamed cost)',
  unknowns: 'What is still uncertain',

  recipeSummary: 'To use this in your own project',
  prereqs: 'Prerequisites',
  noPrereqs: '(no extra prerequisites)',
  minimalForm: 'Smallest form',
  noMinimalForm: '(no minimal form given)',
  avoidWhen: 'When not to use it',
  noAvoidWhen: '(no limits recorded)',

  emptyHeading: 'Nothing worth learning was found',
  emptyLede: 'No point survived both a check against the code and the bar for being worth reading. Here is why:',
  noClues: 'This run left no usable trace: nothing was skipped and nothing was worth repeating.',
  notePrefix: 'note',
  skipPrefix: 'skipped',
  notRenderedPrefix: 'no checkable evidence',
  droppedPrefix: 'dropped',
  downgradedPrefix: 'downgraded',
  unknownPoint: '(unknown point)',

  tailHeading: 'What was not looked at',
  nothingOmitted: 'Nothing needs to be declared as omitted.',
  outsideHeading: 'Outside the analysis',
  noSkippedInput: '(no skipped input declared)',
  withheldHeading: 'Claims kept out of the body',
  notRenderedCount: (count) => `Points with no checkable evidence: ${count}`,
  downgradedCount: (count) => `Points downgraded: ${count}`,
  droppedCount: (count) => `Points dropped: ${count}`,
  droppedReason: 'dropped',
  downgradedReason: 'downgraded',

  appendixCandidatesHeading: 'Places worth looking at yourself',
  appendixCandidatesLede: (count) =>
    `The scan produced ${count} candidates. **The score counts rule hits, it is not a quality ` +
    'rating** — it says several heuristics fired here at once, not that this is worth learning.',
  appendixPosition: 'Location',
  appendixSymbol: 'Declaration',
  appendixKind: 'Kind',
  appendixScore: 'Score',
  appendixRules: 'Rules that fired',
  appendixNoSymbol: '—',
  appendixMore: (count) => `The ${count} ranked below these are not listed.`,
  appendixDistribution: 'By signal',
  appendixShapeHeading: 'The shape of the repository',
  appendixModules: (modules, orphans) =>
    `Modules: ${modules}; ${orphans} of them are not imported by any other file`,
  appendixHubs: 'Most imported',
  appendixUnresolved: (count) =>
    `Unresolved imports: ${count} (usually external dependencies or path aliases)`,
  appendixEntries: 'Entry points',
  appendixManifests: 'Manifests',
  appendixTooling: (tests, ci, docs) => `Tests / CI / docs: ${tests} / ${ci} / ${docs}`,
  appendixShapeNote:
    'These numbers come from the structure index, not from a model. They say what the code looks like, not whether it is good.',
  appendixFilesHeading: 'Where the code sits',
  appendixFilesLede: (shown, total) => `The ${shown} largest files by line count (of ${total}):`,
  appendixFilePath: 'File',
  appendixFileLines: 'Lines',
  appendixFileBytes: 'Bytes',
  appendixFileShare: 'Share of lines',
  appendixFilesNote:
    'Line counts are physical, including blanks and comments — they measure how long it takes to scroll, not how much logic there is.',
  yes: 'yes',
  no: 'no',
}

export function labelsFor(lang: Lang): Labels {
  return lang === 'en' ? EN : ZH
}
