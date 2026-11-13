/**
 * The report's first section: what this repository is for, and which five
 * things are worth learning from it.
 *
 * That answer cannot be assembled from the individual judgements — each judge
 * saw one candidate and one window — so it is written in one place, by one call,
 * with everything the analyser knows but nothing it must not leak:
 *
 * - the `Profile` (languages, manifests, entry points, notes);
 * - a *summary* of the structure index (how many modules, which few are
 *   imported most, how many imports did not resolve), never the index itself;
 * - the point titles, and only the titles. No code, no snippets, no
 *   mechanisms: the model is choosing between claims that were already
 *   verified, not making new ones.
 *
 * `topFive` is then checked against the titles it was given, so the top of the
 * report can never advertise a point the report does not contain. A reply that
 * fails that check — or is not JSON at all — costs one retry and then falls
 * back to the caller's own order, which is why this stage never throws for a
 * bad model answer, only for a transport failure the client already retried.
 */

import type { Profile, StructureIndex } from '../contracts/types.js'
import type { ModelClient, ModelRequest } from './client.js'
import {
  EMPTY_CONTENT_MESSAGE,
  MissingCredentialsError,
  ModelReplyError,
  ModelRequestError,
} from './client.js'
import type { Lang } from './prompts/zh.js'

/** How many modules the summary names as "most imported". */
export const TOP_IMPORTED_LIMIT = 5
/** One first attempt plus one repair. A third wrong reply is not a prompt bug. */
const MAX_ATTEMPTS = 2
/**
 * What the repair prompt says about a reply we could not read.
 *
 * Fixed on purpose: `ModelReplyError` carries the model's own truncated reply
 * and V8's `JSON.parse` messages quote the body, so repeating the error text
 * would feed untrusted output back in as instructions. The prompt gets our own
 * words or nothing.
 */
const UNREADABLE_REPLY = 'the reply could not be read as JSON'
/**
 * The empty-content case is a different failure with a different fix: the model
 * said nothing, so the repair must ask for an answer, not for valid JSON. Both
 * strings are ours; neither quotes the reply.
 */
const EMPTY_REPLY = 'the reply had no content at all'

/** Whether a reply error was "nothing came back" rather than "garbage came back". */
function isEmptyReply(error: ModelReplyError): boolean {
  return error.message === EMPTY_CONTENT_MESSAGE
}

/** Fewer surviving titles than this means the reply did not do the task. */
const MIN_TOP_FIVE = 3
/**
 * The default cap on the report's top list.
 *
 * Five was a product decision made when the kernel produced one kind of candidate
 * and most of them were long functions. Now that a scan can surface security rules,
 * constraints and idioms, five is the number that makes a good scan look thin. The
 * cap is a parameter; this is only what a caller gets when it does not care.
 */
const DEFAULT_MAX_POINTS = 5
const MAX_MAX_POINTS = 12
const MAX_REASON_CHARS = 200

const SYNTHESIS_SCHEMA = {
  type: 'object',
  required: ['problem', 'topFive'],
  properties: {
    problem: { type: 'string' },
    topFive: { type: 'array', items: { type: 'string' } },
  },
} as const

export type Synthesis = { problem: string; topFive: string[] }

export type SynthesisDeps = {
  client: ModelClient
  profile: Profile
  structure: StructureIndex
  /** The surviving point titles, already in the caller's preferred order. */
  titles: string[]
  /** Output language; `zh` is the shipped default. */
  lang?: Lang
  /**
   * How many points the top list may hold. Clamped to 1..12.
   *
   * The report is not allowed to be shorter than the reader asked for *nor* longer
   * than the candidates can support: a caller that passes 10 with 6 verified points
   * gets 6, because inventing four would be worse than a short list.
   */
  maxPoints?: number
}

export type StructureSummary = {
  moduleCount: number
  unresolved: number
  topImported: Array<{ module: string; imports: number }>
}

// --- structure summary ----------------------------------------------------

