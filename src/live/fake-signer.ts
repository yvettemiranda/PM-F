import { createHash } from "node:crypto";
import { stableJson } from "../domain/versioning.js";
import type { Signer } from "./signer.js";
import type { SignedPayload } from "./live-types.js";

export class FakeSigner implements Signer {
  readonly signerType = "FAKE" as const;

  constructor(private readonly signerAddress = "0x0000000000000000000000000000000000000001") {}

  async address(): Promise<string> {
    return this.signerAddress;
  }

  async signOrder(payload: Record<string, unknown>): Promise<SignedPayload> {
    const payloadHash = createHash("sha256").update(stableJson(payload)).digest("hex");
    return {
      signerAddress: this.signerAddress,
      signature: `fake-signature-${payloadHash}`,
      payloadHash,
    };
  }
}
