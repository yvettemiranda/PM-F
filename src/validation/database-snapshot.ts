import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { Phase0Database } from "../infra/sqlite/database.js";
import type { SourceVersion } from "../infra/source-version.js";

export interface ValidationDatabaseSnapshot {
  sourceDatabasePath: string;
  workingDatabasePath: string;
  inputSnapshotHash: string;
  dbSnapshotHash: string;
  usedSnapshot: boolean;
}

export async function hashFile(path: string): Promise<string> {
  if (!existsSync(path)) return createHash("sha256").update("MISSING").digest("hex");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function prepareValidationDatabaseSnapshot(input: {
  sourceDatabasePath: string;
  outputDirectory: string;
  sessionId: string;
  useSnapshot: boolean;
  sourceVersion: SourceVersion;
}): Promise<ValidationDatabaseSnapshot> {
  if (!input.useSnapshot) throw new Error("VALIDATION_DATABASE_SNAPSHOT_REQUIRED");
  const sourceDatabasePath = resolve(input.sourceDatabasePath);
  if (!existsSync(sourceDatabasePath)) throw new Error(`SOURCE_DATABASE_NOT_FOUND:${sourceDatabasePath}`);
  const sessionDirectory = resolve(input.outputDirectory, input.sessionId);
  mkdirSync(sessionDirectory, { recursive: true });
  const workingDatabasePath = join(sessionDirectory, basename(sourceDatabasePath) || "validation.sqlite");

  const sourceDatabase = new DatabaseSync(sourceDatabasePath, { readOnly: true });
  sourceDatabase.exec("PRAGMA busy_timeout=5000;");
  try {
    await backup(sourceDatabase, workingDatabasePath);
  } finally {
    sourceDatabase.close();
  }

  const inputSnapshotHash = await hashFile(workingDatabasePath);

  const migrations = new Phase0Database(workingDatabasePath, input.sourceVersion);
  migrations.initialize();
  migrations.close();

  return {
    sourceDatabasePath,
    workingDatabasePath,
    inputSnapshotHash,
    dbSnapshotHash: await hashFile(workingDatabasePath),
    usedSnapshot: true,
  };
}