/**
 * The shape of the module graph, compressed to what fits in a sentence.
 *
 * The full index is thousands of paths and would spend the prompt budget on
 * detail the reader never sees; the hub modules and the unresolved count are
 * what let the model say something true about the architecture.
 */
export function summarizeStructure(
  structure: StructureIndex,
  limit: number = TOP_IMPORTED_LIMIT,
): StructureSummary {
  const modules = Array.isArray(structure?.modules) ? structure.modules : []
  const inbound = new Map<string, number>()

  for (const module of modules) {
    const imports = Array.isArray(module?.imports) ? module.imports : []
    for (const edge of imports) {
      const target = edge?.resolved
      if (typeof target !== 'string' || target === '') continue
      inbound.set(target, (inbound.get(target) ?? 0) + 1)
    }
  }

  const topImported = [...inbound.entries()]
    .map(([module, imports]) => ({ module, imports }))
    .sort((a, b) =>
      a.imports === b.imports
        ? a.module < b.module
          ? -1
          : a.module > b.module
            ? 1
            : 0
        : b.imports - a.imports,
    )
    .slice(0, Math.max(0, limit))

  return {
    moduleCount: modules.length,
    unresolved:
      typeof structure?.unresolved === 'number' && Number.isFinite(structure.unresolved)
        ? structure.unresolved
        : 0,
    topImported,
  }
}

// --- prompt ---------------------------------------------------------------

const systemZh = (maxPoints: number): string => `你是 anatomy 的综述器。输入只有三样东西：仓库画像、模块图摘要、以及已经核对过的学习点标题。
任务：用一段话说明这个仓库是做什么的、为什么它值得读；并从给定标题中挑出最值得学习的 ${maxPoints} 条。

只输出一个 JSON 对象：不要 Markdown 代码围栏，不要任何解释文字。
输出形状：{"problem": string, "topFive": string[]}

硬性规则：
1. 输出语言必须是简体中文。
2. topFive 的每一项必须从"学习点标题"里逐字复制：不得改写、不得翻译、不得截断、不得自己编造标题。
3. topFive 最多 ${maxPoints} 条，按"最值得学"排序。宁少勿滥：三条好过凑数。
4. 你看不到代码，只有画像、摘要和标题。不要描述具体实现，不要引用代码，也不要在 problem 里写任何不出现在这些标题里的结论。
5. problem 是给读者的开场，不是标签。只写一句"是什么"不合格，必须让读者读完就知道这个仓库解决了什么具体问题、它的工程难点落在哪。写 80–200 字，按这个顺序组织，不要分点、不要小标题，连成一段话：
   - 它是什么：什么类型的项目、大概什么规模、用什么写的（依据画像和摘要里的数字，可以说"约 8000 行 mjs"这种，不要编造数字）；
   - 难在哪：从给定的学习点标题反推出它真正吃力的地方——是并发、是内存回收、是外部输入不可信、是长期演进，挑一两个真实的矛盾说；
   - 为什么值得读：这些难点的解法能迁移到读者自己的什么东西上。
   禁止写"值得学习""设计精妙""很优雅""值得一看"这类空话；禁止把标题原样复述一遍充数；禁止介绍仓库历史、作者、Star 数这类画像里没有的东西。`

