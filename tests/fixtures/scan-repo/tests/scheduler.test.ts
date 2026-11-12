import { describe, expect, it } from 'vitest'

import { Scheduler } from '../src/scheduler.js'

describe('Scheduler', () => {
  it('refuses a job once every slot is taken', () => {
    const scheduler = new Scheduler(1)
    expect(scheduler.push({ dueAt: 0, run: () => undefined })).toBe(true)
    expect(scheduler.push({ dueAt: 0, run: () => undefined })).toBe(false)
  })
})
