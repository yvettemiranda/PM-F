export type ReadonlySafetyProviderType = "DISABLED" | "FAKE" | "LIVE_READONLY";

export interface GeoblockCheckInput {
  walletAddress: string;
  network: string;
}

export interface GeoblockResult {
  status: "ALLOWED" | "BLOCKED" | "UNAVAILABLE";
  checkedAt: string | null;
  source: string | null;
  reason: string | null;
  ip?: string;
  country?: string;
  region?: string;
}

export interface GeoblockProvider {
  readonly providerType: ReadonlySafetyProviderType;
  check(input: GeoblockCheckInput): Promise<GeoblockResult>;
}

export interface ClockSafetyResult {
  status: "SAFE" | "UNSAFE" | "UNAVAILABLE";
  offsetMs: number | null;
  checkedAt: string | null;
  source: string | null;
  reason: string | null;
}

export interface ClockSafetyProvider {
  readonly providerType: ReadonlySafetyProviderType;
  check(): Promise<ClockSafetyResult>;
}

export class DisabledGeoblockProvider implements GeoblockProvider {
  readonly providerType = "DISABLED" as const;

  async check(_input: GeoblockCheckInput): Promise<GeoblockResult> {
    return {
      status: "UNAVAILABLE",
      checkedAt: null,
      source: null,
      reason: "GEOBLOCK_PROVIDER_DISABLED",
    };
  }
}

export class DisabledClockSafetyProvider implements ClockSafetyProvider {
  readonly providerType = "DISABLED" as const;

  async check(): Promise<ClockSafetyResult> {
    return {
      status: "UNAVAILABLE",
      offsetMs: null,
      checkedAt: null,
      source: null,
      reason: "CLOCK_PROVIDER_DISABLED",
    };
  }
}

export class FakeGeoblockProvider implements GeoblockProvider {
  readonly providerType = "FAKE" as const;

  constructor(private readonly result: GeoblockResult) {}

  async check(_input: GeoblockCheckInput): Promise<GeoblockResult> {
    return this.result;
  }
}

export class FakeClockSafetyProvider implements ClockSafetyProvider {
  readonly providerType = "FAKE" as const;

  constructor(private readonly result: ClockSafetyResult) {}

  async check(): Promise<ClockSafetyResult> {
    return this.result;
  }
}