const systemEn = (maxPoints: number): string => `You are the synthesiser for anatomy. The input is exactly three things: a repository profile, a module graph summary, and the titles of the learning points that already passed verification.
Task: say in one paragraph what this repository is for and why it is worth reading, then pick the ${maxPoints} most worth learning from the given titles.

Output exactly one JSON object: no Markdown fences, no prose around it.
Shape: {"problem": string, "topFive": string[]}

Hard rules:
1. The output language must be English.
2. Every item of topFive must be copied verbatim from the point titles: no rewriting, no translation, no truncation, no title of your own.
3. topFive holds at most ${maxPoints} items, ordered by what is most worth learning. Fewer and better beats a padded list.
4. You cannot see code — only the profile, the summary and the titles. Do not describe an implementation, do not quote code, and do not put a claim in problem that these titles do not support.
5. problem is the reader's opening, not a label. One line saying what the project is does not pass: the reader must finish it knowing which concrete problem this repository solves and where its engineering difficulty sits. Write 80–200 characters, in this order, as one flowing paragraph — no bullets, no headings:
   - what it is: the kind of project, roughly how large, in what language (use the numbers from the profile and summary — "about 8000 lines of mjs" is fine, invented numbers are not);
   - where it hurts: infer from the given point titles what this codebase actually struggled with — concurrency, memory reclamation, untrusted input, long-term evolution — name one or two of the real tensions;
   - why it is worth reading: what the reader could carry into their own work.
   Never write filler such as "worth learning", "elegant design", "beautifully done", or "a must read". Never restate the titles as filler. Never mention history, authorship or stars — nothing the profile does not support.`

/**
 * The system prompt with the cap filled in.
 *
 * The number has to reach the prompt as data, not as prose someone remembered to
 * edit. It used to be the literal word 五, while the caller silently truncated at
 * five: ask for ten and the model would still answer with five, then the repair
 * loop would reject the reply for being short. It appears twice below — the task
 * line and the rule — because a model that reads only one of them still gets it.
 */
function systemPrompt(lang: Lang, maxPoints: number): string {
  return lang === 'en' ? systemEn(maxPoints) : systemZh(maxPoints)
}

function listOrNone(lang: Lang, items: string[]): string {
  return items.length === 0 ? (lang === 'en' ? '(none)' : '（无）') : items.join(', ')
}

function yesNo(lang: Lang, value: boolean): string {
  if (lang === 'en') return value ? 'yes' : 'no'
  return value ? '有' : '无'
}

/** Languages by file count, largest first: a one-line answer to "what is this". */
function languagesBySize(profile: Profile): Array<[string, number]> {
  const entries = Object.entries(profile.languages ?? {}).filter(
    (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]),
  )
  return entries.sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : b[1] - a[1]))
}

function profileBlock(lang: Lang, profile: Profile): string {
  const languages = languagesBySize(profile).map(([name, count]) => `${name} ${count}`)
  const manifests = Array.isArray(profile.manifests) ? profile.manifests : []
  const entryPoints = Array.isArray(profile.entryPoints) ? profile.entryPoints : []
  const notes = Array.isArray(profile.notes) ? profile.notes : []

  if (lang === 'en') {
    return [
      'Repository profile',
      `- languages (by file count): ${listOrNone(lang, languages)}`,
      `- manifests: ${listOrNone(lang, manifests)}`,
      `- entry points: ${listOrNone(lang, entryPoints)}`,
      `- tests: ${yesNo(lang, profile.hasTests)} / CI: ${yesNo(lang, profile.hasCi)} / docs: ${yesNo(lang, profile.hasDocs)}`,
      `- notes: ${listOrNone(lang, notes)}`,
    ].join('\n')
  }
  return [
    '仓库画像',
    `- 语言（按文件数）: ${listOrNone(lang, languages)}`,
    `- 清单文件: ${listOrNone(lang, manifests)}`,
    `- 入口: ${listOrNone(lang, entryPoints)}`,
    `- 测试: ${yesNo(lang, profile.hasTests)} / CI: ${yesNo(lang, profile.hasCi)} / 文档: ${yesNo(lang, profile.hasDocs)}`,
    `- 备注: ${listOrNone(lang, notes)}`,
  ].join('\n')
}

