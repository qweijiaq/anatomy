/**
 * The judge's prompt templates.
 *
 * Everything here is text the model sees; nothing here touches the disk. The
 * three things a prompt must never get wrong live in this file:
 *
 * - the schema, so the reply can be parsed instead of guessed at;
 * - the verbatim-citation rule, because evidence is checked as an exact
 *   substring of the canonical file, not as a similarity;
 * - the elision note, because a truncated slice has lines the model did not
 *   see, and a prompt that labels them as readable invites fabricated evidence.
 *
 * `zh` is the shipped language; `en` is the `--lang en` template switch.
 */

import type { Candidate, Slice } from '../../contracts/types.js'

export type Lang = 'zh' | 'en'

export const POINT_KINDS = [
  'architecture',
  'algorithm',
  'data-model',
  'api-design',
  'performance',
  'testing',
  'tooling',
  'process',
] as const

export const CONFIDENCES = ['high', 'medium', 'low'] as const

/**
 * The LearningPoint contract as a JSON-schema-shaped object.
 *
 * It doubles as the prose schema in the system prompt and as the `schema`
 * handed to the client, so the two can never drift. `id` is optional because
 * the judge has a better one (the candidate id); `confidence` is required by
 * the prompt, but the judge still defaults an omitted one to `medium` rather
 * than rejecting an otherwise usable point.
 */
export const POINT_SCHEMA = {
  type: 'object',
  required: [
    'title',
    'kind',
    'problem',
    'alternatives',
    'theirs',
    'mechanism',
    'tradeoffs',
    'confidence',
    'unknowns',
    'recipe',
  ],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    kind: { type: 'string', enum: POINT_KINDS },
    problem: {
      type: 'object',
      required: ['constraint', 'stakes'],
      properties: {
        constraint: { type: 'string' },
        stakes: { type: 'string' },
      },
    },
    alternatives: {
      type: 'array',
      items: {
        type: 'object',
        required: ['approach', 'cost'],
        properties: {
          approach: { type: 'string' },
          cost: { type: 'string' },
        },
      },
    },
    theirs: {
      type: 'object',
      required: ['summary', 'evidence'],
      properties: {
        summary: { type: 'string' },
        evidence: {
          type: 'array',
          items: {
            type: 'object',
            required: ['path', 'startLine', 'endLine', 'snippet'],
            properties: {
              path: { type: 'string' },
              startLine: { type: 'integer' },
              endLine: { type: 'integer' },
              snippet: { type: 'string' },
            },
          },
        },
      },
    },
    mechanism: { type: 'string' },
    tradeoffs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['cost', 'whenItHurts'],
        properties: {
          cost: { type: 'string' },
          whenItHurts: { type: 'string' },
        },
      },
    },
    confidence: { type: 'string', enum: CONFIDENCES },
    unknowns: { type: 'array', items: { type: 'string' } },
    recipe: {
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          required: ['prereqs', 'minimalForm', 'avoidWhen'],
          properties: {
            prereqs: { type: 'array', items: { type: 'string' } },
            minimalForm: { type: 'string' },
            avoidWhen: { type: 'array', items: { type: 'string' } },
          },
        },
      ],
    },
  },
} as const

const SYSTEM_ZH = `你是 anatomy 的判读器。输入是一个候选信号（文件、行号、信号类型）和几段代码切片。
任务：判断这段代码里是否存在一个可迁移的工程决策，并把它写成一个 LearningPoint。

只输出一个 JSON 对象：不要 Markdown 代码围栏，不要任何解释文字。
如果没有值得学习的决策，只输出 {"skip": true}。
否则输出下面的 JSON 形状（字段全部必填；未知的可选信息写进 unknowns，不要省略字段）：
${JSON.stringify(POINT_SCHEMA)}

硬性规则：
1. 只能引用切片标题里出现过的行号。切片没有展示的行就是不可读的：不得推测，不得编造，也不要把行号当成对文件的了解。
2. snippet 必须从切片逐字复制：保留缩进、标点和原文用词；不要带行号前缀，不要带省略号，不要翻译，不要改写。
3. 标记为 elided（已省略）的区间绝对不能引用，也不能当作证据。
4. 代码永远保留原文；title、problem、mechanism、tradeoffs 等解释用简体中文。
5. 证据支持到什么程度就写什么程度：只看到一两行就只引用一两行。证据不足时 confidence 用 medium 或 low，并把缺口写进 unknowns；不要为了显得确定而写 high。
6. 不要复述整个文件，只讲这个候选点本身。
7. unknowns 写的是「读者该去哪里看什么」，不是「我没看到」。每条都要给出可执行的下一步：具体到调用点、路由注册处、配置项或文件。"调用点未展示"不合格；"想看配额是否合理，去看 createRateLimiter 在哪里被调用、limit 传了什么"合格。不要用"切片未展示""未被展示""不在视野内"这类描述你自身输入状态的措辞——读者不关心你看到了什么，只关心他自己该看什么。`

