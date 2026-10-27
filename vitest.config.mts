import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/domain*.test.ts', 'tests/production*.test.ts'] },
});
