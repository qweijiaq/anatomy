/**
 * `ana mcp` — the deterministic half of anatomy, as an MCP server over stdio.
 *
 * The split this project is built around is *facts* (kernel, no model, verifiable)
 * against *judgement* (one writing layer, costs tokens). An agent that already has
 * a model does not need our judgement — it needs the facts, in a shape it can call.
 * That is what this exposes: `scan` (where to look), `report` (a stored report as
 * markdown), and `evidence` (the bytes behind one citation). Every one of them is
 * the same code path the CLI runs; this file is a transport, not a second
 * implementation.
 *
 * No dependency. MCP over stdio is JSON-RPC 2.0 with newline-delimited messages, so
 * the whole server is a readline loop and three handlers. Pulling in an SDK to
 * speak a protocol this small would add a supply-chain surface for no behaviour.
 *
 * Nothing here spends tokens and nothing reaches the network beyond what `scan`
 * already does when given a URL.
 */

import { createInterface } from 'node:readline'

import { forget } from './forget.js'
import { runScan, type ScanOptions } from './scan.js'
import { runReport } from './report.js'
import { runInspect } from './inspect.js'
import { readVersion } from '../version.js'

/** The MCP revision this speaks. Only the parts used here are stabilised. */
const PROTOCOL_VERSION = '2024-11-05'

type JsonRpcId = string | number | null

type Request = { jsonrpc: '2.0'; id?: JsonRpcId; method: string; params?: unknown }

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

type Tool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run: (args: Record<string, unknown>) => Promise<ToolResult>
}

function text(value: string): ToolResult {
  return { content: [{ type: 'text', text: value }] }
}

function failure(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value : ''
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * The catalogue.
 *
 * Every description says what the tool does *not* do, because an agent choosing a
 * tool reads the description and nothing else. `analyze` is deliberately absent:
 * it spends the caller's tokens on a judgement the caller's own model can make,
 * and an MCP server that quietly bills a provider is a bad guest.
 */
function tools(): Tool[] {
  return [
    {
      name: 'anatomy_scan',
      description:
        'Score the files of a repository for signals worth reading and return the ranked candidates with their locations. Deterministic, no model calls, no API key. Use this to find where to look; it does not explain what the code does.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: {
            type: 'string',
            description: 'GitHub URL, tarball URL, or a local directory path.',
          },
          top: { type: 'number', description: 'How many candidates to return (default 8).' },
          subpath: { type: 'string', description: 'Analyse only this subtree of the repository.' },
          ref: { type: 'string', description: 'Tag, branch or commit; defaults to the latest release.' },
        },
        required: ['repo'],
      },
      run: async (args) => {
        const repo = stringArg(args, 'repo')
        if (repo === '') return failure('需要 repo 参数：一个仓库地址或本地目录')
        const subpath = stringArg(args, 'subpath')
        const ref = stringArg(args, 'ref')
        const top = numberArg(args, 'top')
        const options: ScanOptions = {
          ...(subpath === '' ? {} : { subpath }),
          ...(ref === '' ? {} : { ref }),
          ...(top === undefined ? {} : { topK: top }),
        }
        // The scan writes its own progress; the MCP channel must stay clean, so the
        // summary is captured rather than streamed.
        const captured: string[] = []
        try {
          const summary = await runScan(repo, options, {
            out: { write: (chunk: string) => captured.push(chunk) },
          })
          return text(
            JSON.stringify(
              {
                runId: summary.runId,
                files: summary.profile.languages,
                // Coverage, so a caller can tell "no candidates" from "nothing was
                // read" — the difference matters when the answer is used to decide
                // whether to keep looking.
                scannedFiles: summary.scope.totals.files,
                excluded: summary.scope.excluded,
                candidates: summary.candidates.map((candidate) => ({
                  path: candidate.path,
                  line: candidate.line,
                  kind: candidate.kind,
                  score: candidate.score,
                  matched: candidate.matched,
                })),
              },
              null,
              2,
            ),
          )
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'anatomy_report',
      description:
        'Render a stored analysis as markdown. Re-renders from the run artifacts, so it works after the extracted tree has been deleted. Returns the report text; it does not re-run the analysis.',
      inputSchema: {
        type: 'object',
        properties: { runId: { type: 'string', description: 'The run id printed by anatomy_scan or ana analyze.' } },
        required: ['runId'],
      },
      run: async (args) => {
        const runId = stringArg(args, 'runId')
        if (runId === '') return failure('需要 runId 参数')
        const captured: string[] = []
        try {
          await runReport(runId, { out: { write: (chunk: string) => captured.push(chunk) } })
          return text(captured.join(''))
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'anatomy_evidence',
      description:
        'Print the file and verbatim snippet behind one evidence id from a stored run. Use it to check a claim the report made before repeating it.',
      inputSchema: {
        type: 'object',
        properties: { evidenceId: { type: 'string', description: 'An id of the form <runId>:<path>:<startLine>' } },
        required: ['evidenceId'],
      },
      run: async (args) => {
        const evidenceId = stringArg(args, 'evidenceId')
        if (evidenceId === '') return failure('需要 evidenceId 参数')
        const captured: string[] = []
        try {
          await runInspect(evidenceId, { out: { write: (chunk: string) => captured.push(chunk) } })
          return text(captured.join(''))
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      // Without this the surface can create state it cannot remove: every
      // `anatomy_scan` writes a run directory, and an agent in a long session
      // would accumulate them with no way to clean up. The CLI has `forget`; a
      // server that exposes the creating half and not the removing half is
      // leaving litter in the caller's home directory.
      name: 'anatomy_forget',
      description:
        'Delete one stored run directory. Same id safety as the CLI: an id, never a path, validated against the same rule the read path uses, so a typo cannot delete something else.',
      inputSchema: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'Run id to delete.' },
          kind: {
            type: 'string',
            enum: ['run', 'app'],
            description:
              'Which store to delete from: `run` for .ana/runs (default), `app` for .ana/apps.',
          },
        },
        required: ['runId'],
      },
      run: async (args) => {
        const runId = stringArg(args, 'runId')
        if (runId === '') return failure('需要 runId 参数')
        const kind = stringArg(args, 'kind') === 'app' ? 'app' : 'run'
        try {
          const result = await forget(runId, { target: kind })
          return 'missing' in result ? failure(`没有 ${runId}，什么都没删`) : text(`已删除 ${result.removed}`)
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error))
        }
      },
    },
  ]
}

