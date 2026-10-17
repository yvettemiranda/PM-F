import { encodeFunctionData, parseAbi, zeroAddress } from "viem";
import type { PolygonChainReader } from "./polygon-chain-reader.js";

const SAFE_ABI = parseAbi(["function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns(bool success)"]);
export type ExecutableWalletType = "EOA" | "POLY_GNOSIS_SAFE" | "POLY_PROXY" | "POLY_1271";
export async function walletTransactionRoute(input: {
  signatureType: ExecutableWalletType;
  tradingWallet: string;
  signerAddress: string;
  target: `0x${string}`;
  data: `0x${string}`;
  chain: PolygonChainReader;
}): Promise<{ to: string; data: string }> {
  const wallet = input.tradingWallet.toLowerCase();
  const signer = input.signerAddress.toLowerCase();
  if (input.signatureType === "EOA" && wallet === signer) return { to: input.target, data: input.data };
  if (input.signatureType !== "POLY_GNOSIS_SAFE") throw new Error("LIVE_WALLET_ONCHAIN_EXECUTOR_UNSUPPORTED");
  const safe = await input.chain.safeOwners(wallet);
  if (safe.threshold !== 1n || safe.owners.length !== 1 || safe.owners[0]?.toLowerCase() !== signer) {
    throw new Error("LIVE_SAFE_SINGLE_OWNER_REQUIRED");
  }
  // Safe's prevalidated signature is valid only when the owner EOA is the
  // actual transaction sender. No private key or reusable signature is stored.
  const prevalidated = `0x${signer.slice(2).padStart(64, "0")}${"0".repeat(64)}01` as `0x${string}`;
  return {
    to: wallet,
    data: encodeFunctionData({ abi: SAFE_ABI, functionName: "execTransaction", args: [
      input.target, 0n, input.data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, prevalidated,
    ] }),
  };
}
