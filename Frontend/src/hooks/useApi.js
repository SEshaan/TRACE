/**
 * hooks/useApi.js
 * ---------------------------------------------------------------------------
 * Generic request hook for ad-hoc calls.
 *
 * Aborts the in-flight request on unmount and cancels superseded runs, so a
 * fast double-click cannot resolve out of order.
 * ---------------------------------------------------------------------------
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_ERROR, ApiError } from '../api/errors';

function toErrorShape(err) {
  if (err instanceof ApiError) {
    return {
      code: err.code,
      message: err.message,
      detail: err.detail,
      fields: err.fields,
      endpoint: err.endpoint,
      status: err.status,
    };
  }
  return { code: API_ERROR.NETWORK, message: err?.message ?? 'Unexpected error.', detail: null, fields: [], endpoint: null, status: 0 };
}

/**
 * @param {(...args, {signal}) => Promise<any>} fn  must accept a trailing {signal}
 */
export function useApi(fn) {
  const [state, setState] = useState({ data: null, loading: false, error: null });

  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  const aliveRef = useRef(true);
  const controllerRef = useRef(null);

  useEffect(
    () => () => {
      aliveRef.current = false;
      controllerRef.current?.abort?.();
    },
    [],
  );

  const abort = useCallback(() => {
    controllerRef.current?.abort?.();
  }, []);

  const run = useCallback(async (...args) => {
    controllerRef.current?.abort?.();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState((prev) => ({ ...prev, loading: true }));

    try {
      const data = await fnRef.current(...args, { signal: controller.signal });
      if (aliveRef.current) setState({ data, loading: false, error: null });
      return data;
    } catch (err) {
      const apiError = err instanceof ApiError ? err : new ApiError(err?.message ?? 'Unexpected error.', { code: API_ERROR.NETWORK, cause: err });
      if (aliveRef.current && !apiError.isAborted) {
        setState({ data: null, loading: false, error: toErrorShape(apiError) });
      }
      return null;
    }
  }, []);

  return { ...state, run, abort };
}
