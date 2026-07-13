import {
  PublicExecutionMarketDataProvider,
} from "../execution/market-data.js";
import type { PaperMarketDataProvider } from "./types.js";

/** Public, unauthenticated CLOB data used by the Paper execution model. */
export class PublicPaperMarketDataProvider
  extends PublicExecutionMarketDataProvider
  implements PaperMarketDataProvider {}
