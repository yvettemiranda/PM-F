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

export interface ComplianceCheckInput {
  walletAddress: string;
  walletType: string;
  network: string;
  authorizedSignerAddress: string | null;
}

export interface ComplianceResult {
  status: "ALLOWED" | "BLOCKED" | "UNAVAILABLE";
  checkedAt: string | null;
  source: string | null;
  policyVersion: string | null;
  reason: string | null;
}

export interface ComplianceProvider {
  readonly providerType: ReadonlySafetyProviderType;
  check(input: ComplianceCheckInput): Promise<ComplianceResult>;
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

export class DisabledComplianceProvider implements ComplianceProvider {
  readonly providerType = "DISABLED" as const;

  async check(_input: ComplianceCheckInput): Promise<ComplianceResult> {
    return {
      status: "UNAVAILABLE",
      checkedAt: null,
      source: null,
      policyVersion: null,
      reason: "COMPLIANCE_PROVIDER_DISABLED",
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

export class FakeComplianceProvider implements ComplianceProvider {
  readonly providerType = "FAKE" as const;

  constructor(private readonly result: ComplianceResult) {}

  async check(_input: ComplianceCheckInput): Promise<ComplianceResult> {
    return this.result;
  }
}

/**
 * A read-only policy adapter for production composition. It contains only
 * public wallet/network policy evidence and cannot sign, submit, or mutate
 * external state. The caller must provide an explicit policy version and
 * checked timestamp; missing evidence fails closed in LiveGateService.
 */
export class ConfiguredComplianceProvider implements ComplianceProvider {
  readonly providerType = "LIVE_READONLY" as const;

  constructor(
    private readonly policy: {
      policyVersion: string;
      source: string;
      checkedAt: string;
      allowedNetworks: readonly string[];
      allowedWalletTypes: readonly string[];
      allowedWalletAddresses?: readonly string[];
    },
  ) {}

  async check(input: ComplianceCheckInput): Promise<ComplianceResult> {
    const walletAddress = input.walletAddress.trim().toLowerCase();
    const allowed = this.policy.allowedNetworks.includes(input.network)
      && this.policy.allowedWalletTypes.includes(input.walletType)
      && (this.policy.allowedWalletAddresses === undefined
        || this.policy.allowedWalletAddresses.some((address) => address.toLowerCase() === walletAddress))
      && input.authorizedSignerAddress !== null;
    return {
      status: allowed ? "ALLOWED" : "BLOCKED",
      checkedAt: this.policy.checkedAt,
      source: this.policy.source,
      policyVersion: this.policy.policyVersion,
      reason: allowed ? null : "COMPLIANCE_POLICY_REJECTED",
    };
  }
}
