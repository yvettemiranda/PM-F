import { createHash } from "node:crypto";
import {
  Chain,
  ClobClient,
  Side,
  SignatureTypeV2,
  type ClobClientOptions,
  type SignedOrder,
} from "@polymarket/clob-client-v2";
import { stableJson } from "../domain/versioning.js";
import { conservativeClobBuyFeeMicros } from "../execution/clob-fee.js";
import type { LiveWalletRequestBroker } from "../operator/live-wallet-request-broker.js";
import type { LiveWalletRuntimeBinding } from "../operator/live-wallet-session.js";
import type { Signer } from "./signer.js";
import type { SignedPayload } from "./live-types.js";
import { buildExactCtfOrder } from "./clob-exact-order-builder.js";
import { PublicMarketRouteProvider, validateMarketRoute, type PolymarketMarketRoute, type MarketRouteProvider } from "./market-protocol.js";

type ClobSigner = NonNullable<ClobClientOptions["signer"]>;

export type PolymarketWalletSignatureType =
  | SignatureTypeV2.EOA
  | SignatureTypeV2.POLY_PROXY
  | SignatureTypeV2.POLY_GNOSIS_SAFE
  | SignatureTypeV2.POLY_1271;

export interface BrowserWalletClobSignerOptions {
  walletBinding: LiveWalletRuntimeBinding;
  requestBroker: LiveWalletRequestBroker;
  signatureType?: PolymarketWalletSignatureType;
  funderAddress?: string;
  clobHost?: string;
  orderClient?: Pick<ClobClient, "createExchangeV3OrderFromAmounts">;
  routeProvider?: MarketRouteProvider;
}

interface TypedDataInput {
  account?: unknown;
  domain: Record<string, unknown>;
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const INTEGER_RE = /^(?:0|[1-9][0-9]*)$/;
const PRICE_SCALE = 1_000_000_000_000_000_000n;

function address(value: string, code: string): string {
  const normalized = value.trim().toLowerCase();
  if (!ADDRESS_RE.test(normalized)) throw new Error(code);
  return normalized;
}

function positiveInteger(value: unknown, code: string): bigint {
  const text = String(value);
  if (!INTEGER_RE.test(text) || BigInt(text) <= 0n) throw new Error(code);
  return BigInt(text);
}

function nonNegativeInteger(value: unknown, code: string): bigint {
  const text = String(value);
  if (!INTEGER_RE.test(text)) throw new Error(code);
  return BigInt(text);
}

function side(value: unknown): "BUY" | "SELL" {
  if (value === "BUY" || value === "SELL") return value;
  throw new Error("LIVE_SIGNER_SIDE_INVALID");
}

function purpose(primaryType: string): string {
  if (primaryType === "ClobAuth") return "创建或恢复本次钱包会话的 CLOB 凭据";
  if (primaryType === "TypedDataSign") return "签署 Polymarket Deposit Wallet 订单";
  return "签署 Polymarket 小额 Live 订单";
}

/**
 * Non-custodial Live signer backed by the browser's EIP-1193 wallet.
 *
 * The SDK builds the exact EIP-712 payload in the backend. The broker sends
 * that payload to the connected browser wallet and returns only its signature.
 * No private key, seed, or reusable wallet signature enters Node or disk.
 */
export class BrowserWalletClobSigner implements Signer {
  readonly signerType = "LIVE" as const;
  readonly signatureType: PolymarketWalletSignatureType;
  readonly funderAddress: string;
  readonly clobSigner: ClobSigner;

  private readonly orderClient: Pick<ClobClient, "createExchangeV3OrderFromAmounts">;
  private readonly routeProvider: MarketRouteProvider;

