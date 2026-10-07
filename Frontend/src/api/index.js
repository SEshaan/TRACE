/**
 * api/index.js
 * ---------------------------------------------------------------------------
 * The single import surface for everything above the API layer.
 *
 *   import { useQueryRun, API_ERROR } from '@/api'
 *
 * Nothing above this file imports from api/client or api/transport directly.
 * ---------------------------------------------------------------------------
 */

export * from './client';
export { API_ERROR, ApiError } from './errors';
export { API_BASE } from './transport';
export { EP } from './endpoints';
