import { RULESET } from "../domain/versioning.js";
import type {
  ClockSafetyProvider,
  ClockSafetyResult,
} from "./live-safety-provider.js";

export const CLOB_TIME_ENDPOINT = "https://clob.polymarket.com/time";

interface ClobClockSafetyProviderOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRttMs?: number;
  unsafeOffsetThresholdMs?: number;
  nowMs?: () => number;
}

export class ClobClockSafetyProvider implements ClockSafetyProvider {
  readonly providerType = "LIVE_READONLY" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRttMs: number;
  private readonly unsafeOffsetThresholdMs: number;
  private readonly nowMs: () => number;

  constructor(options: ClobClockSafetyProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.maxRttMs = options.maxRttMs ?? 2_000;
    this.unsafeOffsetThresholdMs = options.unsafeOffsetThresholdMs ?? RULESET.clockUnsafeThresholdMs;
    this.nowMs = options.nowMs ?? Date.now;
    for (const value of [this.timeoutMs, this.maxRttMs, this.unsafeOffsetThresholdMs]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error("CLOCK_PROVIDER_CONFIG_INVALID");
    }
  }

  async check(): Promise<ClockSafetyResult> {
    const startedAt = this.nowMs();
    try {
      const response = await this.fetchImpl(CLOB_TIME_ENDPOINT, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return this.unavailable(`CLOCK_HTTP_${response.status}`);
      const payload = (await response.text()).trim();
      const completedAt = this.nowMs();
      if (!/^\d+$/.test(payload)) return this.unavailable("CLOCK_RESPONSE_INVALID");
      const serverSeconds = Number(payload);
      if (!Number.isSafeInteger(serverSeconds) || serverSeconds <= 0) return this.unavailable("CLOCK_RESPONSE_INVALID");
      const roundTripMs = completedAt - startedAt;
      if (!Number.isFinite(roundTripMs) || roundTripMs < 0 || roundTripMs > this.maxRttMs) {
        return this.unavailable("CLOCK_RTT_UNSAFE");
      }
      const midpointMs = startedAt + roundTripMs / 2;
      const offsetMs = Math.round(serverSeconds * 1_000 - midpointMs);
      const status = Math.abs(offsetMs) <= this.unsafeOffsetThresholdMs ? "SAFE" : "UNSAFE";
      return {
        status,
        offsetMs,
        checkedAt: new Date(completedAt).toISOString(),
        source: CLOB_TIME_ENDPOINT,
        reason: status === "SAFE" ? null : "CLOCK_OFFSET_EXCEEDED",
      };
    } catch {
      return this.unavailable("CLOCK_REQUEST_FAILED");
    }
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
