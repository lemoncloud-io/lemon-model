/**
 * `upload/index.ts`
 * - isolated entry for the upload contract: `import { ... } from 'lemon-model/upload'`.
 * - kept OUT of the package root barrel: a consumer that only needs this contract must not pull
 *   the socket/genai runtime, and a subpath can be promoted to the root later without a breaking
 *   change (the reverse is not true).
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
export * from './types';
