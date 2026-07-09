import type { WalletAllowance, WalletBalance, WalletStatus } from "./live-types.js";

export interface WalletProvider {
  readonly providerType: "DISABLED" | "FAKE" | "LIVE_READONLY";
  getAddress(): Promise<string>;
  getBalance(): Promise<WalletBalance>;
  getAllowance(): Promise<WalletAllowance>;
  getStatus(): Promise<WalletStatus>;
}
