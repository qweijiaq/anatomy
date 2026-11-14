/**
 * Every artifact a run writes must have a reader, or a reason not to.
 *
 * Three separate times this project produced data that nothing consumed:
 * `structure.symbols` was extracted, merged and written by every run and read by
 * nobody; `scope.files` carried the whole per-file inventory while the report
 * printed a total; `report.json` is written on every analysis and no code path
 * opens it. None of that showed up as a bug — a thing that is computed and then
 * dropped fails no test and logs nothing.
 *
 * So this test does not check behaviour. It checks the *decision*: adding an
 * artifact to a run directory now forces a statement of who reads it, and adding a
 * sub-structure that no surface touches fails here rather than being discovered
 * months later as "we compute a symbol table for nothing".
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..')

/**
 * Every file a run directory can hold, and who opens it.
 *
 * `readers` is not documentation — it is the assertion. An entry with an empty
 * reader list has to say why under `outputOnly`, and that sentence is the reason a
 * future reader will accept or challenge.
 */
const ARTIFACTS: Record<string, { readers: string[]; outputOnly?: string }> = {
  // Read through `readManifest`, so the literal name appears once — in the helper.
  // Everyone else (`report`, `analyze`, the desktop list) goes through it.
  manifest: { readers: ['src/store/runs.ts'] },
  scope: { readers: ['src/commands/report.ts'] },
  profile: { readers: ['src/commands/report.ts'] },
  structure: { readers: ['src/commands/report.ts'] },
  candidates: { readers: ['src/commands/report.ts'] },
  points: { readers: ['src/commands/report.ts', 'src/commands/inspect.ts'] },
  // The window used to read these two straight out of the run to decide what its
  // history could open. It asks `listRuns` now — one definition of "has a report"
  // instead of two — so the reader moved with the question.
  validation: { readers: ['src/commands/report.ts'] },
  synthesis: { readers: ['src/commands/report.ts', 'src/commands/runs.ts'] },
  skipped: { readers: ['src/commands/report.ts'] },
  report: {
    readers: [],
    outputOnly:
      'The JSON form of the report, archived beside report.md for other tools. `ana analyze --json` renders it live rather than reading this copy, so nothing here opens it — that is the design, and if it stops being true this entry should grow a reader instead of the sentence disappearing.',
  },
}

function sources(): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(absolute)
        continue
      }
      if (/\.(ts|tsx)$/.test(entry.name)) files.push(absolute)
    }
  }
  for (const dir of ['src', 'electron', 'renderer/src']) walk(path.join(ROOT, dir))
  return files
}



/** The artifacts the scanner writes, straight from the pipeline. */
function declaredArtifacts(): string[] {
  const source = readFileSync(path.join(ROOT, 'src/kernel/pipeline.ts'), 'utf8')
  const match = /const RUN_ARTIFACTS = \[([^\]]+)\]/.exec(source)
  if (match === null) throw new Error('RUN_ARTIFACTS not found in pipeline.ts')
  return [...(match[1] as string).matchAll(/'([a-z-]+)'/g)].map((item) => item[1] as string)
}

