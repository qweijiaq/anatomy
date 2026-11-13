/**
 * The Electron counters, which are the whole reason `inspect-app` exists.
 *
 * These tests exist because of a real defect: the survey once read its counters
 * from an `inspect-analysis-view` projection instead of from the evidence itself,
 * and the projection reported zeros while the evidence said `context_bridge_apis:
 * 1, exposed_api_members: 15`. A confident zero is the worst thing this view can
 * show, so the mapping is pinned here rather than trusted.
 */

import { describe, expect, it } from 'vitest'

import { surfaceFrom } from '../src/app/rea.js'

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
