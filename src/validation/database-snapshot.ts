import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Phase0Database } from "../infra/sqlite/database.js";
import type { SourceVersion } from "../infra/source-version.js";

export interface ValidationDatabaseSnapshot {
  sourceDatabasePath: string;
  workingDatabasePath: string;
  inputSnapshotHash: string;
  dbSnapshotHash: string;
  usedSnapshot: boolean;
}

export function hashFile(path: string): string {
  if (!existsSync(path)) return createHash("sha256").update("MISSING").digest("hex");
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function prepareValidationDatabaseSnapshot(input: {
  sourceDatabasePath: string;
  outputDirectory: string;
  sessionId: string;
  useSnapshot: boolean;
  sourceVersion: SourceVersion;
}): ValidationDatabaseSnapshot {
  const sourceDatabasePath = resolve(input.sourceDatabasePath);
  const sessionDirectory = resolve(input.outputDirectory, input.sessionId);
  mkdirSync(sessionDirectory, { recursive: true });
  const inputSnapshotHash = hashFile(sourceDatabasePath);
  const workingDatabasePath = input.useSnapshot
    ? join(sessionDirectory, basename(sourceDatabasePath) || "validation.sqlite")
    : sourceDatabasePath;

  if (input.useSnapshot) {
    if (existsSync(sourceDatabasePath)) {
      copyFileSync(sourceDatabasePath, workingDatabasePath);
    }
  }

  const migrations = new Phase0Database(workingDatabasePath, input.sourceVersion);
  migrations.initialize();
  migrations.close();

  return {
    sourceDatabasePath,
    workingDatabasePath,
    inputSnapshotHash,
    dbSnapshotHash: hashFile(workingDatabasePath),
    usedSnapshot: input.useSnapshot,
  };
}
