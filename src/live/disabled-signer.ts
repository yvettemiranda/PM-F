import type { Signer } from "./signer.js";
import type { SignedPayload } from "./live-types.js";

export class DisabledSigner implements Signer {
  readonly signerType = "DISABLED" as const;

  async address(): Promise<string> {
    throw new Error("SIGNER_DISABLED");
  }

  async signOrder(_payload: Record<string, unknown>): Promise<SignedPayload> {
    throw new Error("SIGNER_DISABLED");
  }
}
