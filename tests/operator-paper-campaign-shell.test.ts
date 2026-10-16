import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCurrentCoreCompatibilityManifest,
  computeCoreCompatibilityHash,
  computeVerificationSuiteHash,
} from "../src/paper-validation/core-compatibility.js";
import {
  buildIsolatedVerificationEvidence,
  PAPER_CAMPAIGN_ISOLATED_TEST_FILES,
} from "../src/paper-validation/operator-evidence.js";
import { resolveSourceVersion } from "../src/infra/source-version.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targetWallet = "0x1f9e15f39bbd5d163b0eacf0fbef647ced9e4f1a";
const temporaryDirectories: string[] = [];
// Shell provenance must use the runtime that computed the expected core hash,
// even when the runner also has another Node installed by Homebrew or Codex.
const shellEnvironment = {
  ...process.env,
  PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
};
const bundleCommandTimeoutMs = 30_000;
const bundleTestTimeoutMs = bundleCommandTimeoutMs + 5_000;
const twoBundleCommandsTimeoutMs = 2 * bundleCommandTimeoutMs + 5_000;

function copyActiveRulesetProfile(directory: string): void {
  const source = process.env.NI_K_RULESET_PROFILE_FILE;
  if (!source || !existsSync(source)) return;
  const destination = join(directory, "data/operator/ruleset-profile.json");
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function sleepingProcess(roleScript: string, campaignId: string, sessionId: string, ownerToken?: string) {
  return spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM',()=>process.exit(0));process.on('SIGUSR1',()=>process.exit(0));setInterval(()=>{},1000)",
    resolve(projectRoot, roleScript),
    `--campaign-id=${campaignId}`,
    `--session-id=${sessionId}`,
    ...(ownerToken ? [`--operator-owner-token=${ownerToken}`] : []),
  ], { cwd: projectRoot, stdio: "ignore" });
}

function isolatedEvidence(sourceCodeCommit: string, coreCompatibilityHash: string) {
  return buildIsolatedVerificationEvidence({
    status: "PASSED",
    targetWallet,
    coreCompatibilityHash,
    verificationSuiteHash: computeVerificationSuiteHash(projectRoot),
    sourceCodeCommit,
    generatedAt: "2026-07-17T00:00:00.000Z",
    coverage: [],
    testFiles: [...PAPER_CAMPAIGN_ISOLATED_TEST_FILES],
    replayStatus: "PASSED",
    proofs: {
      vitestResultSha256: "1".repeat(64),
      phase0ResultSha256: "2".repeat(64),
      replayResultSha256: "3".repeat(64),
      captureRunId: "4".repeat(64),
      replayHash: "5".repeat(64),
      targetWallet,
      phase0ReplayStatus: "PASSED",
      acceptedIncompleteReasons: [],
      passedTestFileCount: PAPER_CAMPAIGN_ISOLATED_TEST_FILES.length,
      passedTestCount: PAPER_CAMPAIGN_ISOLATED_TEST_FILES.length,
    },
    safety: {
      executionMode: "PAPER",
      liveGateState: "LIVE_DISABLED",
      privateKeyLoaded: false,
      authenticatedTradingClientPresent: false,
      realOrdersCreated: 0,
      chainWrites: 0,
    },
  });
}

