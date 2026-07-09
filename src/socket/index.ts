/**
 * `socket/index.ts`
 * - shared socket(network) + json-transport core for F/B usage.
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
export * from './types';
export * from './transport';
export * from './websocket';
export * from './decorators';

//! NOTE: the in-memory peer simulator (`./socket`) is intentionally NOT re-exported here.
//! It is a test/dev utility — import it via the isolated `lemon-model/socket/testing` entry
//! so production (esp. frontend) bundles do not pull in the simulator runtime.
