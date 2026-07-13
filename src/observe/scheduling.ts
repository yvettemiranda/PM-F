export const observeSchedulingGapThresholdMs = (pollIntervalMs: number): number =>
  Math.max(pollIntervalMs * 3, 30_000);

export interface ObservePollTiming {
  startedAt: string;
  completedAt: string;
}

export interface ObserveSchedulingMetrics {
  schedulingGapCount: number;
  maxSchedulingGapMs: number;
  activeRuntimeMs: number;
}

export function deriveObserveSchedulingMetrics(
  startedAt: string,
  stoppedAt: string,
  pollIntervalMs: number,
  polls: ObservePollTiming[],
): ObserveSchedulingMetrics {
  const thresholdMs = observeSchedulingGapThresholdMs(pollIntervalMs);
  let schedulingGapCount = 0;
  let maxSchedulingGapMs = 0;
  let totalSchedulingGapMs = 0;
  let previousCompletedMs: number | null = null;

  for (const poll of polls) {
    const pollStartedMs = Date.parse(poll.startedAt);
    const pollCompletedMs = Date.parse(poll.completedAt);
    if (previousCompletedMs !== null) {
      const idleMs = Math.max(0, pollStartedMs - previousCompletedMs);
      if (idleMs > thresholdMs) {
        const gapMs = Math.max(0, idleMs - pollIntervalMs);
        schedulingGapCount += 1;
        maxSchedulingGapMs = Math.max(maxSchedulingGapMs, gapMs);
        totalSchedulingGapMs += gapMs;
      }
    }
    const pollDurationMs = Math.max(0, pollCompletedMs - pollStartedMs);
    if (pollDurationMs > thresholdMs) {
      const gapMs = pollDurationMs - thresholdMs;
      schedulingGapCount += 1;
      maxSchedulingGapMs = Math.max(maxSchedulingGapMs, gapMs);
      totalSchedulingGapMs += gapMs;
    }
    previousCompletedMs = pollCompletedMs;
  }

  if (previousCompletedMs !== null) {
    const trailingIdleMs = Math.max(0, Date.parse(stoppedAt) - previousCompletedMs);
    if (trailingIdleMs > thresholdMs) {
      const gapMs = Math.max(0, trailingIdleMs - pollIntervalMs);
      schedulingGapCount += 1;
      maxSchedulingGapMs = Math.max(maxSchedulingGapMs, gapMs);
      totalSchedulingGapMs += gapMs;
    }
  }

  const durationMs = Math.max(0, Date.parse(stoppedAt) - Date.parse(startedAt));
  return {
    schedulingGapCount,
    maxSchedulingGapMs,
    activeRuntimeMs: Math.max(0, durationMs - totalSchedulingGapMs),
  };
}
