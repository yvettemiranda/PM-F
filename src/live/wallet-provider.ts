import type {
  WalletAllowance,
  WalletBalance,
  WalletOutcomePositions,
  WalletStatus,
} from "./live-types.js";

export interface WalletProvider {
  readonly providerType: "DISABLED" | "FAKE" | "LIVE_READONLY";
  getAddress(): Promise<string>;
  /** Total externally visible collateral before this process's local reservations. */
  getBalance(): Promise<WalletBalance>;
  getAllowance(): Promise<WalletAllowance>;
  getOutcomeBalance(assetId: string): Promise<WalletBalance>;
  getOutcomeAllowance(assetId: string): Promise<WalletAllowance>;
  /** Complete externally visible CTF balance projection for reconciliation. */
  getOutcomePositions(): Promise<WalletOutcomePositions>;
  getStatus(): Promise<WalletStatus>;
}
