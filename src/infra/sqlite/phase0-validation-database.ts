import type { SourceVersion } from "../source-version.js";
import { Phase0Database } from "./database.js";
import {
  prepareRuntimeDatabase,
  type RuntimeDatabasePreparationResult,
} from "./runtime-database-preparation.js";

export interface PreparedPhase0ValidationDatabase {
  database: Phase0Database;
  preparation: RuntimeDatabasePreparationResult;
}

/**
 * Opens the Phase 0 validation database only after the shared runtime path has
 * verified PAPER/LIVE_DISABLED, created a pre-migration backup, applied the
 * schema, and checked integrity/foreign keys.
 */
export async function preparePhase0ValidationDatabase(input: {
  databasePath: string;
  sourceVersion: SourceVersion;
  backupDirectory?: string;
  retainBackups?: number;
}): Promise<PreparedPhase0ValidationDatabase> {
  const preparation = await prepareRuntimeDatabase(input);
  return {
    database: new Phase0Database(preparation.databasePath, input.sourceVersion),
    preparation,
  };
}
