/**
 * A question about a finished report, answered only from that report's evidence.
 *
 * The report is a monologue; the first thing a reader wants is a follow-up. The
 * danger is obvious: a general-purpose model will happily explain a repository it
 * has never seen. So this layer has one rule, enforced twice — the prompt shows
 * only stored evidence, and the answer is rejected unless every citation it makes
 * is one of those stored fragments.
 *
 * It never re-reads the source tree. The run is the unit of truth here: the same
 * bytes the validator checked at generation time are the bytes the answer is
 * allowed to rely on.
 */

import type { LearningPoint, ReportInput } from '../contracts/types.js'
import { estimateTokens } from '../kernel/budget.js'
import type { ModelClient, Usage } from './client.js'
import type { Lang } from './prompts/zh.js'

/** A citation as the report writes it: `path:start-end`. */
const CITATION = /((?:[A-Za-z0-9._@/-]+):\d+-\d+)/g
const CITATION_SHAPE = /^[^\s:]+:\d+-\d+$/
/** Enough for a focused answer; a report-sized essay is not a follow-up. */
const MAX_ANSWER_CHARS = 2_000
// A broad "how does the pipeline work" question is where a large context made
// the reply long enough to stop being valid JSON. Six points keep the answer
// within a small object; a question the evidence cannot answer must refuse, not
// enumerate the repository from memory.
const MAX_CONTEXT_TOKENS = 24_000
const MAX_ATTEMPTS = 2

export type Answer = {
  /** False when the stored evidence does not answer the question. */
  answered: boolean
  answer: string
  citations: string[]
  usage: Usage
}

export type AnswerDeps = {
  client: ModelClient
  input: ReportInput
  question: string
  lang?: Lang
}

export class AnswerRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AnswerRejectedError'
  }
}

const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answered', 'answer', 'citations'],
  properties: {
    answered: { type: 'boolean' },
    answer: { type: 'string' },
    citations: { type: 'array', items: { type: 'string' } },
  },
} as const

function systemPrompt(lang: Lang): string {
  if (lang === 'en') {
    return [
      'You answer questions about one analysed repository, using only the evidence below.',
      'Every factual sentence must carry a citation written exactly `path:start-end` from the evidence list.',
      'Do not use outside knowledge. Do not cite a range that is not in the list.',
      'The evidence is a set of individual decisions, not a complete module map or pipeline. If answering needs files or stages that are not in the evidence, set answered=false instead of listing them from memory.',
      'If the evidence does not answer the question, set answered=false, say what is missing, and return no citations.',
      'Return only the JSON object the schema asks for.',
    ].join('\n')
  }
  return [
    '你只根据下面这份分析里的证据，回答关于这个仓库的问题。',
    '每一句事实都必须带一个引用，写成 `path:start-end`，且必须来自给出的证据列表。',
    '不要使用外部知识，不要引用列表里没有的行号范围。',
    '给出的证据是一组个别的决定，不是完整的模块图或流水线；如果回答需要证据里没有的文件或阶段，把 answered 设为 false，不要凭记忆罗列。',
    '如果证据不足以回答，把 answered 设为 false，说明缺什么，并返回空的 citations。',
    '只返回 schema 要求的 JSON。',
  ].join('\n')
}

function questionWords(question: string): string[] {
  const latin = question.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []
  // Chinese has no spaces; overlapping pairs are a cheap stand-in for words.
  const cjk = question.match(/[\u4e00-\u9fff]/g) ?? []
  return [...new Set([...latin, ...cjk])]
}

function relevance(point: LearningPoint, words: string[]): number {
  const text = [
    point.title,
    point.problem.constraint,
    point.problem.stakes,
    point.theirs.summary,
    point.mechanism,
  ]
    .join(' ')
    .toLowerCase()
  return words.reduce((score, word) => score + (text.includes(word) ? 1 : 0), 0)
}

function citationOf(evidence: { path: string; startLine: number; endLine: number }): string {
  return `${evidence.path}:${evidence.startLine}-${evidence.endLine}`
}

type Chosen = {
  points: LearningPoint[]
  allowed: Set<string>
}

/**
 * The points worth showing, and the citations they are allowed to make.
 *
 * Reports fit in a context easily; a very large one is cut by relevance rather than
 * by order, because the point a reader asks about is usually the one they just read.
 */
function choose(input: ReportInput, question: string): Chosen {
  const words = questionWords(question)
  const ranked = [...input.points].sort((a, b) => relevance(b, words) - relevance(a, words))
  let chosen = ranked.slice(0, Math.min(6, ranked.length))

  const tokenCount = (points: LearningPoint[]): number => {
    const text = points
      .map(
        (point) =>
          `${point.title}\n${point.mechanism}\n${point.theirs.summary}\n` +
          point.theirs.evidence.map((evidence) => evidence.snippet).join('\n'),
      )
      .join('\n')
    return estimateTokens({ system: '', user: text })
  }
  while (chosen.length > 1 && tokenCount(chosen) > MAX_CONTEXT_TOKENS) chosen = chosen.slice(0, -1)

  const allowed = new Set<string>()
  for (const point of chosen) {
    for (const evidence of point.theirs.evidence) allowed.add(citationOf(evidence))
  }
  return { points: chosen, allowed }
}

