import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // tests/fixtures is raw test input, not test code: a fixture repository may
    // legitimately contain files named *.test.ts and they must not be collected.
    exclude: [...configDefaults.exclude, 'tests/fixtures/**'],
    environment: 'node',
  },
})
