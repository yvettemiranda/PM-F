import { SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { resolve } from "node:path";
import {
  BrowserWalletClobSigner,
  type PolymarketWalletSignatureType,
} from "../live/browser-wallet-clob-signer.js";
import {
  BrowserWalletAllowanceManager,
  BrowserWalletRedeemAdapter,
  PolygonTransactionReceiptProvider,
} from "../live/browser-wallet-onchain.js";
import { ClobClockSafetyProvider } from "../live/clob-clock-safety-provider.js";
import { assembleConnectedLiveRuntime } from "../live/live-connected-runtime.js";
import { OfficialGeoblockProvider } from "../live/official-geoblock-provider.js";
import { PolymarketClobAdapter } from "../live/polymarket-clob-adapter.js";
import {
  PolymarketReadonlyBalanceProvider,
  PolymarketReadonlyWalletProvider,
} from "../live/polymarket-readonly-wallet-provider.js";
import { PublicClobLiveMarketDataProvider } from "../live/live-market-data.js";
import { SessionAuthenticatedClobClient } from "../live/session-authenticated-clob-client.js";
import { RedemptionJournal } from "../live/redemption-journal.js";
import { PublicMarketRouteProvider } from "../live/market-protocol.js";
import { RpcPolygonChainReader } from "../live/polygon-chain-reader.js";
import {
  ConfiguredOperatorLiveGateActions,
  ConfiguredOperatorLiveRuntimeActions,
  type OperatorLiveGateActions,
  type OperatorLiveRuntimeActions,
} from "./operator-actions.js";
import { OPERATOR_DATABASE_FILE } from "./operator-mutation-guard.js";
import { LiveOperatorComplianceProvider } from "./live-operator-compliance-provider.js";
import { readLiveProductionConfig } from "./live-production-readiness.js";
import type { LiveWalletRequestBroker } from "./live-wallet-request-broker.js";
import type {
  LiveWalletRuntimeBinding,
  LiveWalletSession,
} from "./live-wallet-session.js";
import { ensureProductionLiveAccount } from "./production-live-account.js";
import {
  ProductionLivePrerequisiteManager,
  validatedLiveProductionSourceVersion,
} from "./production-live-prerequisites.js";

export const PRODUCTION_LIVE_EXTERNAL_TIMEOUT_MS = 30_000;

function signatureType(value: string): PolymarketWalletSignatureType {
  if (value === "EOA") return SignatureTypeV2.EOA;
  if (value === "POLY_PROXY") return SignatureTypeV2.POLY_PROXY;
  if (value === "POLY_GNOSIS_SAFE") return SignatureTypeV2.POLY_GNOSIS_SAFE;
  if (value === "POLY_1271") return SignatureTypeV2.POLY_1271;
  throw new Error("LIVE_PRODUCTION_SIGNATURE_TYPE_INVALID");
}

export interface DefaultConnectedLiveRuntimeResult {
  runtimeActions: OperatorLiveRuntimeActions;
  gateActions: OperatorLiveGateActions;
  dispose(): void;
}

/**
 * Default production composition used by the localhost operator server after
 * a formal Polygon wallet session is established.
 *
 * Construction performs only database preparation and read-only network
 * verification. CLOB API credentials remain lazy and in memory; no order can
 * be submitted until the existing Live Gate is separately armed and confirmed.
 */
export async function assembleDefaultConnectedLiveRuntime(input: {
  projectRoot: string;
  walletSession: LiveWalletSession;
  walletSessionBinding: LiveWalletRuntimeBinding;
  walletRequestBroker: LiveWalletRequestBroker;
  now?: () => Date;
}): Promise<DefaultConnectedLiveRuntimeResult> {
  input.walletSessionBinding.assertCurrent();
  const config = readLiveProductionConfig(input.projectRoot);
  if (
    config.walletAddress !== input.walletSession.walletAddress
    || config.network !== "POLYGON"
    || input.walletSession.chainId !== 137
    || config.tradingWalletAddress === null
  ) {
    throw new Error("LIVE_PRODUCTION_CONNECTED_CONFIGURATION_MISMATCH");
  }
  if (config.signatureType === "POLY_PROXY" || config.signatureType === "POLY_1271") {
    throw new Error("LIVE_WALLET_COMPLETE_RUNTIME_UNSUPPORTED:EOA_OR_SINGLE_OWNER_SAFE_REQUIRED");
  }
  const now = input.now ?? (() => new Date());
  const sourceVersion = validatedLiveProductionSourceVersion(input.projectRoot);
  const databasePath = resolve(input.projectRoot, OPERATOR_DATABASE_FILE);
  const account = await ensureProductionLiveAccount({
    projectRoot: input.projectRoot,
    databasePath,
    config,
    sourceVersion,
    now,
  });
  const walletSignatureType = signatureType(config.signatureType);
  const routeProvider = new PublicMarketRouteProvider();
  const chainReader = new RpcPolygonChainReader();
  if (config.signatureType === "POLY_GNOSIS_SAFE") {
    const safe = await chainReader.safeOwners(config.tradingWalletAddress);
    if (safe.threshold !== 1n || safe.owners.length !== 1 || safe.owners[0]?.toLowerCase() !== input.walletSession.walletAddress.toLowerCase()) {
      throw new Error("LIVE_SAFE_SINGLE_OWNER_REQUIRED");
    }
    input.walletSessionBinding.assertCurrent();
  }
  const signer = new BrowserWalletClobSigner({
    walletBinding: input.walletSessionBinding,
    requestBroker: input.walletRequestBroker,
    signatureType: walletSignatureType,
    funderAddress: config.tradingWalletAddress,
    routeProvider,
  });
  const clobClient = new SessionAuthenticatedClobClient({
    walletBinding: input.walletSessionBinding,
    signer: signer.clobSigner,
    signatureType: walletSignatureType,
    funderAddress: config.tradingWalletAddress,
  });
  const walletProvider = new PolymarketReadonlyWalletProvider({
    walletBinding: input.walletSessionBinding,
    funderAddress: config.tradingWalletAddress,
    clobClient,
    routeProvider,
  });
  const balanceProvider = new PolymarketReadonlyBalanceProvider(walletProvider);
  const geoblockProvider = new OfficialGeoblockProvider({ now });
  const prerequisiteManager = new ProductionLivePrerequisiteManager({
    projectRoot: input.projectRoot,
    databasePath,
    sourceVersion,
    geoblockProvider,
    walletAddress: config.tradingWalletAddress,
    now,
  });
  prerequisiteManager.refreshStaticEvidence();
  const receiptProvider = new PolygonTransactionReceiptProvider();
  const walletSetup = new BrowserWalletAllowanceManager({
    walletBinding: input.walletSessionBinding,
    requestBroker: input.walletRequestBroker,
    receiptProvider,
    clobClient,
    bankrollMicros: config.liveBankrollMicros,
    signatureType: config.signatureType,
    tradingWalletAddress: config.tradingWalletAddress,
    chainReader,
  });
  const redemptionJournal = new RedemptionJournal(databasePath, now);
  const redeemAdapter = new BrowserWalletRedeemAdapter({
    walletBinding: input.walletSessionBinding,
    requestBroker: input.walletRequestBroker,
    receiptProvider,
    signatureType: config.signatureType,
    tradingWalletAddress: config.tradingWalletAddress,
    chainReader,
    routeProvider,
    journal: redemptionJournal,
  });
  const assembly = await assembleConnectedLiveRuntime({
    databasePath,
    walletBinding: input.walletSessionBinding,
    sourceVersion,
    now,
    dependencyFactory: {
      async create() {
        const verifiedChainId = await walletProvider.getChainId();
        return {
          verifiedChainId,
          balanceProvider,
          gateConfig: {
            bankrollMicros: config.liveBankrollMicros,
            maxTradeSizeMicros: config.maxTradeSizeMicros,
            maxExposureMicros: config.maxExposureMicros,
            maxDailyLossMicros: config.maxDailyLossMicros,
          },
          geoblockProvider,
          complianceProvider: new LiveOperatorComplianceProvider(input.projectRoot, now),
          clockProvider: new ClobClockSafetyProvider(),
          orderAdapter: new PolymarketClobAdapter(clobClient),
          walletProvider,
          signer,
          redeemAdapter,
          marketDataProvider: new PublicClobLiveMarketDataProvider(),
          requireExternalPositionReconciliation: true,
          externalCallTimeoutMs: PRODUCTION_LIVE_EXTERNAL_TIMEOUT_MS,
        };
      },
    },
  }).catch((error: unknown) => {
    redemptionJournal.close();
    clobClient.invalidate();
    throw error;
  });
  const production = {
    FORMAL_WALLET: true,
    SECURE_SIGNER: true,
    READONLY_BALANCE: true,
    AUTHENTICATED_CLOB: true,
    COMPLIANCE: true,
    GEOBLOCK: true,
    CLOCK_SAFETY: true,
  } as const;
  return {
    runtimeActions: new ConfiguredOperatorLiveRuntimeActions({
      runtime: assembly.runtime,
      executor: assembly.executor,
      accountId: account.accountId,
      production,
      walletSessionBinding: input.walletSessionBinding,
      walletSetup,
      manageWalletInvalidation: false,
    }),
    gateActions: new ConfiguredOperatorLiveGateActions(
      input.projectRoot,
      assembly.gate,
      prerequisiteManager,
    ),
    dispose: () => {
      clobClient.invalidate();
      redemptionJournal.close();
      assembly.close();
    },
  };
}
