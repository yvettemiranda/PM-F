import { RULESET } from "../domain/versioning.js";
import type {
  ClockSafetyProvider,
  ClockSafetyResult,
} from "./live-safety-provider.js";

export const CLOB_TIME_ENDPOINT = "https://clob.polymarket.com/time";

interface ClobClockSafetyProviderOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  maxRttMs?: number;
  unsafeOffsetThresholdMs?: number;
  nowMs?: () => number;
}

export class ClobClockSafetyProvider implements ClockSafetyProvider {
  readonly providerType = "LIVE_READONLY" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly maxRttMs: number;
  private readonly unsafeOffsetThresholdMs: number;
  private readonly nowMs: () => number;

  constructor(options: ClobClockSafetyProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxAttempts = options.maxAttempts ?? 2;
    this.maxRttMs = options.maxRttMs ?? 2_000;
    this.unsafeOffsetThresholdMs = options.unsafeOffsetThresholdMs ?? RULESET.clockUnsafeThresholdMs;
    this.nowMs = options.nowMs ?? Date.now;
    for (const value of [this.timeoutMs, this.maxAttempts, this.maxRttMs, this.unsafeOffsetThresholdMs]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error("CLOCK_PROVIDER_CONFIG_INVALID");
    }
    if (this.maxAttempts > 3) throw new Error("CLOCK_PROVIDER_CONFIG_INVALID");
  }

  async check(): Promise<ClockSafetyResult> {
    let lastFailure = "CLOCK_REQUEST_FAILED";
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const startedAt = this.nowMs();
      try {
        const response = await this.fetchImpl(CLOB_TIME_ENDPOINT, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          lastFailure = `CLOCK_HTTP_${response.status}`;
          if ((response.status === 429 || response.status >= 500) && attempt < this.maxAttempts) continue;
          return this.unavailable(lastFailure);
        }
        const payload = (await response.text()).trim();
        const completedAt = this.nowMs();
        if (!/^\d+$/.test(payload)) return this.unavailable("CLOCK_RESPONSE_INVALID");
        const serverSeconds = Number(payload);
        if (!Number.isSafeInteger(serverSeconds) || serverSeconds <= 0) {
          return this.unavailable("CLOCK_RESPONSE_INVALID");
        }
        const roundTripMs = completedAt - startedAt;
        if (!Number.isFinite(roundTripMs) || roundTripMs < 0 || roundTripMs > this.maxRttMs) {
          lastFailure = "CLOCK_RTT_UNSAFE";
          if (attempt < this.maxAttempts) continue;
          return this.unavailable(lastFailure);
        }
        const midpointMs = startedAt + roundTripMs / 2;
        const offsetMs = Math.round(serverSeconds * 1_000 - midpointMs);
        // Authenticated CLOB clients are configured with useServerTime=true.
        // The local offset is therefore diagnostic, not a minimum requirement
        // for entering Live. Availability, response shape and RTT still fail
        // closed because those determine whether official server time is
        // trustworthy.
        const offsetObserved = Math.abs(offsetMs) > this.unsafeOffsetThresholdMs;
        return {
          status: "SAFE",
          offsetMs,
          checkedAt: new Date(completedAt).toISOString(),
          source: CLOB_TIME_ENDPOINT,
          reason: offsetObserved ? "CLOCK_OFFSET_OBSERVED_USING_SERVER_TIME" : null,
        };
      } catch {
        lastFailure = "CLOCK_REQUEST_FAILED";
      }
    }
    return this.unavailable(lastFailure);
  }

  private unavailable(reason: string): ClockSafetyResult {
    return {
      status: "UNAVAILABLE",
      offsetMs: null,
      checkedAt: null,
      source: CLOB_TIME_ENDPOINT,
      reason,
    };
  }
}
