import { existsSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { pruneCompletedRunSnapshots } from "../src/infra/run-snapshot-retention.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("run snapshot retention", () => {
  it("keeps reports/current run and deletes only old completed SQLite snapshots", () => {
    const root = mkdtempSync(join(tmpdir(), "ni-k-retention-"));
    directories.push(root);
    const runs = ["validation-current", "validation-new", "validation-old", "validation-oldest"];
    runs.forEach((run, index) => {
      const directory = join(root, run);
      mkdirSync(directory);
      writeFileSync(join(directory, "validation-report.json"), "{}\n");
      writeFileSync(join(directory, "phase0.sqlite"), Buffer.alloc(10, index));
      const time = new Date(1_000_000 + index * 1_000);
      utimesSync(join(directory, "validation-report.json"), time, time);
    });
    const incomplete = join(root, "validation-incomplete");
    mkdirSync(incomplete);
    writeFileSync(join(incomplete, "phase0.sqlite"), Buffer.alloc(10));
    const external = mkdtempSync(join(tmpdir(), "ni-k-retention-external-"));
    directories.push(external);
    writeFileSync(join(external, "phase0.sqlite"), Buffer.alloc(10));
    symlinkSync(external, join(root, "validation-symlink"));

    const result = pruneCompletedRunSnapshots({
      outputDirectory: root,
      currentRunId: "validation-current",
      currentWorkingDatabasePath: join(root, "validation-current", "phase0.sqlite"),
      runPrefix: "validation-",
      reportFileName: "validation-report.json",
      keepSnapshotCount: 2,
      maxSnapshotBytes: 25,
    });

    expect(existsSync(join(root, "validation-current", "phase0.sqlite"))).toBe(true);
    expect(existsSync(join(root, "validation-oldest", "phase0.sqlite"))).toBe(true);
    expect(existsSync(join(root, "validation-new", "phase0.sqlite"))).toBe(false);
    expect(existsSync(join(root, "validation-old", "phase0.sqlite"))).toBe(false);
    expect(existsSync(join(root, "validation-new", "validation-report.json"))).toBe(true);
    expect(existsSync(join(incomplete, "phase0.sqlite"))).toBe(true);
    expect(existsSync(join(external, "phase0.sqlite"))).toBe(true);
    expect(result.deletedFiles).toHaveLength(2);
    expect(result.deletedBytes).toBe(20);
    expect(result.retainedSnapshotCount).toBe(2);
    expect(result.skippedIncompleteCount).toBe(1);
  });

  it("rejects a current database outside its direct run directory", () => {
    const root = mkdtempSync(join(tmpdir(), "ni-k-retention-invalid-"));
    directories.push(root);
    expect(() => pruneCompletedRunSnapshots({
      outputDirectory: root,
      currentRunId: "validation-current",
      currentWorkingDatabasePath: join(root, "outside.sqlite"),
      runPrefix: "validation-",
      reportFileName: "validation-report.json",
    })).toThrow("RUN_RETENTION_CURRENT_DATABASE_OUTSIDE_RUN");
  });
});
