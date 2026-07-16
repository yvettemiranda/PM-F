import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSourceVersion } from "../infra/source-version.js";
import {
  buildCurrentCoreCompatibilityManifest,
  computeCoreCompatibilityHash,
} from "../paper-validation/core-compatibility.js";
import {
  assertReplayValidationEvidenceArtifactAgainstDatabase,
  buildReplayValidationEvidenceArtifact,
  type ReplayValidationEvidenceArtifact,
  type ReplayValidationEvidenceSource,
} from "../paper-validation/replay-evidence.js";
import type { PaperValidationScenario } from "../paper-validation/types.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argumentsList = process.argv.slice(2);
const command = argumentsList[0] ?? "verify";
const valueArg = (name: string): string | undefined => argumentsList
  .find((argument) => argument.startsWith(`--${name}=`))
  ?.slice(name.length + 3);

function required(name: string): string {
  const value = valueArg(name)?.trim();
  if (!value) throw new Error(`PAPER_REPLAY_EVIDENCE_ARGUMENT_MISSING:${name}`);
  return value;
}

async function writeAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

const sourceVersion = resolveSourceVersion(projectRoot);
if (sourceVersion.dirty) throw new Error("PAPER_REPLAY_EVIDENCE_REQUIRES_CLEAN_SOURCE");
const coreCompatibilityHash = computeCoreCompatibilityHash(
  buildCurrentCoreCompatibilityManifest(projectRoot),
);

if (command === "import") {
  const source = required("source") as ReplayValidationEvidenceSource;
  if (source !== "REAL_SIGNAL_REPLAY" && source !== "REAL_EXECUTION_REPLAY") {
    throw new Error(`PAPER_REPLAY_EVIDENCE_SOURCE_INVALID:${source}`);
  }
  const coverage = required("coverage").split(",").map((item) => item.trim()) as PaperValidationScenario[];
  const artifact = buildReplayValidationEvidenceArtifact({
    databasePath: resolve(required("database")),
    source,
    coverage,
    coreCompatibilityHash,
    sourceCodeCommit: sourceVersion.commit,
    sourceEventKey: required("source-event-key"),
    replayRunId: required("replay-run-id"),
    ...(valueArg("paper-execution-id") ? { paperExecutionId: valueArg("paper-execution-id")! } : {}),
    ...(valueArg("paper-order-id") ? { paperOrderId: valueArg("paper-order-id")! } : {}),
    ...(valueArg("unrealized-pnl-snapshot-id")
      ? { unrealizedPnlSnapshotId: valueArg("unrealized-pnl-snapshot-id")! }
      : {}),
  });
  const output = resolve(
    valueArg("file")
      ?? `data/operator/paper-campaign-replay-evidence/${artifact.artifactHash}.json`,
  );
  await writeAtomically(output, artifact);
  console.log(JSON.stringify({ status: "PASSED", output, artifactHash: artifact.artifactHash }));
} else if (command === "verify") {
  const path = resolve(required("file"));
  const artifact = JSON.parse(await readFile(path, "utf8")) as ReplayValidationEvidenceArtifact;
  assertReplayValidationEvidenceArtifactAgainstDatabase(
    artifact,
    resolve(required("database")),
    coreCompatibilityHash,
    artifact.sourceCodeCommit,
  );
  console.log(JSON.stringify({ status: "PASSED", path, artifactHash: artifact.artifactHash }));
} else {
  throw new Error(`UNKNOWN_PAPER_REPLAY_EVIDENCE_COMMAND:${command}`);
}
