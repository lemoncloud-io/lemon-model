/**
 * `genai/index.ts`
 * - shared GenAI proxy adapter (Gemini-compatible surface over HTTP + JSONTransport) for F/B usage.
 *
 * @origin eureka-agents-api / src/lib/proxy/index.ts
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
export * from './types';
export * from './proxy';
export * from './transport';
export * from './dump-test';

//! NOTE: test helpers (`./mocks`) are intentionally NOT re-exported here.
//! Import them via the isolated `lemon-model/dist/genai/testing` entry so
//! production (esp. frontend) bundles do not pull in test-only helpers.
