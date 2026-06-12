/**
 * `genai/testing.ts`
 * - isolated entry for GenAI proxy test helpers (fetch routing + `/dump` contract mocks).
 * - kept OUT of the package root barrel so production bundles do not include test helpers.
 *
 * Usage (tests / dev only):
 *   import { createAgentGenerateFetcher, MockAgentGenerateController } from 'lemon-model/genai/testing';
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
export * from './mocks';
