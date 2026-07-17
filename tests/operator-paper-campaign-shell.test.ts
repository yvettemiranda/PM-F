import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories: string[] = [];

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
      ], { cwd: projectRoot, encoding: "utf8", timeout: 10_000 });
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
      ], { cwd: projectRoot, encoding: "utf8", timeout: 10_000 });
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
      ], { cwd: projectRoot, encoding: "utf8", timeout: 10_000 });
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
    expect(launcher).toContain("--test-results=\"$TEST_RESULTS_FILE\"");
    expect(launcher).toContain("--phase0-results=\"$PHASE0_RESULT_FILE\"");
    expect(launcher).toContain("--replay-results=\"$REPLAY_RESULT_FILE\"");
    expect(common).toContain('print "代码版本：$report_source_commit"');
    expect(common).toContain('\' "$report_source_commit"');
    expect(common).toContain('"$actual_pnpm" != "$expected_pnpm"');
    expect(phase0).toContain("preparePhase0ValidationDatabase");
    expect(phase0).not.toContain("database.initialize()");
    expect(campaignRunner.match(/isolatedEvidence: summarizeIsolatedEvidence\(isolated\)/g)).toHaveLength(4);
    expect(campaignRunner).toContain("acceptedIncompleteReasons: isolated.proofs.acceptedIncompleteReasons");
    expect(campaignEvidence).toContain("phase0ReplayStatus: evidence.proofs.phase0ReplayStatus");
    const firstOrphanCleanup = launcher.indexOf('if ! operator_stop_campaign_processes_from_pointer "$POINTER_FILE"');
    expect(firstOrphanCleanup).toBeGreaterThanOrEqual(0);
    expect(firstOrphanCleanup).toBeLessThan(launcher.indexOf("ensure_ready"));
    expect(firstOrphanCleanup).toBeLessThan(launcher.indexOf("ensure_phase0_database"));
    expect(firstOrphanCleanup).toBeLessThan(launcher.indexOf("paper-campaign-preflight.ts"));
    expect(launcher.indexOf("operator_start_keep_awake")).toBeLessThan(launcher.indexOf("ensure_phase0_database"));
    const existingCampaignGuard = launcher.indexOf(
      'if [[ "$PREFLIGHT_CAMPAIGN_ID" != "__NONE__" && "$PREFLIGHT_REPLACEMENT_REQUIRED" != "yes" ]]',
    );
    expect(existingCampaignGuard).toBeGreaterThan(launcher.indexOf("paper-campaign-preflight.ts"));
    expect(existingCampaignGuard).toBeLessThan(launcher.indexOf('title "首次运行：自动完成隔离验证"'));
    expect(launcher).toContain("为保护崩溃恢复游标，本次不会先刷新 Phase 0 数据");
    for (const name of [
      "2_安全暂停并生成报告.command",
      "3_查看进度和打开最新结果.command",
    ]) {
      const entry = readFileSync(resolve(projectRoot, "操作入口", name), "utf8");
      expect(entry).toContain('cd "$PROJECT_ROOT"');
    }
  });

  it("packages a redacted fixed report and records its immutable source commit", () => {
    const directory = mkdtempSync(join(tmpdir(), "ni-k-operator-bundle-"));
    temporaryDirectories.push(directory);
    symlinkSync(resolve(projectRoot, "src"), join(directory, "src"), "dir");
    symlinkSync(resolve(projectRoot, "node_modules"), join(directory, "node_modules"), "dir");
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
    writeFileSync(sessionReport, JSON.stringify({
      reportId: "PR-SESSION",
      campaignId: "PC-BUNDLE",
      sessionId: "PS-BUNDLE",
      sourceCodeCommit: immutableCommit,
      paperAccountId: "secret-account",
      observeRunId: internalUuid,
      path: join(directory, "private", "report.json"),
    }));
    writeFileSync(campaignReport, JSON.stringify({
      reportId: "PR-CAMPAIGN",
      campaignId: "PC-BUNDLE",
      sourceCodeCommit: immutableCommit,
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
    ], { cwd: directory, encoding: "utf8", timeout: 20_000 });
    expect(bundled.status, bundled.stderr).toBe(0);
    const zipName = readdirSync(join(directory, "交给Codex")).find((name) => name.endsWith(".zip"));
    expect(zipName).toBeTruthy();
    const zipPath = join(directory, "交给Codex", zipName!);
    const manifest = JSON.parse(spawnSync("unzip", ["-p", zipPath, "bundle-manifest.json"], {
      encoding: "utf8",
    }).stdout) as { sourceCommit: string };
    expect(manifest.sourceCommit).toBe(immutableCommit);
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
    ], { cwd: tmpdir(), encoding: "utf8" });
    expect(selected.status, selected.stderr).toBe(0);
    expect(selected.stdout.trim()).toBe(zipPath);
  });
});