function evidenceBlock(point: LearningPoint, index: number, lang: Lang): string {
  const lines: string[] = [`### ${index + 1}. ${point.title}`, '']
  lines.push(`${lang === 'en' ? 'Constraint' : '约束'}：${point.problem.constraint}`)
  lines.push(`${lang === 'en' ? 'Approach' : '做法'}：${point.theirs.summary}`)
  lines.push(`${lang === 'en' ? 'Mechanism' : '机制'}：${point.mechanism}`)
  for (const item of point.tradeoffs) lines.push(`- ${item.cost} —— ${item.whenItHurts}`)
  lines.push('')
  for (const evidence of point.theirs.evidence) {
    lines.push(`EVIDENCE \`${citationOf(evidence)}\``, '', '```', evidence.snippet, '```', '')
  }
  return lines.join('\n')
}

function userPrompt(input: ReportInput, question: string, chosen: Chosen, lang: Lang): string {
  const labels =
    lang === 'en'
      ? { problem: 'What the analysis is about', question: 'Question', evidence: 'Evidence' }
      : { problem: '这次分析在解决什么', question: '问题', evidence: '证据' }
  const head = [
    `## ${labels.problem}`,
    input.problem === '' ? '—' : input.problem,
    '',
    `## ${labels.question}`,
    question,
    '',
    `## ${labels.evidence}`,
    '',
  ]
  const body = chosen.points.map((point, index) => evidenceBlock(point, index, lang)).join('\n')
  const allowed = [...chosen.allowed].map((item) => `- ${item}`).join('\n')
  const tail =
    lang === 'en'
      ? `\nAllowed citations (use no others):\n${allowed}\n`
      : `\n允许引用的范围（不要使用其它范围）：\n${allowed}\n`
  return `${head.join('\n')}${body}${tail}`
}

function readAnswer(raw: unknown): { answered: boolean; answer: string; citations: string[] } | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (typeof record['answered'] !== 'boolean') return null
  if (typeof record['answer'] !== 'string' || record['answer'].trim() === '') return null
  const citations = record['citations']
  if (!Array.isArray(citations) || citations.some((item) => typeof item !== 'string')) return null
  return {
    answered: record['answered'],
    answer: record['answer'].trim(),
    citations: citations as string[],
  }
}

/** Why this answer cannot be shown, or an empty string when it can. */
function rejection(answer: { answered: boolean; answer: string; citations: string[] }, allowed: Set<string>): string {
  if (answer.answer.length > MAX_ANSWER_CHARS) {
    return `the answer is longer than ${MAX_ANSWER_CHARS} characters`
  }
  const cited = [...answer.citations, ...[...answer.answer.matchAll(CITATION)].map((match) => match[1] as string)]
  for (const item of cited) {
    if (!CITATION_SHAPE.test(item)) return `"${item}" is not written path:start-end`
    if (!allowed.has(item)) return `"${item}" is not one of the stored evidence ranges`
  }
  if (answer.answered && answer.citations.length === 0) {
    return 'an answered question must cite at least one stored range'
  }
  if (!answer.answered && cited.length > 0) {
    return 'an unanswered question must not cite anything'
  }
  return ''
}

/**
 * Asks the model once, repairs a rejected answer once, then refuses.
 *
 * A repaired answer is validated by the same rule as the first: the repair is a
 * second chance for the model to obey the format, not a relaxation of it.
 */
export async function answerQuestion(deps: AnswerDeps): Promise<Answer> {
  const lang: Lang = deps.lang ?? 'zh'
  const chosen = choose(deps.input, deps.question)
  const usage: Usage = { in: 0, out: 0 }
  const system = systemPrompt(lang)
  const baseUser = userPrompt(deps.input, deps.question, chosen, lang)

  if (chosen.points.length === 0) {
    return {
      answered: false,
      answer: lang === 'en' ? 'This run has no verified points to answer from.' : '这次分析没有已核实的点，无法回答。',
      citations: [],
      usage,
    }
  }

  let reason = ''
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const reply = await deps.client.complete({
      system,
      user:
        attempt === 0
          ? baseUser
          : `${baseUser}\n\n${
              lang === 'en' ? 'The previous answer was rejected' : '上一次回答被拒绝'
            }: ${reason}. ${
              lang === 'en'
                ? 'Answer again, and cite only ranges from the list.'
                : '请重新回答，并且只引用列表里的范围。'
            }`,
      schema: ANSWER_SCHEMA,
    })
    usage.in += reply.usage.in
    usage.out += reply.usage.out
    const parsed = readAnswer(reply.json)
    if (parsed === null) {
      reason = lang === 'en' ? 'the reply is not the requested JSON shape' : '回复不是要求的 JSON 结构'
      continue
    }
    reason = rejection(parsed, chosen.allowed)
    if (reason === '') return { ...parsed, usage }
  }

  throw new AnswerRejectedError(
    lang === 'en'
      ? `The model's answer could not be tied to this report's evidence (${reason}). Nothing was shown.`
      : `模型给出的回答无法对应到这份报告的证据（${reason}），已丢弃这次回答。`,
  )
}
