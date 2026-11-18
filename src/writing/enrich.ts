/**
 * One batched call that adds a glossary and an FAQ to a dossier.
 *
 * This is the only part of `ana export` that spends tokens, and it reuses the same
 * stored evidence the report already paid for. The rule is the one `ask` enforces:
 * every item must cite a range the run kept; an item whose citation is missing or
 * unknown is dropped, and if nothing survives the call is reported as a failure
 * rather than written into the bundle.
 */

import type { LearningPoint, ReportInput } from '../contracts/types.js'
import { createModelClient, MissingCredentialsError, resolveApiKey, type ModelClient } from './client.js'
import { resolveModelName } from '../commands/analyze.js'
import type { Lang } from './prompts/zh.js'

const CITATION = /^[^\s:]+:\d+-\d+$/
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['glossary', 'faq'],
  properties: {
    glossary: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['term', 'definition', 'citations'],
        properties: {
          term: { type: 'string' },
          definition: { type: 'string' },
          citations: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    faq: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'answer', 'citations'],
        properties: {
          question: { type: 'string' },
          answer: { type: 'string' },
          citations: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const

export type Enrichment = { glossary: string; faq: string }

function citationOf(evidence: { path: string; startLine: number; endLine: number }): string {
  return `${evidence.path}:${evidence.startLine}-${evidence.endLine}`
}

function evidenceText(point: LearningPoint): string {
  const evidence = point.theirs.evidence
    .map((item) => `- ${citationOf(item)}\n\`\`\`\n${item.snippet}\n\`\`\``)
    .join('\n')
  return `### ${point.title}\n${point.theirs.summary}\n${point.mechanism}\n${evidence}`
}

function prompt(input: ReportInput, lang: Lang): { system: string; user: string; allowed: Set<string> } {
  const allowed = new Set<string>()
  for (const point of input.points) {
    for (const evidence of point.theirs.evidence) allowed.add(citationOf(evidence))
  }
  const system =
    lang === 'en'
      ? 'You add a glossary and a short FAQ to an evidence-backed report. Use only the evidence shown. Every glossary entry and FAQ item must cite at least one `path:start-end` from the allowed list; do not invent terms the evidence does not support. Return only the JSON the schema asks for.'
      : '你为一份带证据的报告补一个术语表和一个简短 FAQ。只能使用下面展示的证据；每个术语和问答都必须引用允许列表里的 `path:start-end`，不要编造证据没有支持的术语。只返回 schema 要求的 JSON。'
  const user = [
    input.problem === '' ? '' : `Problem: ${input.problem}`,
    'Evidence:',
    input.points.map(evidenceText).join('\n\n'),
    `Allowed citations:\n${[...allowed].map((item) => `- ${item}`).join('\n')}`,
  ].join('\n')
  return { system, user, allowed }
}

type Raw = {
  glossary?: unknown
  faq?: unknown
}

function arrayOf(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value.filter((item) => typeof item === 'object' && item !== null) as Array<Record<string, unknown>>) : []
}

function citationsOf(value: unknown, allowed: Set<string>): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string'))].filter(
    (item) => CITATION.test(item) && allowed.has(item),
  )
}

export async function enrichDossier(deps: {
  input: ReportInput
  lang: Lang
  client?: ModelClient
  model?: string
  apiKey?: string
}): Promise<Enrichment> {
  const apiKey = resolveApiKey(deps.apiKey)
  if (deps.client === undefined && apiKey === '') throw new MissingCredentialsError()
  const client =
    deps.client ??
    createModelClient({ model: resolveModelName(deps.model), apiKey })
  const { system, user, allowed } = prompt(deps.input, deps.lang)
  const reply = await client.complete({ system, user, schema: SCHEMA })
  const raw = reply.json as Raw
  const glossaryItems = arrayOf(raw.glossary)
    .map((item) => ({
      term: typeof item['term'] === 'string' ? item['term'].trim() : '',
      definition: typeof item['definition'] === 'string' ? item['definition'].trim() : '',
      citations: citationsOf(item['citations'], allowed),
    }))
    .filter((item) => item.term !== '' && item.definition !== '' && item.citations.length > 0)
  const faqItems = arrayOf(raw.faq)
    .map((item) => ({
      question: typeof item['question'] === 'string' ? item['question'].trim() : '',
      answer: typeof item['answer'] === 'string' ? item['answer'].trim() : '',
      citations: citationsOf(item['citations'], allowed),
    }))
    .filter((item) => item.question !== '' && item.answer !== '' && item.citations.length > 0)

  if (glossaryItems.length === 0 && faqItems.length === 0) {
    throw new Error('enrichment produced no item whose citations are in this run')
  }

  const zh = deps.lang !== 'en'
  const glossary = [
    zh ? '# 术语表' : '# Glossary',
    '',
    ...glossaryItems.map(
      (item) => `- **${item.term}**：${item.definition} ${item.citations.map((c) => `\`${c}\``).join(' ')}`,
    ),
  ].join('\n')
  const faq = [
    zh ? '# 常见问题' : '# FAQ',
    '',
    ...faqItems.flatMap((item) => [
      `## ${item.question}`,
      '',
      `${item.answer} ${item.citations.map((c) => `\`${c}\``).join(' ')}`,
      '',
    ]),
  ].join('\n')
  return { glossary: `${glossary}\n`, faq: `${faq}\n` }
}
