import type {
  IdentityEvidence,
  PublicPosition,
  PublicProfile,
  PublicTrade,
  WalletIdentityReport,
  WalletType,
} from "../domain/models.js";

const LEGACY_PROXY_IMPLEMENTATIONS = new Set(["0x44e999d5c2f66ef0861317f9a4805ac2e90aeb4f"]);
const EIP1167 = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i;

export interface WalletIdentityInput {
  address: string;
  profile: PublicProfile;
  trades: PublicTrade[];
  positions: PublicPosition[];
  contractCode: string | null;
  relayerSafeDeployed: boolean | null;
  relayerWalletDeployed: boolean | null;
  tradeHistoryComplete: boolean;
  observedAt?: Date;
}

export function buildWalletIdentityReport(input: WalletIdentityInput): WalletIdentityReport {
  const address = input.address.toLowerCase();
  const proxyWallet = input.profile.proxyWallet?.toLowerCase() ?? null;
  const evidence: IdentityEvidence[] = [];
  const match = input.contractCode?.match(EIP1167) ?? null;
  const implementationAddress = match?.[1] ? `0x${match[1].toLowerCase()}` : null;

  evidence.push({
    source: "GAMMA_PUBLIC_PROFILE",
    outcome: proxyWallet === address ? "MATCH" : proxyWallet ? "CONFLICT" : "NO_MATCH",
    detail: proxyWallet ? `profile.proxyWallet=${proxyWallet}` : "profile.proxyWallet missing",
  });
  evidence.push({
    source: "POLYGON_ETH_GET_CODE",
    outcome: input.contractCode === "0x" ? "NO_MATCH" : input.contractCode ? "MATCH" : "UNAVAILABLE",
    detail: input.contractCode ? `codeBytes=${Math.max(0, (input.contractCode.length - 2) / 2)}` : "contract code unavailable",
  });
  evidence.push({
    source: "RELAYER_SAFE_DEPLOYMENT_CHECK",
    outcome: input.relayerSafeDeployed === null ? "UNAVAILABLE" : input.relayerSafeDeployed ? "MATCH" : "NO_MATCH",
    detail: `deployed=${String(input.relayerSafeDeployed)}; deployment evidence only, not a wallet-type classifier`,
  });
  evidence.push({
    source: "RELAYER_WALLET_DEPLOYMENT_CHECK",
    outcome: input.relayerWalletDeployed === null ? "UNAVAILABLE" : input.relayerWalletDeployed ? "MATCH" : "NO_MATCH",
    detail: `deployed=${String(input.relayerWalletDeployed)}; deployment evidence only, not a wallet-type classifier`,
  });
  if (implementationAddress) {
    evidence.push({
      source: "EIP1167_IMPLEMENTATION",
      outcome: LEGACY_PROXY_IMPLEMENTATIONS.has(implementationAddress) ? "MATCH" : "NO_MATCH",
      detail: `implementation=${implementationAddress}`,
    });
  }

  let walletType: WalletType = "UNKNOWN";
  let confidence: WalletIdentityReport["confidence"] = "LOW";
  let status: WalletIdentityReport["status"] = "IDENTITY_UNKNOWN";

  // `/deployed` proves that code exists for a requested deployment path. It does
  // not expose a bytecode fingerprint and must not be used alone to classify the
  // same address as SAFE or Deposit Wallet.
  if (proxyWallet === address && implementationAddress && LEGACY_PROXY_IMPLEMENTATIONS.has(implementationAddress)) {
    walletType = "PROXY_WALLET";
    confidence = "HIGH";
    status = "IDENTITY_CONFIRMED";
  } else if (proxyWallet === address && input.contractCode === "0x") {
    walletType = "EOA";
    confidence = "MEDIUM";
    status = "IDENTITY_CONFIRMED";
  }

  if (proxyWallet && proxyWallet !== address && input.contractCode && input.contractCode !== "0x") {
    walletType = "UNKNOWN";
    confidence = "LOW";
    status = "IDENTITY_CONFLICT";
  }

  if (status === "IDENTITY_CONFIRMED" && input.trades.length === 0) status = "INACTIVE";

  const timestamps = input.trades.map((trade) => trade.timestamp).filter(Number.isFinite);
  const profileCreatedAt = input.profile.createdAt ? new Date(input.profile.createdAt) : null;
  const earliestTrade = timestamps.length > 0 ? new Date(Math.min(...timestamps) * 1_000) : null;
  const latestTrade = timestamps.length > 0 ? new Date(Math.max(...timestamps) * 1_000) : null;
  const firstSeen = profileCreatedAt && !Number.isNaN(profileCreatedAt.valueOf()) ? profileCreatedAt : earliestTrade;

  return {
    walletAddress: address,
    walletType,
    proxyWallet,
    chain: "polygon:137",
    firstSeenTime: firstSeen?.toISOString() ?? null,
    firstSeenSource: profileCreatedAt ? "GAMMA_PROFILE_CREATED_AT" : earliestTrade ? "EARLIEST_AVAILABLE_TRADE" : null,
    lastActivityTime: latestTrade?.toISOString() ?? null,
    tradeCount: input.trades.length,
    tradeCountScope: input.tradeHistoryComplete ? "COMPLETE_AVAILABLE_HISTORY" : "TRUNCATED_BY_DATA_API_OFFSET_LIMIT",
    positionCount: input.positions.length,
    positionSnapshotTime: (input.observedAt ?? new Date()).toISOString(),
    status,
    confidence,
    implementationAddress,
    evidence,
  };
}
