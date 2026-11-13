/**
 * The name classifier.
 *
 * It exists to turn a flat list of channels into a reading, and every claim it
 * makes is a claim about a *name*. The tests pin the precedence order, because a
 * name that lands in two groups silently makes the counts wrong.
 */

import { describe, expect, it } from 'vitest'

import { classifyName, groupNames, nameTokens } from '../src/app/classify.js'

describe('nameTokens', () => {
  it('splits on separators and on case boundaries', () => {
    expect(nameTokens('models:list')).toEqual(['models', 'list'])
    expect(nameTokens('pickFolder')).toEqual(['pick', 'folder'])
    expect(nameTokens('report.read')).toEqual(['report', 'read'])
    expect(nameTokens('settings-save')).toEqual(['settings', 'save'])
  })
})

describe('classifyName', () => {
  it('puts a system-reaching channel in privileged even when it also reads', () => {
    // `pickFolder` contains no read verb, but `analysis:run` does contain `analysis`;
    // neither may fall through to "other".
    expect(classifyName('dialog:pickFolder')).toBe('privileged')
    expect(classifyName('analysis:run')).toBe('privileged')
    expect(classifyName('app.pickFolder')).toBe('privileged')
  })

  it('separates writing from reading', () => {
    expect(classifyName('settings:save')).toBe('write')
    expect(classifyName('settings:read')).toBe('read')
    expect(classifyName('report.list')).toBe('read')
    expect(classifyName('models:list')).toBe('read')
  })

  it('calls a listener an event rather than the verb inside it', () => {
    expect(classifyName('analysis:progress')).toBe('event')
    expect(classifyName('analysis.onProgress')).toBe('event')
  })

  it('admits when a name says nothing', () => {
    expect(classifyName('analysis')).toBe('other')
    expect(classifyName('')).toBe('other')
  })
})

describe('groupNames', () => {
  it('counts each name once, in the order a reader should read them', () => {
    const grouped = groupNames(['settings:save', 'analysis:run', 'app:info', 'analysis'])
    expect(grouped.privileged).toEqual(['analysis:run'])
    expect(grouped.write).toEqual(['settings:save'])
    expect(grouped.read).toEqual(['app:info'])
    expect(grouped.other).toEqual(['analysis'])
    expect(grouped.event).toEqual([])
  })
})
