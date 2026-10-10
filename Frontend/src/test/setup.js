/**
 * Global test setup for component/hook tests.
 *
 * The repo runs vitest with globals:false, so we still import the framework's
 * helpers explicitly from each test file. Here we load @testing-library and its
 * jest-dom matchers. jest-dom v7 calls `expect.extend()` at import time, which
 * needs a global `expect`; we set it via top-level await (dynamic import) so the
 * assignment runs before jest-dom's module body executes.
 */
import '@testing-library/react';

const { expect } = await import('vitest');
globalThis.expect = expect;

await import('@testing-library/jest-dom');
