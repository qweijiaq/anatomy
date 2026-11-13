/**
 * The MCP transport.
 *
 * The protocol is small enough to be tested without an SDK: feed it lines, read
 * lines back. What matters is not the framing but three rules — a notification gets
 * no reply, an unknown method gets an error with the right code, and a failed tool
 * reports through `isError` rather than by killing the stream. An agent that loses
 * its server because one scan failed cannot recover.
 */

import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { serveMcp } from '../src/commands/mcp.js'

/** Drive the server with a list of requests and collect its output lines. */
async function exchange(requests: string[]): Promise<Array<Record<string, unknown>>> {
  const input = new PassThrough()
  const output = new PassThrough()
  const lines: string[] = []
  output.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) if (line.trim() !== '') lines.push(line)
  })

  const served = serveMcp(input, output)
  for (const request of requests) input.write(`${request}\n`)
  input.end()
  await served
  await new Promise((resolve) => setImmediate(resolve))
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>)
}

const init = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } },
})

describe('ana mcp', () => {
  it('answers initialize with a protocol version and a name', async () => {
    const [response] = await exchange([init])
    const result = response?.result as Record<string, unknown>
    expect(result['protocolVersion']).toBeTypeOf('string')
    expect((result['serverInfo'] as Record<string, unknown>)['name']).toBe('anatomy')
  })

  it('does not answer a notification — that is the contract', async () => {
    const replies = await exchange([init, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })])
    // One reply for initialize, none for the notification.
    expect(replies).toHaveLength(1)
    expect(replies[0]?.['id']).toBe(1)
  })

  it('lists the three deterministic tools and no model-calling one', async () => {
    const replies = await exchange([init, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })])
    const tools = (replies[1]?.result as { tools: Array<{ name: string }> }).tools
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'anatomy_evidence',
      'anatomy_report',
      'anatomy_scan',
    ])
    // `analyze` spends the caller's tokens; an MCP server that quietly bills a
    // provider is a bad guest, so it must not appear here.
    expect(tools.some((tool) => tool.name.includes('analyze'))).toBe(false)
  })

  it('reports a failing tool through isError instead of dying', async () => {
    const replies = await exchange([
      init,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'anatomy_report', arguments: { runId: 'nosuchrun' } },
      }),
    ])
    const result = replies[1]?.result as { isError?: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toMatch(/nosuchrun/)
  })

  it('errors on an unknown method with -32601 rather than replying empty', async () => {
    const replies = await exchange([init, JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'nope/method' })])
    const error = replies[1]?.['error'] as { code: number }
    expect(error.code).toBe(-32601)
  })

  it('errors on unparseable input with -32700 and keeps serving', async () => {
    const replies = await exchange([
      '{not json',
      JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' }),
    ])
    expect((replies[0]?.['error'] as { code: number }).code).toBe(-32700)
    // The stream survives: the next request is still answered.
    expect(replies[1]?.['id']).toBe(5)
  })

  it('rejects a tool call with no name without throwing', async () => {
    const replies = await exchange([
      init,
      JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: {} }),
    ])
    expect((replies[1]?.['error'] as { code: number }).code).toBe(-32602)
  })
})