function summaryBlock(lang: Lang, summary: StructureSummary): string {
  const hubs = summary.topImported.map((item) => `${item.module} (${item.imports})`)
  if (lang === 'en') {
    return [
      'Module graph summary',
      `- modules: ${summary.moduleCount}`,
      `- most-imported modules: ${listOrNone(lang, hubs)}`,
      `- unresolved imports: ${summary.unresolved}`,
    ].join('\n')
  }
  return [
    '模块图摘要',
    `- 模块数: ${summary.moduleCount}`,
    `- 被依赖最多的模块: ${listOrNone(lang, hubs)}`,
    `- 未解析导入: ${summary.unresolved}`,
  ].join('\n')
}

function titlesBlock(lang: Lang, titles: string[]): string {
  const heading =
    lang === 'en'
      ? 'Point titles (topFive may only copy these verbatim)'
      : '学习点标题（topFive 只能从这里逐字复制）'
  const lines = titles.map((title, index) => `${index + 1}. ${title}`)
  return `${heading}\n${lines.join('\n')}`
}

/** A one-shot repair instruction; `reason` is our own text, never model output. */
function repairNote(lang: Lang, reason: string): string {
  const shortened =
    reason.length <= MAX_REASON_CHARS ? reason : `${reason.slice(0, MAX_REASON_CHARS)}…`
  return lang === 'en'
    ? `\n\nThe previous reply was unusable: ${shortened}\nReply again with one complete JSON object.`
    : `\n\n上一次回复不能使用：${shortened}\n请重新输出一个完整的 JSON 对象。`
}

/** The whole request, pure and therefore assertable: no disk, no network. */
export function buildSynthesisPrompt(input: {
  profile: Profile
  structure: StructureIndex
  titles: string[]
  lang?: Lang
  maxPoints?: number
}): { system: string; user: string; schema: object } {
  const lang: Lang = input.lang ?? 'zh'
  const cap = resolveMaxPoints(input.maxPoints)
  const summary = summarizeStructure(input.structure)
  const user = [
    profileBlock(lang, input.profile),
    summaryBlock(lang, summary),
    titlesBlock(lang, input.titles),
  ].join('\n\n')
  return { system: systemPrompt(lang, cap), user, schema: SYNTHESIS_SCHEMA }
}

// --- reply ----------------------------------------------------------------

type Parsed = { ok: true; problem: string; topFive: string[] } | { ok: false; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The titles to work with, deduplicated on their trimmed form.
 *
 * `prompt` is what the model may copy, in the caller's preferred order.
 * `canonical` maps that trimmed form back to the string the caller passed, so
 * a returned title is the caller's own string and not our copy of it.
 */
type TitleSet = { prompt: string[]; canonical: Map<string, string> }

/** `maxPoints` as a usable count: absent means the default, out-of-range is clamped. */
function resolveMaxPoints(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_MAX_POINTS
  return Math.max(1, Math.min(MAX_MAX_POINTS, Math.floor(requested)))
}

function uniqueTitles(titles: unknown): TitleSet {
  const list = Array.isArray(titles) ? titles : []
  const seen = new Set<string>()
  const canonical = new Map<string, string>()
  for (const item of list) {
    if (typeof item !== 'string') continue
    const key = item.trim()
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    canonical.set(key, item)
  }
  return { prompt: [...seen], canonical }
}

/**
 * Shape check plus the subset rule.
 *
 * A title the model invented is not an option the report can offer, so it is
 * dropped rather than repaired: the surviving items are returned as they were
 * given, never as the model spelled them.
 */
function parseReply(
  raw: unknown,
  titles: string[],
  canonical: Map<string, string>,
  maxPoints: number,
): Parsed {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return { ok: false, reason: 'the reply is not JSON' }
    }
  }
  if (!isRecord(value)) return { ok: false, reason: 'the reply is not a JSON object' }

  const problem = value['problem']
  if (typeof problem !== 'string' || problem.trim() === '') {
    return { ok: false, reason: 'the reply has no problem statement' }
  }

  const topFive = value['topFive']
  if (!Array.isArray(topFive) || !topFive.every((item) => typeof item === 'string')) {
    return { ok: false, reason: 'the reply has no topFive string[]' }
  }

  const known = new Set(titles)
  const picked = new Set<string>()
  const chosen: string[] = []
  for (const item of topFive) {
    // Whitespace is the one difference worth forgiving: a model that indents a
    // title copied it, and the copy is replaced by the caller's exact string.
    const key = item.trim()
    if (!known.has(key) || picked.has(key)) continue
    picked.add(key)
    chosen.push(canonical.get(key) ?? key)
    if (chosen.length === maxPoints) break
  }

  return { ok: true, problem: problem.trim(), topFive: chosen }
}

