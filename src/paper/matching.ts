import { decimalToScaled, PRICE_SCALE_DIGITS, SHARE_SCALE_DIGITS } from "../domain/fixed.js";
import { RULESET } from "../domain/versioning.js";
import type { MatchedLevel, OrderbookLevel, PaperMatchResult } from "./types.js";

const PRICE_SCALE = 10n ** BigInt(PRICE_SCALE_DIGITS);
const PPM = 1_000_000n;

function notionalMicros(sizeMicros: bigint, priceUnits: bigint): bigint {
  return (sizeMicros * priceUnits) / PRICE_SCALE;
}

function buyNotionalMicros(sizeMicros: bigint, priceUnits: bigint): bigint {
  return (sizeMicros * priceUnits + PRICE_SCALE - 1n) / PRICE_SCALE;
}

function rawFeeMicros(sizeMicros: bigint, priceUnits: bigint, feeRatePpm: bigint, exponent: number): bigint {
  if (feeRatePpm === 0n) return 0n;
  const curve = priceUnits * (PRICE_SCALE - priceUnits);
  return (sizeMicros * feeRatePpm * curve ** BigInt(exponent))
    / (PPM * PRICE_SCALE ** BigInt(2 * exponent));
}

function roundedFee(levels: Array<{ size: bigint; price: bigint }>, feeRatePpm: bigint, exponent: number): bigint {
  const raw = levels.reduce((sum, level) => sum + rawFeeMicros(level.size, level.price, feeRatePpm, exponent), 0n);
  if (raw === 0n) return 0n;
  const unit = BigInt(RULESET.paperFeeRoundingMicros);
  return ((raw + unit / 2n) / unit) * unit;
}

function parsed(levels: OrderbookLevel[], descending: boolean): Array<{ price: bigint; size: bigint }> {
  return levels
    .map((level) => ({
      price: decimalToScaled(level.price, PRICE_SCALE_DIGITS),
      size: decimalToScaled(level.size, SHARE_SCALE_DIGITS),
    }))
    .filter((level) => level.price > 0n && level.price < PRICE_SCALE && level.size > 0n)
    .sort((a, b) => {
      if (a.price === b.price) return 0;
      return descending ? (a.price > b.price ? -1 : 1) : (a.price < b.price ? -1 : 1);
    });
}

function result(levels: Array<{ price: bigint; size: bigint }>, feeRatePpm: bigint, exponent: number, complete: boolean): PaperMatchResult {
  const size = levels.reduce((sum, level) => sum + level.size, 0n);
  const notional = levels.reduce((sum, level) => sum + notionalMicros(level.size, level.price), 0n);
  const fee = roundedFee(levels, feeRatePpm, exponent);
  const outputLevels: MatchedLevel[] = levels.map((level) => ({
    priceUnits: level.price.toString(),
    sizeMicros: level.size.toString(),
    notionalMicros: notionalMicros(level.size, level.price).toString(),
  }));
  return {
    levels: outputLevels,
    filledSizeMicros: size.toString(),
    filledNotionalMicros: notional.toString(),
    feeMicros: fee.toString(),
    vwapPriceUnits: size > 0n ? ((notional * PRICE_SCALE) / size).toString() : null,
    complete,
  };
}

export function matchPaperBuy(input: {
  asks: OrderbookLevel[];
  reservationMicros: bigint;
  lowerPriceUnits: bigint;
  upperPriceUnits: bigint;
  feeRatePpm: bigint;
  feeExponent: number;
}): PaperMatchResult {
  const asks = parsed(input.asks, false);
  const best = asks[0];
  if (!best || best.price < input.lowerPriceUnits || best.price > input.upperPriceUnits) {
    return result([], input.feeRatePpm, input.feeExponent, false);
  }
  const fills: Array<{ price: bigint; size: bigint }> = [];
  for (const level of asks) {
    if (level.price > input.upperPriceUnits) break;
    let low = 0n;
    let high = level.size;
    while (low < high) {
      const middle = (low + high + 1n) / 2n;
      const candidate = [...fills, { price: level.price, size: middle }];
      const total = candidate.reduce((sum, fill) => sum + buyNotionalMicros(fill.size, fill.price), 0n)
        + roundedFee(candidate, input.feeRatePpm, input.feeExponent);
      if (total <= input.reservationMicros) low = middle;
      else high = middle - 1n;
    }
    if (low > 0n) fills.push({ price: level.price, size: low });
    const spent = fills.reduce((sum, fill) => sum + buyNotionalMicros(fill.size, fill.price), 0n)
      + roundedFee(fills, input.feeRatePpm, input.feeExponent);
    if (spent >= input.reservationMicros || low < level.size) break;
  }
  const matched = result(fills, input.feeRatePpm, input.feeExponent, false);
  const consumed = BigInt(matched.filledNotionalMicros) + BigInt(matched.feeMicros);
  return { ...matched, complete: consumed >= input.reservationMicros - 1n };
}

export function matchPaperSell(input: {
  bids: OrderbookLevel[];
  requestedSizeMicros: bigint;
  minimumPriceUnits: bigint;
  feeRatePpm: bigint;
  feeExponent: number;
}): PaperMatchResult {
  let remaining = input.requestedSizeMicros;
  const fills: Array<{ price: bigint; size: bigint }> = [];
  for (const level of parsed(input.bids, true)) {
    if (level.price < input.minimumPriceUnits || remaining === 0n) break;
    const size = level.size < remaining ? level.size : remaining;
    fills.push({ price: level.price, size });
    remaining -= size;
  }
  return result(fills, input.feeRatePpm, input.feeExponent, remaining === 0n);
}

export function executableSellVwap(bids: OrderbookLevel[], requestedSizeMicros: bigint): bigint | null {
  const matched = matchPaperSell({ bids, requestedSizeMicros, minimumPriceUnits: 0n, feeRatePpm: 0n, feeExponent: 1 });
  return matched.complete && matched.vwapPriceUnits !== null ? BigInt(matched.vwapPriceUnits) : null;
}
