import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { VERSIONS } from "../../domain/versioning.js";
import type { SourceVersion } from "../source-version.js";
import { Phase0Database } from "./database.js";

export interface RuntimeDatabasePreparationResult {
  databasePath: string;
  migrated: boolean;
  backupPath: string | null;
  schemaVersion: string;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function safetyState(database: DatabaseSync, allowMissing = false): void {
  const table = database.prepare(
    "SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='live_gate_state'",
  ).get();
  if (!table) {
    if (allowMissing) return;
    throw new Error("RUNTIME_DATABASE_SAFETY_STATE_TABLE_MISSING");
  }
  const row = database.prepare(
    "SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'",
  ).get() as { execution_mode: string; live_gate_state: string } | undefined;
  if (!row || row.execution_mode !== "PAPER" || row.live_gate_state !== "LIVE_DISABLED") {
    throw new Error(`RUNTIME_DATABASE_UNSAFE_MODE:${row?.execution_mode ?? "MISSING"}:${row?.live_gate_state ?? "MISSING"}`);
  }
}

function verifyDatabase(path: string, allowMissingSafetyState = false): void {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const integrity = database.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new Error("RUNTIME_DATABASE_INTEGRITY_CHECK_FAILED");
    }
    const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length > 0) throw new Error("RUNTIME_DATABASE_FOREIGN_KEY_CHECK_FAILED");
    safetyState(database, allowMissingSafetyState);
  } finally {
    database.close();
  }
}

function pruneBackups(directory: string, retain: number, databasePrefix: string): void {
  const backups = readdirSync(directory)
    .filter((name) => name.startsWith(databasePrefix) && name.endsWith(".sqlite"))
    .sort()
    .reverse();
  for (const stale of backups.slice(retain)) rmSync(join(directory, stale), { force: true });
}

/** Backup-first initialization used by operator-facing Observe/Paper CLIs. */
export async function prepareRuntimeDatabase(input: {
  databasePath: string;
  sourceVersion: SourceVersion;
  backupDirectory?: string;
  retainBackups?: number;
}): Promise<RuntimeDatabasePreparationResult> {
  const retainBackups = input.retainBackups ?? 3;
  if (!Number.isSafeInteger(retainBackups) || retainBackups < 1) {
    throw new Error(`INVALID_RUNTIME_BACKUP_RETENTION:${retainBackups}`);
  }
  const databasePath = resolve(input.databasePath);
  mkdirSync(dirname(databasePath), { recursive: true });
  const existed = existsSync(databasePath);
  let migrationRequired = existed;
  if (existed) {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      database.exec("PRAGMA busy_timeout=5000;");
      safetyState(database, true);
      try {
        migrationRequired = database.prepare(
          "SELECT 1 ok FROM schema_migrations WHERE version=?",
        ).get(VERSIONS.schemaVersion) === undefined;
      } catch {
        migrationRequired = true;
      }
      if (!migrationRequired) safetyState(database);
    } finally {
      database.close();
    }
  }

  let backupPath: string | null = null;
  if (existed && migrationRequired) {
    const backupDirectory = resolve(
      input.backupDirectory ?? join(dirname(dirname(databasePath)), "operator", "backups"),
    );
    mkdirSync(backupDirectory, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = join(backupDirectory, `${basename(databasePath, ".sqlite")}-before-${VERSIONS.schemaVersion}-${timestamp}.sqlite`);
    const source = new DatabaseSync(databasePath, { readOnly: true });
    source.exec("PRAGMA busy_timeout=5000;");
    try {
      await backup(source, backupPath);
    } finally {
      source.close();
    }
    verifyDatabase(backupPath, true);
    await sha256(backupPath); // force a complete readable-file pass before migration
    pruneBackups(backupDirectory, retainBackups, `${basename(databasePath, ".sqlite")}-before-`);
  }

  const migrations = new Phase0Database(databasePath, input.sourceVersion);
  try {
    migrations.initialize();
  } finally {
    migrations.close();
  }
  verifyDatabase(databasePath);
  return {
    databasePath,
    migrated: migrationRequired,
    backupPath,
    schemaVersion: VERSIONS.schemaVersion,
  };
}
