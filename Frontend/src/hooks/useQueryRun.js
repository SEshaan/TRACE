/**
 * hooks/useQueryRun.js
 * ---------------------------------------------------------------------------
 * The decide -> apply loop. start / pause / resume / stepOnce / abort / reset.
 *
 * The loop itself lives in the store; this hook is the UI-facing surface.
 * ---------------------------------------------------------------------------
 */

import { useQueryStore, startRun, stepOnce, pauseRun, resumeRun, abortRun, resetRun, finishNow } from '../store/queryStore';

export function useQueryRun({ mode = 'auto', maxSteps, stepDelayMs } = {}) {
  const { run, session, result, error, capabilities } = useQueryStore();

  return {
    /* state */
    phase: run.phase,
    mode: run.mode,
    stepIndex: run.stepIndex,
    lastAction: run.lastAction,
    startedAt: run.startedAt,

    isRunning: run.phase === 'running',
    isPaused: run.phase === 'paused',
    isFinished: run.phase === 'finished',
    isFailed: run.phase === 'failed',
    isAborted: run.phase === 'aborted',
    isSettled: run.phase === 'finished' || run.phase === 'failed' || run.phase === 'aborted' || run.phase === 'idle',

    canStart: run.phase === 'idle' || run.phase === 'finished' || run.phase === 'failed' || run.phase === 'aborted',
    canPause: run.phase === 'running',
    canResume: run.phase === 'paused',
    canStep: run.phase === 'paused',

    sessionId: session.id,
    result,
    error,
    online: capabilities.online !== false,

    /* actions */
    start: (prompt, options = {}) =>
      startRun(prompt, {
        mode,
        ...(maxSteps === undefined ? {} : { maxSteps }),
        ...(stepDelayMs === undefined ? {} : { stepDelayMs }),
        ...options,
      }),
    stepOnce,
    pause: pauseRun,
    resume: resumeRun,
    abort: abortRun,
    reset: resetRun,
    finish: finishNow,
  };
}
