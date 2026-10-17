import { Chain, getContractConfig } from "@polymarket/clob-client-v2";

export type PolymarketProtocol = "CTF" | "CTF_NEG_RISK" | "POLY_V2";
export interface PolymarketMarketRoute {
  protocol: PolymarketProtocol;
  assetId: string;
  conditionId: string;
  domainVersion: "2" | "3";
  exchange: `0x${string}`;
  collateral: `0x${string}`;
  outcomeToken: `0x${string}`;
  redemptionTarget: `0x${string}`;
  /** Binary indexSet, used to redeem this asset without touching its opposite. */
  indexSet?: "1" | "2";
}

export const POLYMARKET_POSITION_MANAGER = "0x006F54F7f9A22e0000CC2AB60031000000ae9fEF" as const;
export const POLYMARKET_ROUTER = "0x12121212006e4CD160D18e3f00711DA5c3372600" as const;
const CTF_ADAPTER = "0xAdA100Db00Ca00073811820692005400218FcE1f" as const;
const NEG_RISK_CTF_ADAPTER = "0xadA2005600Dec949baf300f4C6120000bDB6eAab" as const;

export function marketRoute(input: {
  assetId: string;
  conditionId: string;
  version?: unknown;
  neg_risk?: unknown;
  indexSet?: "1" | "2";
}): PolymarketMarketRoute {
  if (!/^[0-9]+$/.test(input.assetId) || input.assetId.length > 78 || BigInt(input.assetId) >= 2n ** 256n) {
    throw new Error("LIVE_MARKET_ASSET_INVALID");
  }
  if (!/^0x[0-9a-f]{62}(?:[0-9a-f]{2})?$/i.test(input.conditionId)) throw new Error("LIVE_MARKET_CONDITION_INVALID");
  if (input.version !== undefined && input.version !== "v2") throw new Error("LIVE_MARKET_PROTOCOL_UNSUPPORTED");
  if (input.version === undefined && typeof input.neg_risk !== "boolean") throw new Error("LIVE_MARKET_NEG_RISK_UNAVAILABLE");
  const contracts = getContractConfig(Chain.POLYGON);
  const v2 = input.version === "v2";
  if ((v2 ? input.conditionId.length !== 64 : input.conditionId.length !== 66)) throw new Error("LIVE_MARKET_CONDITION_PROTOCOL_MISMATCH");
  if (v2 && ((BigInt(input.assetId) >> 8n) !== BigInt(input.conditionId) || (BigInt(input.assetId) & 255n) > 1n)) {
    throw new Error("LIVE_MARKET_V2_ASSET_CONDITION_MISMATCH");
  }
  return {
    protocol: v2 ? "POLY_V2" : input.neg_risk ? "CTF_NEG_RISK" : "CTF",
    assetId: input.assetId,
    conditionId: input.conditionId.toLowerCase(),
    domainVersion: v2 ? "3" : "2",
    exchange: (v2 ? contracts.exchangeV3 : input.neg_risk ? contracts.negRiskExchangeV2 : contracts.exchangeV2) as `0x${string}`,
    collateral: contracts.collateral as `0x${string}`,
    outcomeToken: v2 ? POLYMARKET_POSITION_MANAGER : contracts.conditionalTokens as `0x${string}`,
    redemptionTarget: v2 ? POLYMARKET_ROUTER : input.neg_risk ? NEG_RISK_CTF_ADAPTER : CTF_ADAPTER,
    ...(input.indexSet === undefined ? {} : { indexSet: input.indexSet }),
  };
}

export interface MarketRouteProvider {
  resolve(assetId: string, conditionId?: string): Promise<PolymarketMarketRoute>;
}

/** Validate persisted or caller supplied routing against the supported chain contracts. */
export function validateMarketRoute(route: PolymarketMarketRoute, assetId: string, conditionId?: string): PolymarketMarketRoute {
  if (route.assetId !== assetId || (conditionId !== undefined && route.conditionId.toLowerCase() !== conditionId.toLowerCase())) {
    throw new Error("LIVE_MARKET_ROUTE_IDENTITY_MISMATCH");
  }
  const canonical = marketRoute({ assetId, conditionId: route.conditionId,
    ...(route.protocol === "POLY_V2" ? { version: "v2" } : { neg_risk: route.protocol === "CTF_NEG_RISK" }),
    ...(route.indexSet === undefined ? {} : { indexSet: route.indexSet }),
  });
  for (const key of ["protocol", "domainVersion", "exchange", "collateral", "outcomeToken", "redemptionTarget"] as const) {
    if (canonical[key].toLowerCase() !== route[key].toLowerCase()) throw new Error("LIVE_MARKET_ROUTE_CONTRACT_MISMATCH");
  }
  return canonical;
}

/** Public reads only; no signer or authenticated CLOB client is involved. */
export class PublicMarketRouteProvider implements MarketRouteProvider {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async resolve(assetId: string, expectedCondition?: string): Promise<PolymarketMarketRoute> {
    const response = await this.fetchImpl(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(assetId)}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if ([404, 410].includes(response.status) && expectedCondition !== undefined) {
      // Resolved markets commonly lose their orderbook. Recover legacy lots
      // from identity-checked market metadata; never invent the neg-risk flag.
      const metadata = await this.fetchImpl(`https://clob.polymarket.com/markets/${encodeURIComponent(expectedCondition)}`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!metadata.ok) throw new Error(`LIVE_MARKET_ROUTE_METADATA_HTTP_${metadata.status}`);
      const market = await metadata.json() as Record<string, unknown>;
      if (typeof market.condition_id !== "string" || market.condition_id.toLowerCase() !== expectedCondition.toLowerCase()
        || !Array.isArray(market.tokens) || !market.tokens.some((token: unknown) => token !== null
          && typeof token === "object" && (token as Record<string, unknown>).token_id === assetId)) {
        throw new Error("LIVE_MARKET_ROUTE_IDENTITY_MISMATCH");
      }
      return marketRoute({ assetId, conditionId: market.condition_id, version: market.version, neg_risk: market.neg_risk });
    }
    if (!response.ok) throw new Error(`LIVE_MARKET_ROUTE_HTTP_${response.status}`);
    const book = await response.json() as Record<string, unknown>;
    if (book.asset_id !== assetId || typeof book.market !== "string"
      || (expectedCondition !== undefined && book.market.toLowerCase() !== expectedCondition.toLowerCase())) {
      throw new Error("LIVE_MARKET_ROUTE_IDENTITY_MISMATCH");
    }
    return marketRoute({ assetId, conditionId: book.market, version: book.version, neg_risk: book.neg_risk });
  }
}
