import { SignatureTypeV2, type SignedOrder } from "@polymarket/clob-client-v2";
import type { PolymarketMarketRoute } from "./market-protocol.js";

/** The pinned SDK exports an exact-amount V3 helper but no equivalent V2
 * helper. Reuse its own V2 builder, including its ERC-7739 wrapping, without
 * converting ledger integers through the float-based createOrder API. */
export async function buildExactCtfOrder(input: {
  route: PolymarketMarketRoute;
  signer: unknown;
  makerAddress: string;
  signerAddress: string;
  signatureType: SignatureTypeV2;
  makerAmount: string;
  takerAmount: string;
  side: "BUY" | "SELL";
}): Promise<SignedOrder> {
  if (input.route.domainVersion !== "2") throw new Error("CLOB_EXACT_V2_ROUTE_REQUIRED");
  const moduleUrl = new URL("order-utils/exchangeOrderBuilderV2.js", import.meta.resolve("@polymarket/clob-client-v2"));
  const sdk = await import(moduleUrl.href) as {
    ExchangeOrderBuilderV2: new (contract: string, chainId: number, signer: unknown) => {
      buildSignedOrder(order: Record<string, unknown>): Promise<SignedOrder>;
    };
  };
  return new sdk.ExchangeOrderBuilderV2(input.route.exchange, 137, input.signer).buildSignedOrder({
    maker: input.makerAddress,
    signer: input.signatureType === SignatureTypeV2.POLY_1271 ? input.makerAddress : input.signerAddress,
    tokenId: input.route.assetId,
    makerAmount: input.makerAmount,
    takerAmount: input.takerAmount,
    side: input.side,
    signatureType: input.signatureType,
    expiration: "0",
  });
}
