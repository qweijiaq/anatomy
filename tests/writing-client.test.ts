import { describe, expect, it } from 'vitest'

import {
  buildRequest,
  createModelClient,
  MissingCredentialsError,
  type ModelRequest,
} from '../src/writing/client.js'

const request: ModelRequest = {
  system: 'you are a judge',
  user: 'here is a slice',
  schema: { type: 'object' },
}

describe('buildRequest — openai protocol', () => {
  it('posts chat completions with the schema as a json_object hint', () => {
    const built = buildRequest(request, {
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1/',
      apiKey: 'sk-test',
    })

    expect(built.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(built.init.headers['authorization']).toBe('Bearer sk-test')
    const body = JSON.parse(built.init.body) as Record<string, unknown>
    expect(body['response_format']).toEqual({ type: 'json_object' })
    expect(body['messages']).toEqual([
      { role: 'system', content: 'you are a judge' },
      { role: 'user', content: 'here is a slice' },
    ])
    expect(body['thinking']).toBeUndefined()
  })

  it('disables deepseek thinking, which otherwise truncates JSON', () => {
    const built = buildRequest(request, {
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test',
      disableThinking: true,
    })

    expect((JSON.parse(built.init.body) as Record<string, unknown>)['thinking']).toEqual({
      type: 'disabled',
    })
  })
})

describe('buildRequest — anthropic protocol', () => {
  it('posts to the messages endpoint with the system prompt as a top-level field', () => {
    // A reader who pastes a Claude key should not discover the difference by
    // reading an error: the Messages API has no system role and no response_format.
    const built = buildRequest(request, {
      model: 'claude-sonnet-5',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant',
      protocol: 'anthropic',
    })

    expect(built.url).toBe('https://api.anthropic.com/v1/messages')
    expect(built.init.headers['x-api-key']).toBe('sk-ant')
    expect(built.init.headers['anthropic-version']).toBe('2023-06-01')
    expect(built.init.headers['authorization']).toBeUndefined()

    const body = JSON.parse(built.init.body) as Record<string, unknown>
    expect(body['system']).toBe('you are a judge')
    expect(body['messages']).toEqual([{ role: 'user', content: 'here is a slice' }])
    expect(body['response_format']).toBeUndefined()
    expect(body['max_tokens']).toBeGreaterThan(0)
  })
})

describe('createModelClient — protocol plumbing', () => {
  const reply = (payload: unknown) =>
    ({
      ok: true,
      status: 200,
      json: async () => payload,
    }) as unknown as Response

  it('reads an anthropic reply, whose content is a block list', async () => {
    const seen: string[] = []
    const client = createModelClient({
      model: 'claude-sonnet-5',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant',
      protocol: 'anthropic',
      fetchImpl: async (input) => {
        seen.push(String(input))
        return reply({
          content: [{ type: 'text', text: '{"points":[]}' }],
          usage: { input_tokens: 12, output_tokens: 3 },
        })
      },
    })

    const result = await client.complete(request)

    expect(seen).toEqual(['https://api.anthropic.com/v1/messages'])
    expect(result.json).toEqual({ points: [] })
    expect(result.usage).toEqual({ in: 12, out: 3 })
  })

  it('still reads an openai reply', async () => {
    const client = createModelClient({
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      fetchImpl: async () =>
        reply({
          choices: [{ message: { content: '{"points":[]}' } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
    })

    const result = await client.complete(request)

    expect(result.json).toEqual({ points: [] })
    expect(result.usage).toEqual({ in: 5, out: 2 })
  })

  it('refuses to call without a key', async () => {
    const client = createModelClient({ model: 'gpt-4o-mini', apiKey: '' })
    await expect(client.complete(request)).rejects.toBeInstanceOf(MissingCredentialsError)
  })
})
