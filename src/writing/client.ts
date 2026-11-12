/**
 * The only place anatomy spends tokens, and therefore the only place that can
 * lose money, credentials or a run.
 *
 * Three decisions keep it honest:
 *
 * - `fetch` is injected. Tests never touch the network, and the product is not
 *   tied to a vendor: the body is plain OpenAI-compatible chat completions
 *   (`response_format: json_object`), and the base URL is configuration.
 * - Credentials are resolved when `complete` is called, not when the client is
 *   built. A `createModelClient()` at module load must not throw for a user who
 *   only runs `ana scan`; a missing key is an error only when a model is needed.
 * - A 429, a 5xx, a network failure or a stalled connection is retried here with
 *   a bounded budget and then surfaced as `ModelRequestError`. A stalled
 *   connection only counts as a failure because every attempt carries a
 *   deadline; without one a hung socket would hold the CLI forever and the
 *   retry budget would never engage. A syntactically broken reply is a
 *   different failure (`ModelReplyError`, no retry here): the judge owns the
 *   single repair attempt, so a flaky provider never looks like a bad prompt.
 * - A provider's error body is untrusted text that would otherwise be copied
 *   into the run report. Only the status code is published.
 */

export type Usage = { in: number; out: number }

export type ModelRequest = { system: string; user: string; schema: object }

export type ModelResponse = { json: unknown; usage: Usage }

export type ModelClient = {
  complete(req: ModelRequest): Promise<ModelResponse>
}

export type ModelClientConfig = {
  model?: string
  apiKey?: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  /** Retries after the first attempt. Defaults to 2; 0 disables retrying. */
  maxRetries?: number
  /** Base backoff between attempts. Defaults to 250ms; tests pass 0. */
  retryDelayMs?: number
  /** Per-attempt request deadline. Defaults to 60s; tests pass a few ms. */
  timeoutMs?: number
}

export const DEFAULT_MODEL = 'gpt-4o-mini'
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_MAX_RETRIES = 2
export const DEFAULT_RETRY_DELAY_MS = 250
export const DEFAULT_TIMEOUT_MS = 60_000

/** Thrown by `complete`, never by `createModelClient`. */
export class MissingCredentialsError extends Error {
  constructor(message = 'ANA_API_KEY is not set; export it or pass apiKey') {
    super(message)
    this.name = 'MissingCredentialsError'
  }
}

/**
 * A request that did not produce a reply: HTTP status, network failure, or a
 * provider that answered with something that was not a chat completion.
 */
export class ModelRequestError extends Error {
  readonly retryable: boolean
  readonly status: number | null

  constructor(
    message: string,
    options: { retryable: boolean; status?: number | null; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ModelRequestError'
    this.retryable = options.retryable
    this.status = options.status ?? null
  }
}

/**
 * A reply that arrived but is unusable: no message content, or content that is
 * not the JSON object the prompt asked for. The tokens were spent, so `usage`
 * is carried even though this is an error.
 */
export class ModelReplyError extends Error {
  readonly usage: Usage
  readonly status: number | null

  constructor(message: string, usage: Usage = { in: 0, out: 0 }, status: number | null = null) {
    super(message)
    this.name = 'ModelReplyError'
    this.usage = usage
    this.status = status
  }
}

export type RequestConfig = { model: string; baseUrl: string; apiKey: string }

export type BuiltRequest = {
  url: string
  init: {
    method: 'POST'
    headers: Record<string, string>
    body: string
    /** Set per attempt by `complete`; building a request never arms a deadline. */
    signal?: AbortSignal
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The whole HTTP shape, pure and therefore assertable.
 *
 * `schema` stays on the request for a future structured-output adapter; it is
 * deliberately not sent as a top-level field, because only `json_object` is
 * understood by every OpenAI-compatible provider.
 */
export function buildRequest(req: ModelRequest, cfg: RequestConfig): BuiltRequest {
  const base = cfg.baseUrl.replace(/\/+$/, '')
  return {
    url: `${base}/chat/completions`,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
      }),
    },
  }
}

/** A non-empty explicit value wins; otherwise the environment; otherwise default. */
function pick(explicit: string | undefined, envName: string, fallback: string): string {
  if (typeof explicit === 'string' && explicit !== '') return explicit
  const fromEnv = process.env[envName]
  return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : fallback
}

/**
 * Read at call time so `createModelClient()` is safe to build before the CLI has
 * parsed its flags, and so a test can stub the environment per call.
 */