const SYSTEM_EN = `You are the reader for anatomy. The input is one candidate signal (path, line, signal kind) and a few code slices.
Decide whether the code contains a transferable engineering decision, and if so write it as one LearningPoint.

Output exactly one JSON object: no Markdown fences, no prose around it.
If there is nothing worth learning, output {"skip": true}.
Otherwise output this JSON shape (every listed field is required; put what you cannot know in unknowns rather than omitting fields):
${JSON.stringify(POINT_SCHEMA)}

Hard rules:
1. Cite only line numbers that appear in the slice headers. Lines not shown are unreadable: do not infer them, do not invent them.
2. Copy each snippet verbatim from the slice: keep indentation, punctuation and original wording; no line-number prefixes, no ellipsis, no translation, no rewriting.
3. Ranges marked elided are unreadable. Never cite them and never use them as evidence.
4. Code stays in its original language; explanations are in English.
5. Claim only what the evidence supports: cite one or two lines when that is all you saw. If evidence is thin, use medium or low confidence and say what is missing in unknowns; never write high to sound certain.
6. Do not restate the whole file. Talk about this candidate only.
7. Each unknowns entry tells the reader where to look next — a call site, a route registration, a config key, a file. Give an actionable next step, not a report on your own input. "Call sites not shown" is unacceptable; "to judge whether the quota is sane, read where createRateLimiter is called and what limit it passes" is acceptable. Never write "not shown in the slice", "not visible", or similar phrases about your own visibility: the reader wants to know what to read, not what you were given.`

export function systemPrompt(lang: Lang): string {
  return lang === 'en' ? SYSTEM_EN : SYSTEM_ZH
}

/** The candidate block: path and line are what a citation must match. */
export function candidateHeader(lang: Lang, candidate: Candidate): string {
  const matched = candidate.matched.slice(0, 8).join(', ')
  if (lang === 'en') {
    return [
      'Candidate signal',
      `- id: ${candidate.id}`,
      `- location: ${candidate.path}:${candidate.line}`,
      `- kind: ${candidate.kind}`,
      `- score: ${candidate.score}`,
      `- matched: ${matched === '' ? '(none)' : matched}`,
    ].join('\n')
  }
  return [
    '候选信号',
    `- id: ${candidate.id}`,
    `- 位置: ${candidate.path}:${candidate.line}`,
    `- 类型: ${candidate.kind}`,
    `- 分数: ${candidate.score}`,
    `- 命中: ${matched === '' ? '(无)' : matched}`,
  ].join('\n')
}

/**
 * The slice label. `path:startLine-endLine` is the whole point of the label:
 * both bounds are real file line numbers, taken from the slice itself.
 */
export function sliceHeader(lang: Lang, slice: Slice): string {
  const label = `${slice.path}:${slice.startLine}-${slice.endLine}`
  if (!slice.truncated || slice.omitted === null) return `--- ${label} ---`

  const elided = `${slice.omitted.startLine}-${slice.omitted.endLine}`
  if (lang === 'en') {
    return (
      `--- ${label} (truncated: lines ${elided} are elided and unreadable; ` +
      `do not cite lines ${elided}) ---`
    )
  }
  return `--- ${label}（截断：第 ${elided} 行已被省略、不可读；不要引用 ${elided}）---`
}

/** Replaces the elided middle with something no one can mistake for source. */
export function sliceElision(lang: Lang, omitted: { startLine: number; endLine: number }): string {
  const range = `${omitted.startLine}-${omitted.endLine}`
  return lang === 'en'
    ? `${range} | <<< lines ${range} elided, unreadable >>>`
    : `${range} | <<< 第 ${range} 行已省略，不可读 >>>`
}

export function slicesHeading(lang: Lang): string {
  return lang === 'en'
    ? 'Code slices (each header is path:startLine-endLine; the number before each `|` is the real line number)'
    : '代码切片（每节标题是 path:startLine-endLine；每行 `|` 前的数字是真实行号）'
}

export function noSlices(lang: Lang): string {
  return lang === 'en'
    ? '(No readable code slices were provided; do not invent evidence.)'
    : '（没有可读的代码切片；不要编造证据。）'
}

/** A one-shot repair instruction; `reason` is our own text, sanitized by caller. */
export function repairNote(lang: Lang, reason: string): string {
  return lang === 'en'
    ? `\n\nThe previous reply was unusable: ${reason}\nReply again with one complete JSON object (or {"skip": true}).`
    : `\n\n上一次回复不能使用：${reason}\n请重新输出一个完整的 JSON 对象（或 {"skip": true}）。`
}
