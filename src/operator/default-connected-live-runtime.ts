import { Chain, SignatureTypeV2, getContractConfig } from "@polymarket/clob-client-v2";
import { resolve } from "node:path";
import { resolveSourceVersion } from "../infra/source-version.js";
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
import { ProductionLivePrerequisiteManager } from "./production-live-prerequisites.js";

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
  const now = input.now ?? (() => new Date());
  const sourceVersion = resolveSourceVersion(input.projectRoot);
  const databasePath = resolve(input.projectRoot, OPERATOR_DATABASE_FILE);
  const account = await ensureProductionLiveAccount({
    projectRoot: input.projectRoot,
    databasePath,
    config,
    sourceVersion,
    now,
  });
  const walletSignatureType = signatureType(config.signatureType);
  const signer = new BrowserWalletClobSigner({
    walletBinding: input.walletSessionBinding,
    requestBroker: input.walletRequestBroker,
    signatureType: walletSignatureType,
    funderAddress: config.tradingWalletAddress,
  });
  const clobClient = new SessionAuthenticatedClobClient({
    walletBinding: input.walletSessionBinding,
    signer: signer.clobSigner,
    signatureType: walletSignatureType,
    funderAddress: config.tradingWalletAddress,
  });
  const exchangeV3 = getContractConfig(Chain.POLYGON).exchangeV3;
  const walletProvider = new PolymarketReadonlyWalletProvider({
    walletBinding: input.walletSessionBinding,
    funderAddress: config.tradingWalletAddress,
    clobClient,
    allowanceSpenders: [exchangeV3],
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
  });
  const redeemAdapter = new BrowserWalletRedeemAdapter({
    walletBinding: input.walletSessionBinding,
    requestBroker: input.walletRequestBroker,
    receiptProvider,
    signatureType: config.signatureType,
    tradingWalletAddress: config.tradingWalletAddress,
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
      assembly.close();
    },
  };
}