function resolveApiKey(explicit: string | undefined): string {
  const key = typeof explicit === 'string' && explicit !== '' ? explicit : process.env['ANA_API_KEY']
  return typeof key === 'string' ? key.trim() : ''
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function shorten(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`
}

/**
 * `AbortSignal.timeout` rejects with a `TimeoutError`; a provider or a proxy can
 * also abort with a bare `AbortError`. Both mean "no reply arrived", which is a
 * retryable transport failure, not a bad reply.
 */
function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const name = (error as { name?: unknown }).name
  return name === 'AbortError' || name === 'TimeoutError'
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0
  return Math.floor(value)
}

/** `{prompt_tokens, completion_tokens}` plus the `input/output` spelling some providers use. */
function usageOf(payload: unknown): Usage {
  if (!isRecord(payload)) return { in: 0, out: 0 }
  const usage = payload['usage']
  if (!isRecord(usage)) return { in: 0, out: 0 }
  return {
    in: count(usage['prompt_tokens'] ?? usage['input_tokens']),
    out: count(usage['completion_tokens'] ?? usage['output_tokens']),
  }
}

function contentOf(payload: unknown): string | null {
  if (!isRecord(payload)) return null
  const choices = payload['choices']
  if (!Array.isArray(choices) || choices.length === 0) return null
  const first = choices[0]
  if (!isRecord(first)) return null
  const message = first['message']
  if (!isRecord(message)) return null
  const content = message['content']
  return typeof content === 'string' ? content : null
}

/** Models sometimes wrap JSON in a fence even when told not to. */
function stripFence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return trimmed
  return trimmed
    .replace(/^```[A-Za-z0-9_-]*\s*\n?/, '')
    .replace(/\n?```$/, '')
    .trim()
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function readReply(response: Response): Promise<ModelResponse> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    throw new ModelReplyError(
      `model reply is not JSON: ${messageOf(error)}`,
      { in: 0, out: 0 },
      response.status,
    )
  }

  const usage = usageOf(payload)
  const content = contentOf(payload)
  if (content === null) {
    throw new ModelReplyError('model reply has no message content', usage, response.status)
  }

  const text = stripFence(content)
  try {
    return { json: JSON.parse(text), usage }
  } catch {
    throw new ModelReplyError(
      `model reply content is not JSON: ${shorten(text, 120)}`,
      usage,
      response.status,
    )
  }
}

export function createModelClient(cfg: ModelClientConfig = {}): ModelClient {
  return {
    async complete(req: ModelRequest): Promise<ModelResponse> {
      const apiKey = resolveApiKey(cfg.apiKey)
      if (apiKey === '') throw new MissingCredentialsError()

      const model = pick(cfg.model, 'ANA_MODEL', DEFAULT_MODEL)
      const baseUrl = pick(cfg.baseUrl, 'ANA_BASE_URL', DEFAULT_BASE_URL)
      const fetchImpl = cfg.fetchImpl ?? globalThis.fetch
      if (typeof fetchImpl !== 'function') {
        throw new ModelRequestError('no fetch implementation is available', { retryable: false })
      }

      const maxRetries =
        typeof cfg.maxRetries === 'number' && Number.isFinite(cfg.maxRetries)
          ? Math.max(0, Math.floor(cfg.maxRetries))
          : DEFAULT_MAX_RETRIES
      const retryDelayMs =
        typeof cfg.retryDelayMs === 'number' && Number.isFinite(cfg.retryDelayMs)
          ? Math.max(0, cfg.retryDelayMs)
          : DEFAULT_RETRY_DELAY_MS
      const timeoutMs =
        typeof cfg.timeoutMs === 'number' && Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0
          ? Math.floor(cfg.timeoutMs)
          : DEFAULT_TIMEOUT_MS

      const { url, init } = buildRequest(req, { model, baseUrl, apiKey })
      let lastError: ModelRequestError | null = null

      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        if (attempt > 0) await sleep(retryDelayMs * 2 ** (attempt - 1))

        let response: Response
        try {
          // A fresh deadline per attempt: a signal armed once outside the loop
          // would already be aborted by the time a retry is sent.
          response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
        } catch (error) {
          lastError = new ModelRequestError(
            isAbortError(error)
              ? `model request timed out after ${timeoutMs}ms`
              : `model request failed: ${messageOf(error)}`,
            { retryable: true, cause: error },
          )
          continue
        }

        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500
          // The status is the part of the failure that is ours to publish. The
          // body is provider text, sometimes echoed request content, and it is
          // copied verbatim into the run report by later stages, so it stays out.
          const error = new ModelRequestError(`model request failed: HTTP ${response.status}`, {
            retryable,
            status: response.status,
          })
          // A 401 or a 400 will fail again identically: spend no more tokens.
          if (!retryable) throw error
          lastError = error
          continue
        }

        return await readReply(response)
      }

      throw lastError ?? new ModelRequestError('model request failed', { retryable: true })
    },
  }
}