/** The artifacts `analyze` adds on top of the scan's. */
function analyzeArtifacts(): string[] {
  const source = readFileSync(path.join(ROOT, 'src/commands/analyze.ts'), 'utf8')
  return [...source.matchAll(/run\.write\('([a-z-]+)'/g)].map((item) => item[1] as string)
}

describe('run artifacts', () => {
  it('has an entry for every artifact a run writes', () => {
    const written = new Set([...declaredArtifacts(), ...analyzeArtifacts()])
    const documented = new Set(Object.keys(ARTIFACTS))
    const missing = [...written].filter((name) => !documented.has(name))
    // Adding an artifact without deciding who reads it fails here.
    expect(missing).toEqual([])
  })

  it('does not document an artifact nobody writes', () => {
    const written = new Set([...declaredArtifacts(), ...analyzeArtifacts()])
    const stale = Object.keys(ARTIFACTS).filter((name) => !written.has(name))
    expect(stale).toEqual([])
  })

  it('gives every artifact a reader, or a written reason it has none', () => {
    for (const [name, entry] of Object.entries(ARTIFACTS)) {
      if (entry.readers.length > 0) continue
      expect(entry.outputOnly, `${name} has no reader and no stated reason`).toBeTruthy()
    }
  })

  it('names readers that exist and actually mention the artifact', () => {
    const all = sources()
    for (const [name, entry] of Object.entries(ARTIFACTS)) {
      for (const reader of entry.readers) {
        const absolute = path.join(ROOT, reader)
        const source = readFileSync(absolute, 'utf8')
        // A reader is only a reader if it asks for the artifact by name.
        expect(source.includes(`'${name}'`), `${reader} does not read '${name}'`).toBe(true)
        expect(all.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('sub-structures', () => {
  /**
   * The ones that were computed and dropped.
   *
   * `symbols` and `files` are now printed by the appendix. This pins that they stay
   * reachable from a rendered report: if the appendix stops using them the test
   * fails, which is the whole point — a silent return to "computed for nothing".
   */
  it('keeps the symbol table and the file inventory on the rendered page', () => {
    const source = readFileSync(path.join(ROOT, 'src/render/markdown.ts'), 'utf8')
    expect(source, 'structure.symbols is no longer surfaced').toContain('symbols')
    expect(source, 'scope.files is no longer surfaced').toContain('scope?.files')
  })
})

describe('the command surface', () => {
  /**
   * Every command answers `--help`.
   *
   * Six of the eight did; `app-report` and `app-diff` treated the flag as a path
   * and tried to open `-`. A command that exists but cannot explain itself is the
   * kind of gap that never breaks a test and always wastes a user's minute.
   */
  it('documents all eight commands', () => {
    const source = readFileSync(path.join(ROOT, 'src/cli.ts'), 'utf8')
    const usage = /const USAGE = `([\s\S]*?)`/.exec(source)?.[1] ?? ''
    for (const command of [
      'scan',
      'analyze',
      'report',
      'inspect',
      'inspect-app',
      'app-report',
      'app-diff',
      'forget',
    ]) {
      expect(usage, `${command} missing from the top-level usage`).toContain(`${command} `)
    }
  })

  it('has a usage string for every command', () => {
    // Static on purpose: the shape of the dispatch is not the thing under test, and
    // an earlier version of this test matched braces and got the wrong answer.
    // Every file under src/ that could declare one, so a new command in a new module
    // is covered without editing this list.
    const joined = sources()
      .filter((file) => file.includes(`src${path.sep}`))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')
    for (const command of [
      'scan',
      'analyze',
      'report',
      'inspect',
      'inspect-app',
      'app-report',
      'app-diff',
      'forget',
    ]) {
      expect(joined, `${command} has no usage string`).toContain(`Usage: ana ${command}`)
    }
  })
})

describe('the command surface — error output', () => {
  /**
   * One prefix, from the program that is speaking.
   *
   * Library errors identify themselves with `anatomy:`; the CLI speaks as `ana`.
   * `describeFailure` strips the former so the reader sees `ana: …` and not
   * `ana: anatomy: …`. `report` bypassed it with a special case for
   * `NoSuchRunError`, which is the only command where the doubled prefix appeared.
   */
  it('lets every command use the same prefix-stripping path', () => {
    const source = readFileSync(path.join(ROOT, 'src/cli.ts'), 'utf8')
    // A branch that prints `error.message` directly skips the strip.
    const direct = [...source.matchAll(/io\.err\.write\(`ana: \$\{error\.message\}`/g)]
    expect(direct).toEqual([])
  })

  it('strips however many kernel prefixes were nested', () => {
    const source = readFileSync(path.join(ROOT, 'src/cli.ts'), 'utf8')
    expect(source).toContain('replace(/^(?:anatomy: )+/, ')
  })
})
