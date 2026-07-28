import type {
  ComplianceCheckInput,
  ComplianceProvider,
  ComplianceResult,
} from "../live/live-safety-provider.js";
import { readLiveProductionConfig } from "./live-production-readiness.js";

/**
 * Converts the operator's explicit, wallet-bound compliance acknowledgement
 * into fresh gate evidence. Official geoblocking remains a separate mandatory
 * provider; this class cannot override a blocked or unavailable region check.
 */
export class LiveOperatorComplianceProvider implements ComplianceProvider {
  readonly providerType = "LIVE_READONLY" as const;

  constructor(
    private readonly projectRoot: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async check(input: ComplianceCheckInput): Promise<ComplianceResult> {
    const config = readLiveProductionConfig(this.projectRoot);
    const walletMatches = config.tradingWalletAddress !== null
      && config.tradingWalletAddress === input.walletAddress.toLowerCase();
    const signerMatches = config.walletAddress !== null
      && config.walletAddress === input.authorizedSignerAddress?.toLowerCase();
    const networkMatches = config.network === "POLYGON"
      && (input.network === "POLYGON" || input.network === "polygon:137");
    const walletTypeMatches = input.walletType === config.signatureType
      || (
        config.signatureType === "POLY_GNOSIS_SAFE"
        && input.walletType === "SAFE"
      )
      || (
        config.signatureType === "POLY_PROXY"
        && input.walletType === "PROXY_WALLET"
      )
      || (
        config.signatureType === "POLY_1271"
        && input.walletType === "DEPOSIT_WALLET"
      );
    const accepted = config.complianceAcceptedAt !== null
      && config.limitsConfirmedAt !== null
      && config.limitsConfirmationHash !== null
      && walletMatches
      && signerMatches
      && networkMatches
      && walletTypeMatches;
    return {
      status: accepted ? "ALLOWED" : "BLOCKED",
      checkedAt: this.now().toISOString(),
      source: "HECATONCHIRES_OPERATOR_ATTESTATION",
      policyVersion: "operator-attestation-v1",
      reason: accepted ? null : "OPERATOR_COMPLIANCE_ATTESTATION_MISSING_OR_MISMATCHED",
    };
  }
}
