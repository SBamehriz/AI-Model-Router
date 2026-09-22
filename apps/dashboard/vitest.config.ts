import path from 'path';
import { defineConfig } from 'vitest/config';

/**
 * Pure display logic only. Rendering is covered by the browser sweep, which
 * drives the real pages; these cover the helpers underneath it, where a wrong
 * answer is silent rather than visible. A live routing cost once rendered as
 * $0.0000 because a rounding guard was missing from one of two formatters, and
 * type checks, lint and a screenshot all looked fine.
 */
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The brand wash test reads the stylesheet as an asset. Stubbed CSS hands
    // it an empty string and the assertions quietly pass on nothing.
    css: true,
  },
});