// --- deterministic fallback -----------------------------------------------

/**
 * What the report says when the model could not be made to say anything.
 *
 * Deterministic, built from the profile and the summary, and never an apology:
 * the reader is told what the repository is; the ranking already carries the
 * rest.
 */
function fallbackProblem(
  lang: Lang,
  profile: Profile,
  summary: StructureSummary,
): string {
  const language = languagesBySize(profile)[0]?.[0]
  if (lang === 'en') {
    const lead =
      language === undefined
        ? `This repository has ${summary.moduleCount} modules`
        : `This is a ${language} repository with ${summary.moduleCount} modules`
    return `${lead}. The five points below are what is most worth learning from it.`
  }
  const lead =
    language === undefined
      ? `这个仓库共有 ${summary.moduleCount} 个模块`
      : `这是一个以 ${language} 为主、共 ${summary.moduleCount} 个模块的仓库`
  return `${lead}。下面五条是其中最值得学习的方向。`
}

// --- synthesis ------------------------------------------------------------

/**
 * The problem statement and the top five, or a deterministic stand-in for them.
 *
 * Throws only for failures no retry can fix: a missing key, or a transport
 * failure the client has already retried to exhaustion. A bad reply costs one
 * repair attempt and then the fallback, because a report without a summary is
 * still a report.
 */
export async function synthesize(deps: SynthesisDeps): Promise<Synthesis> {
  const lang: Lang = deps.lang ?? 'zh'
  const { prompt: titles, canonical } = uniqueTitles(deps.titles)
  const summary = summarizeStructure(deps.structure)
  const original = (title: string): string => canonical.get(title) ?? title
  const cap = resolveMaxPoints(deps.maxPoints)
  const fallback = (): Synthesis => ({
    problem: fallbackProblem(lang, deps.profile, summary),
    topFive: titles.slice(0, cap).map(original),
  })

  // Nothing to rank: no call, no tokens, and a summary that is still true.
  if (titles.length === 0) return fallback()

  const prompt = buildSynthesisPrompt({
    profile: deps.profile,
    structure: deps.structure,
    titles,
    lang,
    maxPoints: cap,
  })
  const required = Math.min(Math.min(MIN_TOP_FIVE, cap), titles.length)
  let reason = ''

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const request: ModelRequest = {
      system: prompt.system,
      user: attempt === 0 ? prompt.user : `${prompt.user}${repairNote(lang, reason)}`,
      schema: prompt.schema,
    }

    let raw: unknown
    try {
      raw = (await deps.client.complete(request)).json
    } catch (error) {
      if (error instanceof MissingCredentialsError) throw error
      // The client already spent its retry budget on a 429/5xx/network failure.
      if (error instanceof ModelRequestError) throw error
      // Only an unreadable reply is ours to repair. Anything else is a defect in
      // our own code, and another identical request would hide it instead of
      // fixing it.
      if (!(error instanceof ModelReplyError)) throw error
      reason = isEmptyReply(error) ? EMPTY_REPLY : UNREADABLE_REPLY
      continue
    }

    const parsed = parseReply(raw, titles, canonical, cap)
    if (!parsed.ok) {
      reason = parsed.reason
      continue
    }
    if (parsed.topFive.length < required) {
      reason = `only ${parsed.topFive.length} of the returned titles came from the provided list`
      continue
    }
    return { problem: parsed.problem, topFive: parsed.topFive }
  }

  return fallback()
}
