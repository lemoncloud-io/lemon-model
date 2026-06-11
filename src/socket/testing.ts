/**
 * `socket/testing.ts`
 * - isolated entry for the in-memory peer/network simulator.
 * - kept OUT of the package root barrel so production bundles do not include the simulator runtime.
 *
 * Usage (tests / dev only):
 *   import { createNetwork, createPeer, createSocketFactory } from 'lemon-model/socket/testing';
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
export * from './socket';