  constructor(private readonly options: BrowserWalletClobSignerOptions) {
    options.walletBinding.assertCurrent();
    if (options.walletBinding.session.chainId !== Chain.POLYGON) {
      throw new Error("LIVE_SIGNER_POLYGON_MAINNET_REQUIRED");
    }
    const signerAddress = address(
      options.walletBinding.session.walletAddress,
      "LIVE_SIGNER_ADDRESS_INVALID",
    );
    this.signatureType = options.signatureType ?? SignatureTypeV2.EOA;
    this.funderAddress = address(
      options.funderAddress ?? signerAddress,
      "LIVE_SIGNER_FUNDER_ADDRESS_INVALID",
    );
    if (this.signatureType === SignatureTypeV2.EOA && this.funderAddress !== signerAddress) {
      throw new Error("LIVE_SIGNER_EOA_FUNDER_MISMATCH");
    }
    this.clobSigner = {
      account: { address: signerAddress },
      signTypedData: (input: TypedDataInput): Promise<string> => {
        options.walletBinding.assertCurrent();
        return options.requestBroker.requestTypedData(options.walletBinding, {
          domain: input.domain,
          types: input.types,
          primaryType: input.primaryType,
          message: input.message,
          purpose: purpose(input.primaryType),
        });
      },
    } as unknown as ClobSigner;
    this.orderClient = options.orderClient ?? new ClobClient({
      host: options.clobHost ?? "https://clob.polymarket.com",
      chain: Chain.POLYGON,
      signer: this.clobSigner,
      signatureType: this.signatureType,
      funderAddress: this.funderAddress,
      useServerTime: true,
      throwOnError: true,
    });
    this.routeProvider = options.routeProvider ?? new PublicMarketRouteProvider();
  }

  async address(): Promise<string> {
    this.options.walletBinding.assertCurrent();
    return this.options.walletBinding.session.walletAddress;
  }

  async signOrder(payload: Record<string, unknown>): Promise<SignedPayload> {
    this.options.walletBinding.assertCurrent();
    const orderSide = side(payload.side);
    const assetId = String(payload.assetId ?? "").trim();
    if (!/^[0-9]+$/.test(assetId)) throw new Error("LIVE_SIGNER_ASSET_ID_INVALID");
    let amountMicros = positiveInteger(payload.amountMicros, "LIVE_SIGNER_AMOUNT_INVALID");
    let sizeMicros = positiveInteger(payload.sizeMicros, "LIVE_SIGNER_SIZE_INVALID");
    const budgetMicros = positiveInteger(payload.budgetMicros, "LIVE_SIGNER_BUDGET_INVALID");
    const priceUnits = positiveInteger(payload.priceUnits, "LIVE_SIGNER_PRICE_INVALID");
    const feeRateBps = nonNegativeInteger(payload.feeRateBps, "LIVE_SIGNER_FEE_RATE_INVALID");
    const feeExponent = Number(payload.feeExponent);
    const feeModelVersion = String(payload.feeModelVersion ?? "").trim();
    if (priceUnits >= PRICE_SCALE) throw new Error("LIVE_SIGNER_PRICE_INVALID");
    if (!Number.isSafeInteger(feeExponent) || feeExponent < (feeRateBps === 0n ? 0 : 1) || feeExponent > 4) {
      throw new Error("LIVE_SIGNER_FEE_EXPONENT_INVALID");
    }
    if (!feeModelVersion) throw new Error("LIVE_SIGNER_FEE_MODEL_VERSION_REQUIRED");
    const makerAddress = address(String(payload.makerAddress ?? ""), "LIVE_SIGNER_MAKER_ADDRESS_INVALID");
    const authorizedSigner = address(
      String(payload.signerAddress ?? ""),
      "LIVE_SIGNER_AUTHORIZED_ADDRESS_INVALID",
    );
    if (makerAddress !== this.funderAddress) throw new Error("LIVE_SIGNER_MAKER_ADDRESS_MISMATCH");
    if (authorizedSigner !== await this.address()) throw new Error("LIVE_SIGNER_AUTHORIZED_ADDRESS_MISMATCH");
    const derivedAmount = (priceUnits * sizeMicros + PRICE_SCALE - 1n) / PRICE_SCALE;
    if (orderSide === "BUY" && amountMicros !== derivedAmount) {
      throw new Error("LIVE_SIGNER_BUY_AMOUNT_PRICE_MISMATCH");
    }
    if (orderSide === "SELL" && amountMicros > sizeMicros) {
      throw new Error("LIVE_SIGNER_SELL_AMOUNT_INVALID");
    }
    const totalCost = (size: bigint): bigint => {
      const notional = (priceUnits * size + PRICE_SCALE - 1n) / PRICE_SCALE;
      return notional + conservativeClobBuyFeeMicros({
        amountMicros: notional, sizeMicros: size, upperPriceUnits: priceUnits, feeRateBps, feeExponent,
      });
    };
    if (orderSide === "BUY" && totalCost(sizeMicros) > budgetMicros) {
      // Preserve the approved cash budget and original price, never enlarge it
      // to cover fees. Monotone integer search also preserves exact raw amounts.
      let low = 0n;
      let high = sizeMicros;
      while (low < high) {
        const middle = (low + high + 1n) / 2n;
        if (totalCost(middle) <= budgetMicros) low = middle;
        else high = middle - 1n;
      }
      // Two-decimal shares are accepted at every supported SDK tick. Keeping
      // that quantum makes maker/taker encode the original price exactly.
      sizeMicros = (low / 10_000n) * 10_000n;
      if (sizeMicros === 0n) throw new Error("LIVE_SIGNER_TOTAL_COST_EXCEEDS_BUDGET");
      amountMicros = (priceUnits * sizeMicros + PRICE_SCALE - 1n) / PRICE_SCALE;
    }
    const maxTotalCostMicros = orderSide === "BUY" ? totalCost(sizeMicros) : amountMicros;
    if (maxTotalCostMicros > budgetMicros && orderSide === "BUY") {
      throw new Error("LIVE_SIGNER_TOTAL_COST_EXCEEDS_BUDGET");
    }
    const conditionId = typeof payload.conditionId === "string" ? payload.conditionId : undefined;
    const marketRoute = validateMarketRoute(payload.marketRoute === undefined
      ? await this.routeProvider.resolve(assetId, conditionId)
      : payload.marketRoute as PolymarketMarketRoute, assetId, conditionId);
    this.options.walletBinding.assertCurrent();
    const makerAmount = (orderSide === "BUY" ? amountMicros : sizeMicros).toString();
    const takerAmount = (orderSide === "BUY" ? sizeMicros : amountMicros).toString();
    const signedOrder = marketRoute.domainVersion === "3"
      ? await this.orderClient.createExchangeV3OrderFromAmounts({
        tokenID: assetId, makerAmount, takerAmount, side: orderSide === "BUY" ? Side.BUY : Side.SELL,
      })
      : await buildExactCtfOrder({
        route: marketRoute, signer: this.clobSigner, makerAddress, signerAddress: authorizedSigner,
        signatureType: this.signatureType, makerAmount, takerAmount, side: orderSide,
      });
    this.options.walletBinding.assertCurrent();
    this.validateSignedOrder(signedOrder, {
      side: orderSide,
      assetId,
      makerAddress,
      authorizedSigner,
      amountMicros,
      sizeMicros,
    });
    return {
      signerAddress: authorizedSigner,
      signature: signedOrder.signature,
      payloadHash: createHash("sha256").update(stableJson({ signedOrder, marketRoute })).digest("hex"),
      marketRoute,
      signedOrder,
      orderAmountMicros: amountMicros.toString(),
      orderSizeMicros: sizeMicros.toString(),
      maxTotalCostMicros: maxTotalCostMicros.toString(),
      feeModelVersion,
    };
  }

