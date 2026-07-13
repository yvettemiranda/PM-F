import {
  existsSync,
  lstatSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

export const DEFAULT_RUN_SNAPSHOT_RETENTION = Object.freeze({
  keepSnapshotCount: 3,
  maxSnapshotBytes: 1_073_741_824,
});

export interface RunSnapshotRetentionResult {
  deletedFiles: string[];
  deletedBytes: number;
  retainedSnapshotCount: number;
  skippedIncompleteCount: number;
}

interface CompletedRunSnapshot {
  directory: string;
  modifiedAtMs: number;
  files: Array<{ path: string; bytes: number }>;
  bytes: number;
}

function isSnapshotFile(name: string): boolean {
  return name.endsWith(".sqlite") || name.endsWith(".sqlite-wal") || name.endsWith(".sqlite-shm");
}

function within(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${sep}`);
}

/**
 * Removes only old SQLite snapshot artifacts from completed direct-child run
 * directories. JSON/Markdown reports are retained, the current run is always
 * retained, symlinks and incomplete runs are never touched.
 */
export function pruneCompletedRunSnapshots(input: {
  outputDirectory: string;
  currentRunId: string;
  currentWorkingDatabasePath: string;
  runPrefix: "validation-" | "operational-";
  reportFileName: "validation-report.json" | "operational-report.json";
  keepSnapshotCount?: number;
  maxSnapshotBytes?: number;
}): RunSnapshotRetentionResult {
  const root = resolve(input.outputDirectory);
  const currentDirectory = resolve(root, input.currentRunId);
  if (dirname(currentDirectory) !== root || !basename(currentDirectory).startsWith(input.runPrefix)) {
    throw new Error("RUN_RETENTION_CURRENT_DIRECTORY_INVALID");
  }
  const currentDatabase = resolve(input.currentWorkingDatabasePath);
  if (!within(currentDirectory, currentDatabase)) throw new Error("RUN_RETENTION_CURRENT_DATABASE_OUTSIDE_RUN");
  const keepSnapshotCount = Math.max(1, input.keepSnapshotCount ?? DEFAULT_RUN_SNAPSHOT_RETENTION.keepSnapshotCount);
  const maxSnapshotBytes = Math.max(0, input.maxSnapshotBytes ?? DEFAULT_RUN_SNAPSHOT_RETENTION.maxSnapshotBytes);
  const currentBytes = existsSync(currentDatabase) ? statSync(currentDatabase).size : 0;
  const candidates: CompletedRunSnapshot[] = [];
  let skippedIncompleteCount = 0;

  if (existsSync(root)) {
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith(input.runPrefix) || entry === input.currentRunId) continue;
      const directory = resolve(root, entry);
      if (dirname(directory) !== root) continue;
      const directoryStat = lstatSync(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) continue;
      const reportPath = join(directory, input.reportFileName);
      if (!existsSync(reportPath) || !lstatSync(reportPath).isFile()) {
        skippedIncompleteCount += 1;
        continue;
      }
      const files = readdirSync(directory).flatMap((name) => {
        if (!isSnapshotFile(name)) return [];
        const path = resolve(directory, name);
        if (dirname(path) !== directory) return [];
        const fileStat = lstatSync(path);
        return fileStat.isFile() && !fileStat.isSymbolicLink()
          ? [{ path, bytes: fileStat.size }]
          : [];
      });
      candidates.push({
        directory,
        modifiedAtMs: statSync(reportPath).mtimeMs,
        files,
        bytes: files.reduce((total, file) => total + file.bytes, 0),
      });
    }
  }

  candidates.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs || right.directory.localeCompare(left.directory));
  let retainedSnapshotCount = 1;
  let retainedBytes = currentBytes;
  let deletedBytes = 0;
  const deletedFiles: string[] = [];
  for (const candidate of candidates) {
    const canRetainByCount = retainedSnapshotCount < keepSnapshotCount;
    const canRetainBySize = retainedBytes + candidate.bytes <= maxSnapshotBytes;
    if (canRetainByCount && canRetainBySize) {
      retainedSnapshotCount += 1;
      retainedBytes += candidate.bytes;
      continue;
    }
    for (const file of candidate.files) {
      unlinkSync(file.path);
      deletedFiles.push(file.path);
      deletedBytes += file.bytes;
    }
  }
  return { deletedFiles, deletedBytes, retainedSnapshotCount, skippedIncompleteCount };
}
