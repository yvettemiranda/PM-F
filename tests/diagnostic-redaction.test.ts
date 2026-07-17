import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDiagnosticBundleManifest,
  diagnosticLocalPathLeakCount,
  diagnosticSourceProvenanceFromReports,
  redactDiagnosticLog,
  redactDiagnosticValue,
} from "../src/operator/diagnostic-redaction.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("diagnostic redaction", () => {
  it("keeps public report identifiers and aliases internal Observe identifiers", () => {
    const redacted = redactDiagnosticValue({
      campaign_id: "PC-20260716-01",
      session_id: "PS-001",
      report_id: "PR-001",
      paperAccountId: "account-secret",
      observeRunId: "c5b7cdec-465a-4b3e-9c17-0ff4cce1327f",
      checkpointId: "2c76ea42-c32e-4fc4-a1d2-7a5c0822806a",
      repeated: "c5b7cdec-465a-4b3e-9c17-0ff4cce1327f",
      path: "/Users/test/project/data/file.json",
    }, { projectRoot: "/Users/test/project", homeDirectory: "/Users/test" }) as Record<string, string>;
    expect(redacted).toMatchObject({
      campaign_id: "PC-20260716-01",
      session_id: "PS-001",
      report_id: "PR-001",
      paperAccountId: "[REDACTED_PAPER_ACCOUNT_ID]",
      path: "[PROJECT_ROOT]/data/file.json",
    });
    expect(redacted.observeRunId).toMatch(/^internal_id_[a-f0-9]{16}$/);
    expect(redacted.checkpointId).toMatch(/^internal_id_[a-f0-9]{16}$/);
    expect(redacted.observeRunId).not.toBe(redacted.checkpointId);
    expect(redacted.repeated).toBe(redacted.observeRunId);
  });

  it("redacts UUID and local paths in logs", () => {
    expect(redactDiagnosticLog(
      "/Users/test/project c5b7cdec-465a-4b3e-9c17-0ff4cce1327f",
      { projectRoot: "/Users/test/project", homeDirectory: "/Users/test" },
    )).toMatch(/^\[PROJECT_ROOT\] internal_id_[a-f0-9]{16}$/);
  });

  it("redacts Vitest macOS and POSIX paths, including file URLs and object keys", () => {
    const httpsUrl = "https://docs.example.test/Users/public/reference?from=/tmp/example";
    const redacted = redactDiagnosticValue({
      failureMessage: [
        "at /private/var/folders/xy/cache/tests/example.test.ts:10:20",
        "snapshot=/tmp/ni-k-vitest/result.json",
        "module=file:///Users/test/project/tests/example.test.ts:7:3",
      ].join("\n"),
      ["/tmp/ni-k-vitest/failure-key.json"]: "failed",
      documentation: httpsUrl,
    }, { projectRoot: "/Users/test/project", homeDirectory: "/Users/test" }) as Record<string, string>;
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("/private/var/folders");
    expect(serialized).not.toContain("/tmp/ni-k-vitest");
    expect(serialized).not.toContain("file:///Users");
    expect(serialized).toContain("[LOCAL_PATH_");
    expect(Object.keys(redacted).some((key) => /^\[LOCAL_PATH_[a-f0-9]{16}\]$/.test(key))).toBe(true);
    expect(redacted.documentation).toMatch(/^https:\/\/docs\.example\.test\/Users\/public\/reference\?from=\[LOCAL_PATH_[a-f0-9]{16}\]$/);
    expect(diagnosticLocalPathLeakCount(serialized)).toBe(0);
  });

  it("redacts local paths in logs without altering HTTPS URLs", () => {
    const url = "https://example.test/private/var/folders/public/result";
    const redacted = redactDiagnosticLog(
      `failure /private/var/folders/xy/test.ts /tmp/result.json file:///Users/test/code.ts ${url}`,
      { projectRoot: "/Users/test/project", homeDirectory: "/Users/test" },
    );
    expect(redacted).not.toContain("/private/var/folders/xy");
    expect(redacted).not.toContain("/tmp/result.json");
    expect(redacted).not.toContain("file:///Users/test");
    expect(redacted).toContain(url);
    expect(diagnosticLocalPathLeakCount(redacted)).toBe(0);
  });

  it("inspects and redacts local paths in HTTPS query and fragment while preserving the URL", () => {
    const raw = "https://example.test/api/v1?project=/Users/test/project&tmp=%2Ftmp%2Fresult.json#trace=/private/var/folders/xy/test.ts";
    expect(diagnosticLocalPathLeakCount(raw)).toBeGreaterThan(0);
    const redacted = redactDiagnosticLog(raw, {
      projectRoot: "/Users/test/project",
      homeDirectory: "/Users/test",
    });
    expect(redacted).toMatch(/^https:\/\/example\.test\/api\/v1\?project=\[PROJECT_ROOT\]&tmp=\[LOCAL_PATH_[a-f0-9]{16}\]#trace=\[LOCAL_PATH_[a-f0-9]{16}\]$/);
    expect(diagnosticLocalPathLeakCount(redacted)).toBe(0);
    expect(redactDiagnosticLog("https://example.test/private/var/folders/public/result", {
      projectRoot: "/Users/test/project",
      homeDirectory: "/Users/test",
    })).toBe("https://example.test/private/var/folders/public/result");
  });

  it("does not trust UUID values merely because they use public ID field names", () => {
    const uuid = "c5b7cdec-465a-4b3e-9c17-0ff4cce1327f";
    const redacted = redactDiagnosticValue({
      campaignId: uuid,
      session_id: uuid,
      publicReportId: uuid,
      validCampaignId: "not-a-public-key",
      campaign_id: "PC-20260716-01",
      sessionId: "PS-001",
      report_id: "PR-001",
    }, { projectRoot: "/project", homeDirectory: "/Users/test" }) as Record<string, string>;
    expect(redacted).toMatchObject({
      campaign_id: "PC-20260716-01",
      sessionId: "PS-001",
      report_id: "PR-001",
    });
    expect(redacted.campaignId).toMatch(/^internal_id_[a-f0-9]{16}$/);
    expect(redacted.session_id).toBe(redacted.campaignId);
    expect(redacted.publicReportId).toBe(redacted.campaignId);
  });

  it("uses the same collision-resistant alias for one UUID across separate files", () => {
    const uuid = "c5b7cdec-465a-4b3e-9c17-0ff4cce1327f";
    const first = redactDiagnosticValue({ observeRunId: uuid }, {
      projectRoot: "/project",
      homeDirectory: "/Users/test",
    }) as { observeRunId: string };
    const second = redactDiagnosticValue({ checkpointDetail: `run=${uuid}` }, {
      projectRoot: "/project",
      homeDirectory: "/Users/test",
    }) as { checkpointDetail: string };
    expect(second.checkpointDetail).toBe(`run=${first.observeRunId}`);
  });

  it("creates a deterministic file manifest without hashing itself", () => {
    const root = mkdtempSync(join(tmpdir(), "ni-k-bundle-"));
    directories.push(root);
    mkdirSync(join(root, "bundle"));
    writeFileSync(join(root, "bundle", "report.json"), "{}\n");
    const manifest = buildDiagnosticBundleManifest(join(root, "bundle"), {
      campaignId: "PC-1",
      sessionId: "PS-1",
      reportId: "PR-1",
      sourceCommit: "commit",
      sourceCodeDirty: false,
      coreCompatibilityHash: "core",
      schemaVersion: "2.21.0",
      rulesetHash: "rules",
      configVersion: "1.2.0",
      generatedAt: "2026-07-16T00:00:00.000Z",
    });
    expect(manifest).toMatchObject({
      manifestVersion: "1.1.0",
      sourceCommit: null,
      sourceCodeDirty: false,
      coreCompatibilityHash: null,
    });
    expect(manifest.files).toEqual([{ name: "report.json", bytes: 3, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
  });

  it("fails closed before manifest creation when any bundled file still contains a local path", () => {
    const root = mkdtempSync(join(tmpdir(), "ni-k-bundle-leak-"));
    directories.push(root);
    mkdirSync(join(root, "bundle"));
    writeFileSync(join(root, "bundle", "vitest-failure.json"), JSON.stringify({
      failureMessage: "at /private/var/folders/xy/cache/example.test.ts:10:20",
      documentation: "https://example.test/private/var/folders/public/reference",
    }));
    expect(() => buildDiagnosticBundleManifest(join(root, "bundle"), {
      campaignId: null,
      sessionId: null,
      reportId: null,
      sourceCommit: "commit",
      sourceCodeDirty: null,
      coreCompatibilityHash: null,
      schemaVersion: "2.21.0",
      rulesetHash: "rules",
      configVersion: "1.2.0",
      generatedAt: "2026-07-17T00:00:00.000Z",
    })).toThrow("DIAGNOSTIC_BUNDLE_LOCAL_PATH_LEAK:vitest-failure.json");

    writeFileSync(join(root, "bundle", "vitest-failure.json"), JSON.stringify({
      documentation: "https://example.test/private/var/folders/public/reference",
    }));
    expect(() => buildDiagnosticBundleManifest(join(root, "bundle"), {
      campaignId: null,
      sessionId: null,
      reportId: null,
      sourceCommit: "commit",
      sourceCodeDirty: null,
      coreCompatibilityHash: null,
      schemaVersion: "2.21.0",
      rulesetHash: "rules",
      configVersion: "1.2.0",
      generatedAt: "2026-07-17T00:00:00.000Z",
    })).not.toThrow();

    writeFileSync(join(root, "bundle", "vitest-failure.json"), JSON.stringify({
      documentation: "https://example.test/report?path=/tmp/unredacted.json",
    }));
    expect(() => buildDiagnosticBundleManifest(join(root, "bundle"), {
      campaignId: null,
      sessionId: null,
      reportId: null,
      sourceCommit: null,
      sourceCodeDirty: null,
      coreCompatibilityHash: null,
      schemaVersion: "2.21.0",
      rulesetHash: "rules",
      configVersion: "1.2.0",
      generatedAt: "2026-07-17T00:00:00.000Z",
    })).toThrow("DIAGNOSTIC_BUNDLE_LOCAL_PATH_LEAK:vitest-failure.json");
  });

  it("extracts report provenance without inventing clean or accepting conflicts", () => {
    const commit = "a".repeat(40);
    const core = "b".repeat(64);
    expect(diagnosticSourceProvenanceFromReports([{
      sourceCodeCommit: commit,
      coreCompatibilityHash: core,
      session: { sourceVersion: { commit, dirty: false }, coreCompatibilityHash: core },
    }])).toEqual({ sourceCommit: commit, sourceCodeDirty: false, coreCompatibilityHash: core });
    expect(diagnosticSourceProvenanceFromReports([
      { sourceVersion: { commit, dirty: false }, coreCompatibilityHash: core },
      { sourceVersion: { commit: "c".repeat(40), dirty: true }, coreCompatibilityHash: "d".repeat(64) },
    ])).toEqual({ sourceCommit: null, sourceCodeDirty: null, coreCompatibilityHash: null });
    expect(diagnosticSourceProvenanceFromReports([{}])).toEqual({
      sourceCommit: null,
      sourceCodeDirty: null,
      coreCompatibilityHash: null,
    });
  });
});