  private validateSignedOrder(
    signedOrder: SignedOrder,
    expected: {
      side: "BUY" | "SELL";
      assetId: string;
      makerAddress: string;
      authorizedSigner: string;
      amountMicros: bigint;
      sizeMicros: bigint;
    },
  ): void {
    if (signedOrder.tokenId !== expected.assetId) throw new Error("LIVE_SIGNER_SDK_ASSET_MISMATCH");
    if (signedOrder.side !== expected.side) throw new Error("LIVE_SIGNER_SDK_SIDE_MISMATCH");
    if (signedOrder.maker.toLowerCase() !== expected.makerAddress) {
      throw new Error("LIVE_SIGNER_SDK_MAKER_MISMATCH");
    }
    const expectedOrderSigner = this.signatureType === SignatureTypeV2.POLY_1271
      ? expected.makerAddress
      : expected.authorizedSigner;
    if (signedOrder.signer.toLowerCase() !== expectedOrderSigner) {
      throw new Error("LIVE_SIGNER_SDK_SIGNER_MISMATCH");
    }
    if (signedOrder.signatureType !== this.signatureType) {
      throw new Error("LIVE_SIGNER_SDK_SIGNATURE_TYPE_MISMATCH");
    }
    const expectedMakerAmount = expected.side === "BUY" ? expected.amountMicros : expected.sizeMicros;
    const expectedTakerAmount = expected.side === "BUY" ? expected.sizeMicros : expected.amountMicros;
    if (
      BigInt(signedOrder.makerAmount) !== expectedMakerAmount
      || BigInt(signedOrder.takerAmount) !== expectedTakerAmount
    ) {
      throw new Error("LIVE_SIGNER_SDK_AMOUNT_MISMATCH");
    }
    if (!/^0x[0-9a-fA-F]+$/.test(signedOrder.signature)) {
      throw new Error("LIVE_SIGNER_SDK_SIGNATURE_INVALID");
    }
  }
}
