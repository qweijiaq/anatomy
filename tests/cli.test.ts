import { describe, expect, it } from 'vitest'

import { runCli } from '../src/cli.js'

function capture() {
  let out = ''
  let err = ''
  return {
    io: {
      out: { write: (chunk: string) => (out += chunk) },
      err: { write: (chunk: string) => (err += chunk) },
    },
    get out() {
      return out
    },
    get err() {
      return err
    },
  }
}

describe('ana cli', () => {
  it('prints the package version on --version', async () => {
    const cap = capture()
    const code = await runCli(['--version'], cap.io)
    expect(code).toBe(0)
    expect(cap.out.trim()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('prints usage to stderr with exit code 2 when called bare', async () => {
    const cap = capture()
    const code = await runCli([], cap.io)
    expect(code).toBe(2)
    expect(cap.err).toContain('Usage: ana')
    expect(cap.out).toBe('')
  })

  it('rejects an unknown command with exit code 2', async () => {
    const cap = capture()
    const code = await runCli(['bogus'], cap.io)
    expect(code).toBe(2)
    expect(cap.err).toContain('unknown command')
    expect(cap.err).toContain('bogus')
  })

  it('prints usage to stdout with exit code 0 on --help', async () => {
    const cap = capture()
    const code = await runCli(['--help'], cap.io)
    expect(code).toBe(0)
    expect(cap.out).toContain('Usage: ana')
    expect(cap.err).toBe('')
  })
})
