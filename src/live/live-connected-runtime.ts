import type { SourceVersion } from "../infra/source-version.js";
import type { LiveWalletRuntimeBinding } from "../operator/live-wallet-session.js";
import {
  assembleLiveRuntime,
  type LiveRuntimeAssembly,
  type LiveRuntimeAssemblyInput,
} from "./live-runtime-assembly.js";

export type ConnectedLiveRuntimeDependencies = Omit<
  LiveRuntimeAssemblyInput,
  "databasePath" | "sourceVersion" | "now" | "environment"
>;
export type ConnectedLiveRuntimeDependencyBundle = ConnectedLiveRuntimeDependencies & {
  /**
   * Chain ID read from the production wallet/provider transport, not copied
   * from the browser request body.
   */
  verifiedChainId: number;
};

export interface ConnectedLiveRuntimeDependencyFactory {
  create(input: {
    databasePath: string;
    walletSession: LiveWalletRuntimeBinding["session"];
    sourceVersion?: SourceVersion;
    now: () => Date;
  }): Promise<ConnectedLiveRuntimeDependencyBundle>;
}

export interface ConnectedLiveRuntimeAssemblyInput {
  databasePath: string;
  walletBinding: LiveWalletRuntimeBinding;
  sourceVersion?: SourceVersion;
  now?: () => Date;
  dependencyFactory: ConnectedLiveRuntimeDependencyFactory;
}

/**
 * The single production composition seam after a formal wallet is connected.
 *
 * The host supplies adapters built around the connected wallet session
 * (secure signer, read-only balance, authenticated CLOB, policy providers and
 * market data). This function performs the connected signer identity check and
 * assembles the existing Live graph. The wallet provider may represent a
 * Polymarket proxy/funder address and is checked later by LiveIdentityBinding.
 * This function never discovers credentials or enables the Gate.
 */
export async function assembleConnectedLiveRuntime(
  input: ConnectedLiveRuntimeAssemblyInput,
): Promise<LiveRuntimeAssembly> {
  input.walletBinding.assertCurrent();
  const walletSession = input.walletBinding.session;
  if (walletSession.network !== "POLYGON" || walletSession.chainId !== 137) {
    throw new Error("LIVE_PRODUCTION_NETWORK_REQUIRED");
  }
  const now = input.now ?? (() => new Date());
  const bundle = await input.dependencyFactory.create({
    databasePath: input.databasePath,
    walletSession,
    ...(input.sourceVersion === undefined ? {} : { sourceVersion: input.sourceVersion }),
    now,
  });
  input.walletBinding.assertCurrent();
  if (bundle.verifiedChainId !== 137) throw new Error("LIVE_PRODUCTION_CHAIN_VERIFICATION_FAILED");
  const dependencies = bundle;
  if (typeof dependencies.walletProvider.getChainId !== "function") {
    throw new Error("LIVE_PRODUCTION_CHAIN_VERIFIER_NOT_CONFIGURED");
  }
  const providerChainId = await dependencies.walletProvider.getChainId();
  input.walletBinding.assertCurrent();
  if (providerChainId !== 137 || providerChainId !== bundle.verifiedChainId) {
    throw new Error("LIVE_PRODUCTION_CHAIN_VERIFICATION_FAILED");
  }
  const assembly = assembleLiveRuntime({
    ...dependencies,
    databasePath: input.databasePath,
    environment: "PRODUCTION",
    ...(input.sourceVersion === undefined ? {} : { sourceVersion: input.sourceVersion }),
    now,
  });
  try {
    const signerAddress = await dependencies.signer.address();
    input.walletBinding.assertCurrent();
    const expectedAddress = walletSession.walletAddress.toLowerCase();
    if (signerAddress.toLowerCase() !== expectedAddress) {
      throw new Error("LIVE_CONNECTED_WALLET_IDENTITY_MISMATCH");
    }
    return assembly;
  } catch (error) {
    assembly.close();
    throw error;
  }
}
