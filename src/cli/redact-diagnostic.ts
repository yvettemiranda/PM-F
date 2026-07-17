import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { buildCurrentCoreCompatibilityManifest, computeCoreCompatibilityHash } from "../paper-validation/core-compatibility.js";
import { resolveSourceVersion } from "../infra/source-version.js";
import {
  buildDiagnosticBundleManifest,
  diagnosticSourceProvenanceFromReports,
  redactDiagnosticLog,
  redactDiagnosticValue,
} from "../operator/diagnostic-redaction.js";

const [command, source, destination, projectRoot, homeDirectory, metadataJson] = process.argv.slice(2);
if (!command) throw new Error("REDACT_DIAGNOSTIC_ARGUMENTS_REQUIRED");

if (command === "provenance") {
  if (!source) throw new Error("DIAGNOSTIC_PROVENANCE_PROJECT_ROOT_REQUIRED");
  const reportPaths = process.argv.slice(4).filter((path) => path && existsSync(path));
  if (reportPaths.length > 0) {
    const reports = reportPaths.flatMap((path) => {
      try {
        return [JSON.parse(readFileSync(path, "utf8")) as unknown];
      } catch {
        return [];
      }
    });
    console.log(JSON.stringify(diagnosticSourceProvenanceFromReports(reports)));
  } else {
    const sourceVersion = resolveSourceVersion(source);
    let coreCompatibilityHash: string | null = null;
    try {
      coreCompatibilityHash = computeCoreCompatibilityHash(buildCurrentCoreCompatibilityManifest(source));
    } catch {
      coreCompatibilityHash = null;
    }
    console.log(JSON.stringify(diagnosticSourceProvenanceFromReports([{
      sourceVersion,
      coreCompatibilityHash,
    }])));
  }
} else if (!source || !destination) {
  throw new Error("REDACT_DIAGNOSTIC_ARGUMENTS_REQUIRED");
} else if (command === "json") {
  if (!projectRoot || !homeDirectory) throw new Error("REDACT_DIAGNOSTIC_PATHS_REQUIRED");
  const parsed: unknown = JSON.parse(readFileSync(source, "utf8"));
  const redacted = redactDiagnosticValue(parsed, { projectRoot, homeDirectory });
  writeFileSync(destination, `${JSON.stringify(redacted, null, 2)}\n`, { mode: 0o600 });
} else if (command === "log") {
  if (!projectRoot || !homeDirectory) throw new Error("REDACT_DIAGNOSTIC_PATHS_REQUIRED");
  writeFileSync(
    destination,
    redactDiagnosticLog(readFileSync(source, "utf8"), { projectRoot, homeDirectory }),
    { mode: 0o600 },
  );
} else if (command === "manifest") {
  if (!metadataJson) throw new Error("REDACT_DIAGNOSTIC_METADATA_REQUIRED");
  const metadata = JSON.parse(metadataJson) as Parameters<typeof buildDiagnosticBundleManifest>[1];
  const manifest = buildDiagnosticBundleManifest(source, metadata);
  writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
} else {
  throw new Error(`REDACT_DIAGNOSTIC_COMMAND_UNKNOWN:${command}`);
}
