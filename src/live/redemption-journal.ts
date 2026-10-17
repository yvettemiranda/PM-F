import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { stableJson } from "../domain/versioning.js";

export interface RedemptionJournalRow {
  idempotency_key: string;
  state: "PREPARED" | "SUBMITTING" | "SUBMITTED" | "CONFIRMED" | "FAILED";
  transaction_hash: string | null;
  intent_json: string;
  intent_sha256: string;
  evidence_json: string | null;
}

/** Durable ownership of the browser send boundary. A missing returned hash
 * after SUBMITTING is an unknown outcome, never permission to send again. */
export class RedemptionJournal {
  private readonly database: DatabaseSync;
  constructor(path: string, private readonly now: () => Date = () => new Date()) {
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
  }
  get(key: string): RedemptionJournalRow | null {
    const row = this.database.prepare("SELECT * FROM live_redemption_journal WHERE idempotency_key=?")
      .get(key) as unknown as RedemptionJournalRow | undefined ?? null;
    if (row && createHash("sha256").update(row.intent_json).digest("hex") !== row.intent_sha256) {
      throw new Error("LIVE_REDEEM_JOURNAL_INTENT_HASH_MISMATCH");
    }
    return row;
  }
  prepare(key: string, wallet: string, asset: string, intent: unknown): RedemptionJournalRow {
    const json = stableJson(intent);
    const digest = createHash("sha256").update(json).digest("hex");
    const timestamp = this.now().toISOString();
    this.database.prepare(`INSERT OR IGNORE INTO live_redemption_journal(
      idempotency_key,wallet_address,asset_id,intent_json,intent_sha256,state,created_at,updated_at
    ) VALUES (?,?,?,?,?,'PREPARED',?,?)`).run(key, wallet.toLowerCase(), asset, json, digest, timestamp, timestamp);
    const row = this.get(key)!;
    if (row.intent_json !== json) throw new Error("LIVE_REDEEM_INTENT_CONFLICT");
    return row;
  }
  claim(key: string): boolean {
    return this.database.prepare("UPDATE live_redemption_journal SET state='SUBMITTING',updated_at=? WHERE idempotency_key=? AND state='PREPARED'")
      .run(this.now().toISOString(), key).changes === 1;
  }
  submitted(key: string, hash: string): void {
    if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error("LIVE_REDEEM_TRANSACTION_HASH_INVALID");
    const changed = this.database.prepare("UPDATE live_redemption_journal SET state='SUBMITTED',transaction_hash=?,updated_at=? WHERE idempotency_key=? AND state='SUBMITTING' AND transaction_hash IS NULL")
      .run(hash.toLowerCase(), this.now().toISOString(), key).changes;
    if (changed !== 1) throw new Error("LIVE_REDEEM_JOURNAL_SUBMIT_CONFLICT");
  }
  confirmed(key: string, evidence: unknown): void {
    const changed = this.database.prepare("UPDATE live_redemption_journal SET state='CONFIRMED',evidence_json=?,updated_at=? WHERE idempotency_key=? AND state='SUBMITTED'")
      .run(stableJson(evidence), this.now().toISOString(), key).changes;
    if (changed !== 1) throw new Error("LIVE_REDEEM_JOURNAL_CONFIRM_CONFLICT");
  }
  failed(key: string, reason: string): void {
    this.database.prepare("UPDATE live_redemption_journal SET state='FAILED',evidence_json=?,updated_at=? WHERE idempotency_key=? AND state='SUBMITTED'")
      .run(stableJson({ reason }), this.now().toISOString(), key);
  }
  close(): void { this.database.close(); }
}