/** One JSON-RPC response line. Never throws: a transport must not die on a request. */
async function dispatch(request: Request): Promise<object | null> {
  const id = request.id ?? null
  const reply = (result: unknown): object => ({ jsonrpc: '2.0', id, result })
  const error = (code: number, message: string): object => ({ jsonrpc: '2.0', id, error: { code, message } })

  switch (request.method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'anatomy', version: readVersion() },
      })
    // A notification: no id, no response. Saying nothing is the whole contract.
    case 'notifications/initialized':
      return null
    case 'tools/list':
      return reply({
        tools: tools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      })
    case 'tools/call': {
      const params = (request.params ?? {}) as { name?: unknown; arguments?: unknown }
      const name = typeof params.name === 'string' ? params.name : ''
      const tool = tools().find((candidate) => candidate.name === name)
      if (tool === undefined) return error(-32602, `unknown tool "${name}"`)
      const args = (typeof params.arguments === 'object' && params.arguments !== null
        ? params.arguments
        : {}) as Record<string, unknown>
      return reply(await tool.run(args))
    }
    case 'ping':
      return reply({})
    default:
      return error(-32601, `method not found: ${request.method}`)
  }
}

/**
 * Serve until stdin closes.
 *
 * `resolve` returns when the stream ends so the caller can exit with a clear code;
 * a server that keeps the process alive after its client leaves is a leak.
 */
export async function serveMcp(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<void> {
  const reader = createInterface({ input, crlfDelay: Infinity })

  // Requests are handled in order. Concurrency would buy nothing here — every tool
  // is either CPU-bound or waiting on the same scan — and it would let two responses
  // interleave out of order, which some clients treat as a protocol violation.
  let queue: Promise<void> = Promise.resolve()

  reader.on('line', (line) => {
    const trimmed = line.trim()
    if (trimmed === '') return
    queue = queue.then(async () => {
      let request: Request
      try {
        request = JSON.parse(trimmed) as Request
      } catch {
        output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`)
        return
      }
      if (typeof request?.method !== 'string') {
        output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } })}\n`)
        return
      }
      const response = await dispatch(request)
      if (response !== null) output.write(`${JSON.stringify(response)}\n`)
    })
  })

  await new Promise<void>((resolve) => reader.on('close', resolve))
  await queue
}
