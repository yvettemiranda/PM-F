import type { OperationalStore } from "./operational-store.js";

export class OperationalLock {
  constructor(
    private readonly store: OperationalStore,
    private readonly now: () => Date = () => new Date(),
    private readonly staleAfterMs = 5 * 60 * 1_000,
  ) {}

  acquire(lockKey: string, operationalRunId: string): void {
    const timestamp = this.now().toISOString();
    const existing = this.store.database.prepare(
      "SELECT operational_run_id,heartbeat_at FROM operational_locks WHERE lock_key=?",
    ).get(lockKey) as { operational_run_id: string; heartbeat_at: string } | undefined;
    if (existing) {
      const stale = this.now().valueOf() - Date.parse(existing.heartbeat_at) > this.staleAfterMs;
      if (!stale) throw new Error(`OPERATIONAL_INSTANCE_ACTIVE:${existing.operational_run_id}`);
      this.store.database.prepare("DELETE FROM operational_locks WHERE lock_key=?").run(lockKey);
    }
    this.store.database.prepare(
      `INSERT INTO operational_locks(lock_key,operational_run_id,acquired_at,heartbeat_at)
       VALUES (?, ?, ?, ?)`,
    ).run(lockKey, operationalRunId, timestamp, timestamp);
  }

  heartbeat(lockKey: string, operationalRunId: string): void {
    this.store.database.prepare(
      "UPDATE operational_locks SET heartbeat_at=? WHERE lock_key=? AND operational_run_id=?",
    ).run(this.now().toISOString(), lockKey, operationalRunId);
  }

  release(lockKey: string, operationalRunId: string): void {
    this.store.database.prepare(
      "DELETE FROM operational_locks WHERE lock_key=? AND operational_run_id=?",
    ).run(lockKey, operationalRunId);
  }
}

