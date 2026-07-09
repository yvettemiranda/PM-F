import type { SignedPayload } from "./live-types.js";

export interface Signer {
  readonly signerType: "DISABLED" | "FAKE" | "LIVE";
  address(): Promise<string>;
  signOrder(payload: Record<string, unknown>): Promise<SignedPayload>;
}
