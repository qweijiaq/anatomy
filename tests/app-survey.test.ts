/**
 * The Electron counters, which are the whole reason `inspect-app` exists.
 *
 * These tests exist because of a real defect: the survey once read its counters
 * from an `inspect-analysis-view` projection instead of from the evidence itself,
 * and the projection reported zeros while the evidence said `context_bridge_apis:
 * 1, exposed_api_members: 15`. A confident zero is the worst thing this view can
 * show, so the mapping is pinned here rather than trusted.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  heapLimited,
  parseProgress,
  pickSmallSources,
  SMALL_SOURCE_MAX_BYTES,
  surfaceFrom,
} from '../src/app/rea.js'

describe('surfaceFrom', () => {
  it('reads the counters REA actually reported', () => {
    const surface = surfaceFrom({
      browser_windows: 2,
      preload_entrypoints: 1,
      context_bridge_apis: 1,
      exposed_api_members: 15,
      ipc: {
        operations: 10,
        literal_channels: 10,
        main_handlers: 4,
        renderer_transmissions: 9,
        renderer_listeners: 1,
        ambiguous_renderer_transmissions: 9,
      },
      sender_validation_observations: 3,
      native_addon_bindings: 1,
      protocol_registrations: 2,
      electron_semantics: 'partial',
    })

    expect(surface).toMatchObject({
      browserWindows: 2,
      preloadEntrypoints: 1,
      contextBridgeApis: 1,
      exposedApiMembers: 15,
      ipcOperations: 10,
      ipcLiteralChannels: 10,
      ipcMainHandlers: 4,
      rendererTransmissions: 9,
      ambiguousTransmissions: 9,
      nativeAddonBindings: 1,
      protocolRegistrations: 2,
      semantics: 'partial',
    })
  })

  it('turns a missing field into 0 rather than NaN, so the UI cannot render 0/NaN', () => {
    const surface = surfaceFrom({})
    expect(surface.contextBridgeApis).toBe(0)
    expect(surface.ipcOperations).toBe(0)
    // Not `undefined` and not `NaN`: the view prints this number.
    expect(Number.isNaN(surface.exposedApiMembers)).toBe(false)
    expect(surface.semantics).toBe('unknown')
  })

  it('survives a malformed ipc block without throwing', () => {
    // REA omits `ipc` entirely for a non-Electron directory.
    const surface = surfaceFrom({ context_bridge_apis: 1, ipc: null })
    expect(surface.contextBridgeApis).toBe(1)
    expect(surface.ipcOperations).toBe(0)
  })
})

describe('heapLimited', () => {
  it('recognises both ways REA reports the worker heap running out', () => {
    // Per-file form, as it appears for main.cjs.
    expect(
      heapLimited([
        'main.cjs: Resource constraint during analyze_javascript_application: Owned JavaScript worker exhausted its 1024 MiB V8 old-space heap (max_heap_mb) while analyzing main.cjs during static',
      ]),
    ).toBe(true)
    // The generic resource-constraint wording, without a file prefix.
    expect(heapLimited(['Preload discovery could not read main.cjs (Resource constraint: max_heap_mb)'])).toBe(
      true,
    )
  })

  it('is not fooled by the ordinary limitations, which retrying cannot fix', () => {
    expect(
      heapLimited([
        'Graph coverage is incomplete; unavailable facts remain explicit and must not be read as absence.',
        'Static paths and relationships may remain unresolved when expressions are dynamic or obfuscated.',
        'JavaScript and HTML were parsed as inert text; bundle bootstrap code was never executed.',
      ]),
    ).toBe(false)
  })
})

describe('pickSmallSources', () => {
  it('finds the files that declare the boundary and skips the bundle that broke it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ana-small-'))
    await mkdir(path.join(root, 'renderer', 'assets'), { recursive: true })

    // The two that matter, at the shallow levels an Electron app puts them.
    await writeFile(path.join(root, 'preload.cjs'), 'module.exports = {}')
    await writeFile(path.join(root, 'main.cjs'), 'const x = 1')
    // A bundle: named nothing like a boundary file, and far too large to be one.
    await writeFile(path.join(root, 'renderer', 'assets', 'index-abc.js'), 'x')
    // Vendored code is never first-party.
    await mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true })
    await writeFile(path.join(root, 'node_modules', 'dep', 'main.js'), 'x')

    const found = await pickSmallSources(root)
    expect(found).toEqual(['main.cjs', 'preload.cjs'])
  })

  it('refuses a file too large to be a declaration, even when the name matches', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ana-small-'))
    await writeFile(path.join(root, 'main.js'), 'x'.repeat(SMALL_SOURCE_MAX_BYTES + 1))
    expect(await pickSmallSources(root)).toEqual([])
  })
})

describe('parseProgress', () => {
  it('reads the counts out of the sentence REA puts them in', () => {
    const progress = parseProgress(
      '{"rea_progress":{"phase":"parse_javascript_source","completed":0,"total":1,"message":"Parsing and projecting server/auth-store.js (12/73)","sequence":4}}',
    )
    expect(progress).toMatchObject({ phase: 'parse_javascript_source', done: 12, total: 73 })
  })

  it('accepts a line without counts', () => {
    const progress = parseProgress(
      '{"rea_progress":{"phase":"read_javascript_artifacts","message":"Reading inventoried sources"}}',
    )
    expect(progress).toMatchObject({ done: null, total: null })
  })

  it('ignores everything that is not a progress line', () => {
    // stderr carries real errors too, and printing them as progress would hide them.
    expect(parseProgress('Error: something went wrong')).toBeNull()
    expect(parseProgress('{"error":"boom"}')).toBeNull()
    expect(parseProgress('{not json')).toBeNull()
    expect(parseProgress('')).toBeNull()
  })

  it('ignores a progress object with no message, which says nothing to a reader', () => {
    expect(parseProgress('{"rea_progress":{"phase":"x","completed":0,"total":1}}')).toBeNull()
  })
})
