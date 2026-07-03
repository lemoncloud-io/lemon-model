/**
 * `sync/index.ts`
 * - model sync client: L3 socket client runtime + L4 sync machine.
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
export * from './types';
export * from './client';
export * from './machine';

//! NOTE: the `Peer` test bridge (`./testing`) is intentionally NOT re-exported here.
//! It is a test-only utility — import it via `lemon-model/sync/testing`-style relative paths
//! within specs so production bundles do not pull in the simulator runtime.
