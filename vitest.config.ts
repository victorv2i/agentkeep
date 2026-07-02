import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'web/app/**/*.test.ts', 'web/lib/**/*.test.ts'],
    alias: {
      // Next's real `server-only` throws outside its RSC bundler; vitest has
      // no bundler, so swap in a no-op stub for tests only (see the stub file
      // for why). Production builds are unaffected — this alias is test-only.
      'server-only': path.resolve(__dirname, 'web/lib/test-server-only-stub.ts'),
    },
  },
})
