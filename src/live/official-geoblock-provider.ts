import { isIP } from "node:net";
import type {
  GeoblockCheckInput,
  GeoblockProvider,
  GeoblockResult,
} from "./live-safety-provider.js";

const GEOBLOCK_ENDPOINT = "https://polymarket.com/api/geoblock";

interface OfficialGeoblockProviderOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  now?: () => Date;
}

interface GeoblockPayload {
  blocked: boolean;
  ip: string;
  country: string;
  region: string;
}

export class OfficialGeoblockProvider implements GeoblockProvider {
  readonly providerType = "LIVE_READONLY" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => Date;

  constructor(options: OfficialGeoblockProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxAttempts = options.maxAttempts ?? 2;
    this.now = options.now ?? (() => new Date());
    if (
      !Number.isSafeInteger(this.timeoutMs)
      || this.timeoutMs <= 0
      || !Number.isSafeInteger(this.maxAttempts)
      || this.maxAttempts <= 0
      || this.maxAttempts > 3
    ) {
      throw new Error("GEOBLOCK_TIMEOUT_INVALID");
    }
  }

  async check(_input: GeoblockCheckInput): Promise<GeoblockResult> {
    let lastFailure = "GEOBLOCK_REQUEST_FAILED";
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.fetchImpl(GEOBLOCK_ENDPOINT, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          lastFailure = `GEOBLOCK_HTTP_${response.status}`;
          if ((response.status === 429 || response.status >= 500) && attempt < this.maxAttempts) continue;
          return this.unavailable(lastFailure);
        }
        const payload = await response.json() as unknown;
        if (!this.isValidPayload(payload)) return this.unavailable("GEOBLOCK_RESPONSE_INVALID");
        return {
          status: payload.blocked ? "BLOCKED" : "ALLOWED",
          checkedAt: this.now().toISOString(),
          source: GEOBLOCK_ENDPOINT,
          reason: payload.blocked ? `GEOBLOCK_BLOCKED:${payload.country}:${payload.region}` : null,
          ip: payload.ip,
          country: payload.country,
          region: payload.region,
        };
      } catch {
        lastFailure = "GEOBLOCK_REQUEST_FAILED";
      }
    }
    return this.unavailable(lastFailure);
  }

  private isValidPayload(value: unknown): value is GeoblockPayload {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const candidate = value as Partial<GeoblockPayload>;
    return typeof candidate.blocked === "boolean"
      && typeof candidate.ip === "string"
      && isIP(candidate.ip) !== 0
      && typeof candidate.country === "string"
      && /^[A-Z]{2}$/.test(candidate.country)
      && typeof candidate.region === "string";
  }

  private unavailable(reason: string): GeoblockResult {
    return {
      status: "UNAVAILABLE",
      checkedAt: null,
      source: GEOBLOCK_ENDPOINT,
      reason,
    };
  }
}
