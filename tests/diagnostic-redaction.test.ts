import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDiagnosticBundleManifest, redactDiagnosticLog, redactDiagnosticValue } from "../src/operator/diagnostic-redaction.js";

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
      schemaVersion: "2.21.0",
      rulesetHash: "rules",
      configVersion: "1.2.0",
      generatedAt: "2026-07-16T00:00:00.000Z",
    });
    expect(manifest.files).toEqual([{ name: "report.json", bytes: 3, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
  });
});
