/**
 * `logtrace/index.ts`
 * - one-way realtime log stream (reporter/consumer) over a shared socket.
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
export * from './logtrace';

//! NOTE: the verification loop harness (`./testing`) is intentionally NOT re-exported here.
//! It pulls in the in-memory socket simulator — import it via the isolated
//! `lemon-model/logtrace/testing` entry so production bundles stay clean.
