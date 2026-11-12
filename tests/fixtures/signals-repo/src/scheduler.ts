/**
 * Task scheduling for the report writer: a fixed-size ring drained every tick.
 */

export type Job = { dueAt: number; run: () => void }

export class Scheduler {
  private readonly slots: Array<Job | null>
  private cursor = 0

  constructor(capacity: number) {
    this.slots = new Array<Job | null>(capacity).fill(null)
  }

  // We chose to probe forward from a cursor instead of shifting the array,
  // because shifting is O(n) per push and the ring is there to keep push O(1).
  push(job: Job): boolean {
    const start = this.cursor
    do {
      if (this.slots[this.cursor] === null) {
        this.slots[this.cursor] = job
        return true
      }
      this.cursor = (this.cursor + 1) % this.slots.length
    } while (this.cursor !== start)
    return false
  }

  drain(now: number, out: Job[]): void {
    for (let i = 0; i < this.slots.length; i += 1) {
      const job = this.slots[i]
      if (job !== null && job !== undefined && job.dueAt <= now) {
        this.slots[i] = null
        out.push(job)
      }
    }
  }
}