function campaignBundleFixture(input: {
  evidenceSourceCommit: string;
  evidenceCoreCompatibilityHash: string;
  attempts?: number;
}) {
  const directory = mkdtempSync(join(tmpdir(), "ni-k-operator-proof-bundle-"));
  temporaryDirectories.push(directory);
  symlinkSync(resolve(projectRoot, "src"), join(directory, "src"), "dir");
  symlinkSync(resolve(projectRoot, "node_modules"), join(directory, "node_modules"), "dir");
  symlinkSync(resolve(projectRoot, ".git"), join(directory, ".git"), "dir");
  symlinkSync(resolve(projectRoot, "package.json"), join(directory, "package.json"), "file");
  symlinkSync(resolve(projectRoot, "pnpm-lock.yaml"), join(directory, "pnpm-lock.yaml"), "file");
  symlinkSync(resolve(projectRoot, "config"), join(directory, "config"), "dir");
  copyActiveRulesetProfile(directory);
  const evidenceDirectory = join(directory, "evidence");
  mkdirSync(evidenceDirectory, { recursive: true });
  const isolated = join(evidenceDirectory, "isolated.json");
  const testResults = join(evidenceDirectory, "tests.json");
  const phase0 = join(evidenceDirectory, "phase0.json");
  const replay = join(evidenceDirectory, "replay.json");
  const log = join(evidenceDirectory, "run.log");
  writeFileSync(isolated, JSON.stringify(isolatedEvidence(
    input.evidenceSourceCommit,
    input.evidenceCoreCompatibilityHash,
  )));
  writeFileSync(testResults, JSON.stringify({ success: true, run: "current" }));
  writeFileSync(phase0, JSON.stringify({ status: "INCOMPLETE", run: "current" }));
  writeFileSync(replay, JSON.stringify({ stable: true, run: "current" }));
  writeFileSync(log, "current launch failed safely\n");
  const launchStamp = input.attempts === undefined ? "" : "20260717-120000-123";
  if (input.attempts !== undefined) {
    for (let attempt = 1; attempt <= input.attempts; attempt += 1) {
      writeFileSync(
        join(evidenceDirectory, `paper-campaign-phase0-${launchStamp}-attempt-${attempt}.json`),
        JSON.stringify({ status: attempt === input.attempts ? "PASSED" : "INCOMPLETE", attempt }),
      );
      writeFileSync(
        join(evidenceDirectory, `paper-campaign-replay-${launchStamp}-attempt-${attempt}.json`),
        JSON.stringify({ stable: attempt === input.attempts, attempt }),
      );
    }
  }
  const expectedCurrentSourceVersion = resolveSourceVersion(directory);
  const expectedCurrentCoreHash = computeCoreCompatibilityHash(buildCurrentCoreCompatibilityManifest(directory));

  const bundled = spawnSync("zsh", [
    "-c",
    `PROJECT_ROOT="$1"
     source "$2/操作入口/lib/common.sh"
     operator_create_campaign_bundle "$3" "$4" "$5" "$6" "$7" "$8" "$9"`,
    "zsh",
    directory,
    projectRoot,
    join(evidenceDirectory, "missing-pointer.json"),
    log,
    isolated,
    testResults,
    phase0,
    replay,
    launchStamp,
  ], { cwd: directory, encoding: "utf8", env: shellEnvironment, timeout: bundleCommandTimeoutMs });
  expect(bundled.status, bundled.stderr).toBe(0);
  const zipName = readdirSync(join(directory, "交给Codex")).find((name) => name.endsWith(".zip"));
  expect(zipName).toMatch(/^Paper累计验证_UNKNOWN_UNKNOWN_/);
  const zipPath = join(directory, "交给Codex", zipName!);
  const entries = spawnSync("unzip", ["-Z1", zipPath], { encoding: "utf8" }).stdout.trim().split("\n");
  const manifest = JSON.parse(spawnSync("unzip", ["-p", zipPath, "bundle-manifest.json"], {
    encoding: "utf8",
  }).stdout) as {
    campaignId: string;
    sessionId: string;
    reportId: string;
    sourceCommit: string | null;
    sourceCodeDirty: boolean | null;
    coreCompatibilityHash: string | null;
  };
  return { entries, manifest, zipPath, expectedCurrentSourceVersion, expectedCurrentCoreHash };
}

async function exited(child: ReturnType<typeof sleepingProcess>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error(`process did not exit: ${child.pid}`)), 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolvePromise();
    });
  });
}

