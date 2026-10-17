import type {
  LiveOrderSide,
  WalletAllowance,
  WalletBalance,
  WalletOutcomePositions,
  WalletStatus,
} from "./live-types.js";

export interface WalletProvider {
  readonly providerType: "DISABLED" | "FAKE" | "LIVE_READONLY";
  /**
   * Production wallet providers must expose the chain read from their
   * provider transport so connected-runtime assembly can verify it
   * independently of the browser request and host factory metadata.
   */
  getChainId?(): Promise<number>;
  getAddress(): Promise<string>;
  /** Total externally visible collateral before this process's local reservations. */
  getBalance(): Promise<WalletBalance>;
  getAllowance(): Promise<WalletAllowance>;
  /** Fresh balance and matching spender allowance from one response. */
  getCapacity?(input: { assetId: string; side: LiveOrderSide }): Promise<{
    balance: WalletBalance;
    allowance: WalletAllowance;
  }>;
  getOutcomeBalance(assetId: string): Promise<WalletBalance>;
  getOutcomeAllowance(assetId: string): Promise<WalletAllowance>;
  /** Complete externally visible CTF balance projection for reconciliation. */
  getOutcomePositions(): Promise<WalletOutcomePositions>;
  getStatus(): Promise<WalletStatus>;
}
