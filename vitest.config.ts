import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // tests/fixtures is raw test input, not test code: a fixture repository may
    // legitimately contain files named *.test.ts and they must not be collected.
    exclude: [...configDefaults.exclude, 'tests/fixtures/**'],
    environment: 'node',
    // Test files share `dist/` and one of them shells out to `npm pack`. On a
    // fast CI runner, `cli.test` compiling into dist while `packaging.test`
    // enumerates it produced npm's EOF error; the two are not independent. Run
    // files one at a time so the gate is deterministic, not timing-dependent.
    fileParallelism: false,
  },
})