describe("Paper Campaign operator shell", () => {
  it("keeps the caller's Node ahead of installed fallback runtimes", () => {
    const directory = mkdtempSync(join(tmpdir(), "ni-k-operator-node-selection-"));
    temporaryDirectories.push(directory);
    const selectedDirectory = join(directory, "selected-node");
    const selectedMarker = join(directory, "selected-used");
    mkdirSync(selectedDirectory, { recursive: true });
    const selectedNode = join(selectedDirectory, "node");
    writeFileSync(selectedNode, '#!/bin/sh\nprintf selected > "$OPERATOR_TEST_SELECTED_MARKER"\nexec "$OPERATOR_TEST_NODE" "$@"\n');
    chmodSync(selectedNode, 0o755);

    const result = spawnSync("zsh", [
      "-c",
      `PROJECT_ROOT="$1"
       source "$1/操作入口/lib/common.sh"
       [[ "$PATH" == "$OPERATOR_TEST_SELECTED_DIR:"* ]] || exit 41
       operator_headless_node -p process.execPath`,
      "zsh",
      projectRoot,
    ], {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...shellEnvironment,
        PATH: `${selectedDirectory}:${shellEnvironment.PATH}`,
        OPERATOR_TEST_SELECTED_DIR: selectedDirectory,
        OPERATOR_TEST_SELECTED_MARKER: selectedMarker,
        OPERATOR_TEST_NODE: process.execPath,
      },
      timeout: 10_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(process.execPath);
    expect(readFileSync(selectedMarker, "utf8")).toBe("selected");
  }, 15_000);

  it("reaps only pointer-bound supervisor, Paper, and Observe children", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ni-k-operator-orphan-"));
    temporaryDirectories.push(directory);
    const campaignId = "PC-ORPHANTEST";
    const sessionId = "PS-ORPHANTEST";
    const ownerToken = "operator-owner-test";
    const supervisor = sleepingProcess("src/cli/paper-campaign-run.ts", campaignId, sessionId, ownerToken);
    const paper = sleepingProcess("src/cli/paper-run.ts", campaignId, sessionId);
    const observe = sleepingProcess("src/cli/observe-only.ts", campaignId, sessionId);
    const unrelated = sleepingProcess("src/cli/paper-run.ts", "PC-OTHER", "PS-OTHER");
    const pointer = join(directory, "pointer.json");
    writeFileSync(pointer, JSON.stringify({
      campaignId,
      sessionId,
      supervisorPid: supervisor.pid,
      paperPid: paper.pid,
      observePid: observe.pid,
      operatorOwnerToken: ownerToken,
    }));

    try {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
      const stopped = spawnSync("zsh", [
        "-c",
        `PROJECT_ROOT="$1"
         source "$1/操作入口/lib/common.sh"
         OPERATOR_ORPHAN_SUPERVISOR_WAIT_TICKS=20
         OPERATOR_ORPHAN_WAIT_TICKS=20
         OPERATOR_ORPHAN_FORCE_WAIT_TICKS=20
         operator_stop_campaign_processes_from_pointer "$2"`,
        "zsh",
        projectRoot,
        pointer,
      ], { cwd: projectRoot, encoding: "utf8", env: shellEnvironment, timeout: 10_000 });
      expect(stopped.status, stopped.stderr).toBe(0);
      await Promise.all([exited(supervisor), exited(paper), exited(observe)]);
      expect(unrelated.kill(0)).toBe(true);
    } finally {
      for (const child of [supervisor, paper, observe, unrelated]) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    }
  });

  it("preserves empty pointer fields while reaping a STARTING supervisor and Paper child", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ni-k-operator-starting-orphan-"));
    temporaryDirectories.push(directory);
    const campaignId = "PC-STARTING";
    const sessionId = "PS-STARTING";
    const ownerToken = "operator-owner-starting";
    const supervisor = sleepingProcess("src/cli/paper-campaign-run.ts", campaignId, sessionId, ownerToken);
    const paper = sleepingProcess("src/cli/paper-run.ts", campaignId, sessionId);
    const pointer = join(directory, "pointer.json");
    writeFileSync(pointer, JSON.stringify({
      campaignId,
      sessionId,
      supervisorPid: supervisor.pid,
      paperPid: paper.pid,
      operatorOwnerToken: ownerToken,
    }));
    try {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
      const stopped = spawnSync("zsh", [
        "-c",
        `PROJECT_ROOT="$1"
         source "$1/操作入口/lib/common.sh"
         OPERATOR_ORPHAN_SUPERVISOR_WAIT_TICKS=20
         OPERATOR_ORPHAN_WAIT_TICKS=20
         OPERATOR_ORPHAN_FORCE_WAIT_TICKS=20
         operator_stop_campaign_processes_from_pointer "$2"`,
        "zsh",
        projectRoot,
        pointer,
      ], { cwd: projectRoot, encoding: "utf8", env: shellEnvironment, timeout: 10_000 });
      expect(stopped.status, stopped.stderr).toBe(0);
      await Promise.all([exited(supervisor), exited(paper)]);
    } finally {
      for (const child of [supervisor, paper]) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    }
  });

  it("reaps live Paper and Observe workers even when their supervisor is already gone", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ni-k-operator-stale-supervisor-"));
    temporaryDirectories.push(directory);
    const campaignId = "PC-STALE";
    const sessionId = "PS-STALE";
    const paper = sleepingProcess("src/cli/paper-run.ts", campaignId, sessionId);
    const observe = sleepingProcess("src/cli/observe-only.ts", campaignId, sessionId);
    const pointer = join(directory, "pointer.json");
    writeFileSync(pointer, JSON.stringify({
      campaignId,
      sessionId,
      supervisorPid: 999_999,
      paperPid: paper.pid,
      observePid: observe.pid,
      operatorOwnerToken: "stale-owner",
    }));
    try {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
      const stopped = spawnSync("zsh", [
        "-c",
        `PROJECT_ROOT="$1"
         source "$1/操作入口/lib/common.sh"
         OPERATOR_ORPHAN_WAIT_TICKS=20
         OPERATOR_ORPHAN_FORCE_WAIT_TICKS=20
         operator_stop_campaign_processes_from_pointer "$2"`,
        "zsh",
        projectRoot,
        pointer,
      ], { cwd: projectRoot, encoding: "utf8", env: shellEnvironment, timeout: 10_000 });
      expect(stopped.status, stopped.stderr).toBe(0);
      await Promise.all([exited(paper), exited(observe)]);
    } finally {
      for (const child of [paper, observe]) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    }
  });

  it("keeps the active lock through fixed-pointer packaging and uses report commit evidence", () => {
    const launcher = readFileSync(resolve(projectRoot, "操作入口/lib/run-paper-campaign.sh"), "utf8");
    const common = readFileSync(resolve(projectRoot, "操作入口/lib/common.sh"), "utf8");
    const phase0 = readFileSync(resolve(projectRoot, "src/cli/phase0-validate.ts"), "utf8");
    const campaignRunner = readFileSync(resolve(projectRoot, "src/cli/paper-campaign-run.ts"), "utf8");
    const campaignEvidence = readFileSync(resolve(projectRoot, "src/cli/paper-campaign-evidence.ts"), "utf8");
    const finishStart = launcher.indexOf("finish_campaign_launcher() {");
    const bundleAt = launcher.indexOf("operator_create_campaign_bundle", finishStart);
    const releaseAt = launcher.indexOf('rm -f "$saved_session_file"', finishStart);
    expect(finishStart).toBeGreaterThanOrEqual(0);
    expect(launcher).toContain('pointer_snapshot="$RUN_DIR/paper-campaign-pointer-$STAMP.json"');
    expect(bundleAt).toBeGreaterThan(finishStart);
    expect(releaseAt).toBeGreaterThan(bundleAt);
    expect(launcher).toContain("abort_if_stop_requested");
    expect(launcher).toContain("PREFLIGHT_REPLACEMENT_REQUIRED");
    expect(launcher).toContain("PREFLIGHT_REVALIDATION_REQUIRED");
    expect(launcher).toContain("--test-results=\"$TEST_RESULTS_FILE\"");
    expect(launcher).toContain("--phase0-results=\"$PHASE0_RESULT_FILE\"");
    expect(launcher).toContain("--replay-results=\"$REPLAY_RESULT_FILE\"");
    expect(launcher.match(/--target-wallet/g)).toHaveLength(5);
    expect(readFileSync(resolve(projectRoot, "config/default-target-wallet.txt"), "utf8").trim()).toBe(targetWallet);
    expect(common).toContain('TARGET_WALLET_FILE="$DATA_DIR/operator/target-wallet.txt"');
    expect(common).toContain('"--target-wallet=$TARGET_WALLET"');
    expect(common).toContain('print "代码版本：$report_source_commit"');
    expect(common).toContain("OPERATOR_SOURCE_PROVENANCE");
    expect(common).toContain("sourceCodeDirty: provenance.sourceCodeDirty ?? null");
    expect(common).toContain("coreCompatibilityHash: provenance.coreCompatibilityHash ?? null");
    expect(common).toContain("operator_cleanup_stale_campaign_artifacts");
    expect(common).toContain('"$actual_pnpm" != "$expected_pnpm"');
    expect(phase0).toContain("preparePhase0ValidationDatabase");
    expect(phase0).not.toContain("database.initialize()");
    expect(campaignRunner.match(/isolatedEvidence: summarizeIsolatedEvidence\(isolated\)/g)).toHaveLength(4);
    expect(campaignRunner).toContain("acceptedIncompleteReasons: isolated.proofs.acceptedIncompleteReasons");
    expect(campaignRunner).toContain("parsePaperCampaignChildResult");
    expect(campaignRunner).toContain("PAPER_CAMPAIGN_RECOVERY_POINTER_WRITE_FAILED");
    expect(campaignRunner).toContain("--recover-only");
    expect(campaignRunner.indexOf("service.store.runningSession(snapshot.campaignId)"))
      .toBeLessThan(campaignRunner.indexOf("const startDisposition = paperCampaignStartDisposition("));
    expect(campaignEvidence).toContain("phase0ReplayStatus: evidence.proofs.phase0ReplayStatus");
    const firstOrphanCleanup = launcher.indexOf('if ! operator_stop_campaign_processes_from_pointer "$POINTER_FILE"');
    expect(firstOrphanCleanup).toBeGreaterThanOrEqual(0);
    expect(firstOrphanCleanup).toBeLessThan(launcher.indexOf("ensure_ready"));
    expect(firstOrphanCleanup).toBeLessThan(launcher.indexOf("ensure_phase0_database"));
    expect(firstOrphanCleanup).toBeLessThan(launcher.indexOf("paper-campaign-preflight.ts"));
    expect(launcher.indexOf("operator_start_keep_awake")).toBeLessThan(launcher.indexOf("ensure_phase0_database"));
    const existingCampaignGuard = launcher.indexOf(
      'if [[ "$PREFLIGHT_CAMPAIGN_ID" != "__NONE__"',
    );
    expect(existingCampaignGuard).toBeGreaterThan(launcher.indexOf("paper-campaign-preflight.ts"));
    expect(existingCampaignGuard).toBeLessThan(launcher.indexOf('title "首次运行：自动完成隔离验证"'));
    expect(launcher).toContain("为保护崩溃恢复游标，本次不会先刷新 Phase 0 数据");
    expect(launcher).toContain("value.isolatedEvidenceRefreshRequired");
    expect(launcher).toContain("安全暂停的同核心 Campaign 验证套件发生变化");
    for (const name of [
      "2_安全暂停并生成报告.command",
      "3_查看进度和打开最新结果.command",
    ]) {
      const entry = readFileSync(resolve(projectRoot, "操作入口", name), "utf8");
      expect(entry).toContain('cd "$PROJECT_ROOT"');
    }
  });

  it("bounds fresh Phase0 retries and never accepts ambiguous Replay", () => {
    const launcher = readFileSync(resolve(projectRoot, "操作入口/lib/run-paper-campaign.sh"), "utf8");
    const attemptFunction = launcher.indexOf("run_fresh_phase0_attempt() {");
    const phase0Capture = launcher.indexOf("pnpm phase0:validate", attemptFunction);
    const replayCapture = launcher.indexOf("pnpm phase05:replay-capture", phase0Capture);
    const ambiguityGuard = launcher.indexOf("if (( ambiguous_events != 0 )); then", replayCapture);
    const proofWrite = launcher.indexOf("paper-campaign-evidence.ts write-passed", ambiguityGuard);
    const retryLoop = launcher.indexOf("while (( phase0_attempt <= PHASE0_MAX_ATTEMPTS )); do");
    const naturalRun = launcher.indexOf('title "自然数据运行"');

    expect(launcher).toContain("PHASE0_MAX_ATTEMPTS=3");
    expect(launcher).toContain('paper-campaign-phase0-$STAMP-attempt-$attempt.json');
    expect(launcher).toContain('paper-campaign-replay-$STAMP-attempt-$attempt.json');
    expect(launcher).toContain("value.ambiguousEvents");
    expect(launcher).toContain("系统不会合并、接受或放宽该结果");
    expect(launcher).toContain("连续 $PHASE0_MAX_ATTEMPTS 次 Phase 0 均未形成可接受证明");
    expect(launcher).toContain('"$PHASE0_RESULT_FILE"');
    expect(launcher).toContain('"$REPLAY_RESULT_FILE"');
    expect(attemptFunction).toBeGreaterThanOrEqual(0);
    expect(phase0Capture).toBeGreaterThan(attemptFunction);
    expect(replayCapture).toBeGreaterThan(phase0Capture);
    expect(ambiguityGuard).toBeGreaterThan(replayCapture);
    expect(proofWrite).toBeGreaterThan(ambiguityGuard);
    expect(retryLoop).toBeGreaterThan(proofWrite);
    expect(naturalRun).toBeGreaterThan(retryLoop);
    expect(launcher).not.toContain("reconcileEventCapturePages");
  });

  it("packages a redacted fixed report and records its immutable source commit", () => {
    const directory = mkdtempSync(join(tmpdir(), "ni-k-operator-bundle-"));
    temporaryDirectories.push(directory);
    symlinkSync(resolve(projectRoot, "src"), join(directory, "src"), "dir");
    symlinkSync(resolve(projectRoot, "node_modules"), join(directory, "node_modules"), "dir");
    symlinkSync(resolve(projectRoot, "config"), join(directory, "config"), "dir");
    copyActiveRulesetProfile(directory);
    const evidenceDirectory = join(directory, "evidence");
    mkdirSync(evidenceDirectory, { recursive: true });
    const internalUuid = "c5b7cdec-465a-4b3e-9c17-0ff4cce1327f";
    const sessionReport = join(evidenceDirectory, "session.json");
    const campaignReport = join(evidenceDirectory, "campaign.json");
    const paperReport = join(evidenceDirectory, "paper.json");
    const observeReport = join(evidenceDirectory, "observe.json");
    const runResult = join(evidenceDirectory, "run-result.json");
    const pointer = join(evidenceDirectory, "pointer.json");
    const isolated = join(evidenceDirectory, "isolated.json");
    const log = join(evidenceDirectory, "run.log");
    const immutableCommit = "a".repeat(40);
    const immutableCore = "e".repeat(64);
    writeFileSync(sessionReport, JSON.stringify({
      reportId: "PR-SESSION",
      campaignId: "PC-BUNDLE",
      sessionId: "PS-BUNDLE",
      sourceCodeCommit: immutableCommit,
      sourceVersion: { commit: immutableCommit, dirty: false },
      coreCompatibilityHash: immutableCore,
      paperAccountId: "secret-account",
      observeRunId: internalUuid,
      path: join(directory, "private", "report.json"),
    }));
    writeFileSync(campaignReport, JSON.stringify({
      reportId: "PR-CAMPAIGN",
      campaignId: "PC-BUNDLE",
      sourceCodeCommit: immutableCommit,
      sourceVersion: { commit: immutableCommit, dirty: false },
      coreCompatibilityHash: immutableCore,
    }));
    writeFileSync(paperReport, JSON.stringify({ paperAccountId: "secret-account" }));
    writeFileSync(observeReport, JSON.stringify({ observeRunId: internalUuid }));
    writeFileSync(runResult, JSON.stringify({ paperReportFile: paperReport, observeReportFile: observeReport }));
    writeFileSync(isolated, JSON.stringify({ status: "PASSED" }));
    writeFileSync(log, `${directory} ${internalUuid}\n`);
    writeFileSync(pointer, JSON.stringify({
      campaignId: "PC-BUNDLE",
      sessionId: "PS-BUNDLE",
      reportId: "PR-CAMPAIGN",
      sessionReportFile: sessionReport,
      campaignReportFile: campaignReport,
      runResultFile: runResult,
    }));

    const bundled = spawnSync("zsh", [
      "-c",
      `PROJECT_ROOT="$1"
       source "$2/操作入口/lib/common.sh"
       operator_create_campaign_bundle "$3" "$4" "$5"`,
      "zsh",
      directory,
      projectRoot,
      pointer,
      log,
      isolated,
    ], { cwd: directory, encoding: "utf8", env: shellEnvironment, timeout: 20_000 });
    expect(bundled.status, bundled.stderr).toBe(0);
    const zipName = readdirSync(join(directory, "交给Codex")).find((name) => name.endsWith(".zip"));
    expect(zipName).toBeTruthy();
    const zipPath = join(directory, "交给Codex", zipName!);
    const manifest = JSON.parse(spawnSync("unzip", ["-p", zipPath, "bundle-manifest.json"], {
      encoding: "utf8",
    }).stdout) as {
      manifestVersion: string;
      sourceCommit: string | null;
      sourceCodeDirty: boolean | null;
      coreCompatibilityHash: string | null;
    };
    expect(manifest).toMatchObject({
      manifestVersion: "1.1.0",
      sourceCommit: immutableCommit,
      sourceCodeDirty: false,
      coreCompatibilityHash: immutableCore,
    });
    const allText = spawnSync("unzip", ["-p", zipPath], { encoding: "utf8" }).stdout;
    expect(allText).not.toContain(internalUuid);
    expect(allText).not.toContain("secret-account");
    expect(allText).not.toContain(directory);
    expect(allText).toContain("internal_id_");
    const resultPointer = readFileSync(
      join(directory, "交给Codex", ".paper-campaign-latest-result"),
      "utf8",
    ).trim();
    expect(resultPointer).toBe(zipPath);
    const selected = spawnSync("zsh", [
      "-c",
      `PROJECT_ROOT="$1"
       source "$2/操作入口/lib/common.sh"
       operator_latest_campaign_result`,
      "zsh",
      directory,
      projectRoot,
    ], { cwd: tmpdir(), encoding: "utf8", env: shellEnvironment });
    expect(selected.status, selected.stderr).toBe(0);
    expect(selected.stdout.trim()).toBe(zipPath);
  }, 25_000);

  it.each([
    "source commit",
    "core compatibility hash",
  ] as const)("excludes isolated proof with stale %s while retaining current launch failure evidence", (staleField) => {
    const currentCommit = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).stdout.trim();
    const currentCoreHash = computeCoreCompatibilityHash(buildCurrentCoreCompatibilityManifest(projectRoot));
    const bundled = campaignBundleFixture({
      evidenceSourceCommit: staleField === "source commit" ? "b".repeat(40) : currentCommit,
      evidenceCoreCompatibilityHash: staleField === "core compatibility hash"
        ? "c".repeat(64)
        : currentCoreHash,
    });
    expect(bundled.entries).not.toContain("paper-isolated-verification.json");
    expect(bundled.entries).toEqual(expect.arrayContaining([
      "paper-isolated-test-results-redacted.json",
      "paper-phase0-validation-attempt-1-redacted.json",
      "paper-replay-validation-attempt-1-redacted.json",
      "run-log-redacted.log",
    ]));
    expect(bundled.manifest).toMatchObject({
      campaignId: "UNKNOWN",
      sessionId: "UNKNOWN",
      reportId: "UNKNOWN",
      sourceCommit: currentCommit,
      sourceCodeDirty: bundled.expectedCurrentSourceVersion.dirty,
      coreCompatibilityHash: bundled.expectedCurrentCoreHash,
    });
  }, bundleTestTimeoutMs);

  it("packages every Phase0 and Replay attempt from the current launch only", () => {
    const currentCommit = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).stdout.trim();
    const currentCoreHash = computeCoreCompatibilityHash(buildCurrentCoreCompatibilityManifest(projectRoot));
    const bundled = campaignBundleFixture({
      evidenceSourceCommit: currentCommit,
      evidenceCoreCompatibilityHash: currentCoreHash,
      attempts: 3,
    });

    expect(bundled.entries).toEqual(expect.arrayContaining([
      "paper-phase0-validation-attempt-1-redacted.json",
      "paper-phase0-validation-attempt-2-redacted.json",
      "paper-phase0-validation-attempt-3-redacted.json",
      "paper-replay-validation-attempt-1-redacted.json",
      "paper-replay-validation-attempt-2-redacted.json",
      "paper-replay-validation-attempt-3-redacted.json",
    ]));
    expect(bundled.entries.filter((name) => name.startsWith("paper-phase0-validation-attempt-"))).toHaveLength(3);
    expect(bundled.entries.filter((name) => name.startsWith("paper-replay-validation-attempt-"))).toHaveLength(3);
  }, bundleTestTimeoutMs);

  it("includes isolated proof only when source commit and core compatibility both match", () => {
    const currentCommit = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).stdout.trim();
    const currentCoreHash = computeCoreCompatibilityHash(buildCurrentCoreCompatibilityManifest(projectRoot));
    const bundled = campaignBundleFixture({
      evidenceSourceCommit: currentCommit,
      evidenceCoreCompatibilityHash: currentCoreHash,
    });
    expect(bundled.entries).toContain("paper-isolated-verification.json");
    expect(bundled.manifest).toMatchObject({
      campaignId: "UNKNOWN",
      sessionId: "UNKNOWN",
      reportId: "UNKNOWN",
      sourceCommit: currentCommit,
      sourceCodeDirty: bundled.expectedCurrentSourceVersion.dirty,
      coreCompatibilityHash: bundled.expectedCurrentCoreHash,
    });
  }, bundleTestTimeoutMs);

  it("requires bundled isolated proof to match the report core hash", () => {
    const directory = mkdtempSync(join(tmpdir(), "ni-k-bundle-proof-core-"));
    temporaryDirectories.push(directory);
    const evidenceFile = join(directory, "isolated.json");
    const currentCommit = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).stdout.trim();
    const currentCoreHash = computeCoreCompatibilityHash(buildCurrentCoreCompatibilityManifest(projectRoot));
    writeFileSync(evidenceFile, JSON.stringify(isolatedEvidence(currentCommit, currentCoreHash)));

    const verify = (expectedCoreHash: string) => spawnSync("zsh", [
      "-c",
      `PROJECT_ROOT="$1"
       source "$1/操作入口/lib/common.sh"
       operator_is_bundle_compatible_isolated_evidence "$2" "$3" "$4"`,
      "zsh",
      projectRoot,
      evidenceFile,
      currentCommit,
      expectedCoreHash,
    ], { cwd: projectRoot, encoding: "utf8", env: shellEnvironment, timeout: bundleCommandTimeoutMs });

    expect(verify(currentCoreHash).status).toBe(0);
    expect(verify("f".repeat(64)).status).not.toBe(0);
    const common = readFileSync(resolve(projectRoot, "操作入口/lib/common.sh"), "utf8");
    expect(common).toContain('"$report_core_compatibility_hash"; then');
  }, twoBundleCommandsTimeoutMs);

  it("publishes neither ZIP nor fallback directory when either manifest safety scan fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "ni-k-operator-manifest-fail-"));
    temporaryDirectories.push(directory);
    for (const [name, type] of [
      ["src", "dir"],
      ["node_modules", "dir"],
      [".git", "dir"],
      ["package.json", "file"],
      ["pnpm-lock.yaml", "file"],
      ["config", "dir"],
    ] as const) {
      symlinkSync(resolve(projectRoot, name), join(directory, name), type);
    }
    copyActiveRulesetProfile(directory);
    const evidenceDirectory = join(directory, "evidence");
    mkdirSync(evidenceDirectory, { recursive: true });
    const log = join(evidenceDirectory, "unsafe.log");
    const marker = join(evidenceDirectory, "marker");
    writeFileSync(log, "leak=/private/var/folders/xy/unredacted.log\n");
    writeFileSync(marker, "start\n");

    const legacy = spawnSync("zsh", [
      "-c",
      `PROJECT_ROOT="$1"
       source "$2/操作入口/lib/common.sh"
       operator_copy_sanitized_log() { /bin/cp "$1" "$2"; }
       operator_create_codex_bundle "$3" "$4"`,
      "zsh",
      directory,
      projectRoot,
      marker,
      log,
    ], { cwd: directory, encoding: "utf8", env: shellEnvironment, timeout: bundleCommandTimeoutMs });
    expect(legacy.status).toBe(1);
    expect(existsSync(marker)).toBe(false);

    const campaign = spawnSync("zsh", [
      "-c",
      `PROJECT_ROOT="$1"
       source "$2/操作入口/lib/common.sh"
       operator_copy_sanitized_log() { /bin/cp "$1" "$2"; }
       operator_create_campaign_bundle "$3" "$4" "$5"`,
      "zsh",
      directory,
      projectRoot,
      join(evidenceDirectory, "missing-pointer.json"),
      log,
      join(evidenceDirectory, "missing-proof.json"),
    ], { cwd: directory, encoding: "utf8", env: shellEnvironment, timeout: bundleCommandTimeoutMs });
    expect(campaign.status).toBe(1);

    const published = readdirSync(join(directory, "交给Codex"));
    expect(published.filter((name) => (
      name.endsWith(".zip")
      || name.includes("未压缩")
      || name.startsWith("发给Codex_")
      || name.startsWith(".bundle-")
      || name.startsWith(".paper-campaign-")
    ))).toEqual([]);
  }, twoBundleCommandsTimeoutMs);
});
