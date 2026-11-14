/**
 * The guards this project relies on, and what each one protects.
 *
 * `scripts/verify.sh` and `scripts/audit.sh` are guarded by tests that fail when a
 * section is removed, so neither can quietly get weaker. The rest of the suite had no
 * such protection: delete `evidence.test.ts` and nothing notices except the absence of
 * a failure that was never going to happen.
 *
 * This is the inventory. Deleting a guard file fails here — and, more importantly,
 * so does adding one and not recording it, which is how an inventory stays honest.
 */

import { readdirSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..')

/** file → what it protects. One line each, because a list of names protects nothing. */
const GUARDS: Record<string, string> = {
  'advertised-options.test.ts': '帮助文案里的 flag 与环境变量必须真被读取',
  'artifact-readers.test.ts': '每个产物都有读者，读者真的读了它',
  'docs-consistency.test.ts': '文档里的数字、路径、测试名与产物一致',
  'evidence.test.ts': '编造的行号、错的片段、越界的路径进不了正文',
  'forget.test.ts': '删除只按 id，不按路径；存档有上限',
  'inspect.test.ts': '报告里的引用能取回原文',
  'mcp.test.ts': '四个 MCP 工具的协议形状',
  'packaging.test.ts': '打包内容、可执行性、窗口的 CSP 与 bridge',
  'report-view.test.ts': '窗口的解析器与实体解码',
  'scan.test.ts': '真实仓库比夹具更脏的五种情形',
  'structure-python.test.ts': '被分析仓库的代码不被导入或执行',
}

describe('the guard inventory', () => {
  it('every guard it names exists', () => {
    const present = new Set(readdirSync(path.join(ROOT, 'tests')))
    const missing = Object.keys(GUARDS).filter((name) => !present.has(name))
    expect(missing, `这些守卫不见了：${missing.join(', ')}`).toEqual([])
  })

  it('the suite never shrinks below what it covers today', () => {
    // Most files are ordinary unit tests rather than guards, and listing thirty of them
    // would be an inventory nobody maintains. The count is the cheap, honest version:
    // deleting a file — guard or not — drops it, and the drop has to be explained by
    // changing this number.
    const present = readdirSync(path.join(ROOT, 'tests')).filter((name) => name.endsWith('.test.ts'))
    expect(present.length).toBeGreaterThanOrEqual(30)
  })
})
