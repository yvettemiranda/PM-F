import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { operatorControlSnapshot } from "../src/operator/operator-control.js";
import { OPERATOR_RULESET_PROFILE_CONTEXT } from "../src/domain/versioning.js";
import { saveSelectedRulesetProfile } from "../src/operator/ruleset-profile.js";
import {
  DEFAULT_TARGET_WALLET_FILE,
  OPERATOR_ACTIVE_LOCK,
  SELECTED_TARGET_WALLET_FILE,
  saveSelectedTargetWallet,
  selectedTargetWallet,
} from "../src/operator/target-wallet.js";

const directories: string[] = [];
const defaultWallet = "0x0000000000000000000000000000000000000001";
const selectedWallet = "0x00000000000000000000000000000000000000ab";

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "ni-k-operator-control-"));
  directories.push(root);
  const defaultFile = join(root, DEFAULT_TARGET_WALLET_FILE);
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(defaultFile, `${defaultWallet}\n`);
  return root;
}

describe("operator control", () => {
  it("uses the tracked default until an atomic runtime selection overrides it", () => {
    const root = project();
    expect(selectedTargetWallet(root)).toMatchObject({
      walletAddress: defaultWallet,
      source: "PROJECT_DEFAULT",
      updatedAt: null,
    });

    expect(saveSelectedTargetWallet(root, selectedWallet.toUpperCase())).toMatchObject({
      walletAddress: selectedWallet,
      source: "OPERATOR_SELECTION",
    });
    expect(readFileSync(join(root, SELECTED_TARGET_WALLET_FILE), "utf8")).toBe(`${selectedWallet}\n`);
  });

  it("fails closed on a corrupt selected file instead of silently returning to another wallet", () => {
    const root = project();
    const selectedFile = join(root, SELECTED_TARGET_WALLET_FILE);
    mkdirSync(join(root, "data/operator"), { recursive: true });
    writeFileSync(selectedFile, "not-a-wallet\n");
    expect(() => selectedTargetWallet(root)).toThrow(`TARGET_WALLET_FILE_INVALID:${selectedFile}`);
  });

  it("refuses a target change whenever the operator lock is present", () => {
    const root = project();
    mkdirSync(join(root, OPERATOR_ACTIVE_LOCK), { recursive: true });
    expect(() => saveSelectedTargetWallet(root, selectedWallet))
      .toThrow(`TARGET_WALLET_CHANGE_BLOCKED_BY_OPERATOR_LOCK:${OPERATOR_ACTIVE_LOCK}`);
    expect(selectedTargetWallet(root).walletAddress).toBe(defaultWallet);
  });

  it("exposes honest UI capabilities without creating or mutating a database", () => {
    const root = project();
    const snapshot = operatorControlSnapshot(root);
    expect(snapshot).toMatchObject({
      runtime: { operatorLocked: false, databaseAvailable: false },
      safety: { executionMode: null, liveGateState: null, liveAllowed: false },
      campaign: { latestCampaignId: null },
      ruleset: {
        source: "PROJECT_DEFAULT",
        name: "Project Default",
        configVersion: "v1.7.0",
      },
      controls: {
        targetWallet: { available: true, blockedReason: null },
        paper: { available: true, blockedReason: null },
        live: { available: false, blockedReason: "LIVE_UI_NOT_IMPLEMENTED" },
        parameters: { available: true, blockedReason: null, appliesOnNextCampaign: true },
      },
    });
  });

  it("blocks target and parameter mutations when the database Gate is not safely disabled", () => {
    const root = project();
    const databasePath = join(root, "data/phase0/phase0.sqlite");
    mkdirSync(join(root, "data/phase0"), { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE live_gate_state (
        state_id TEXT PRIMARY KEY,
        execution_mode TEXT NOT NULL,
        live_gate_state TEXT NOT NULL
      );
      INSERT INTO live_gate_state VALUES ('default','LIVE','LIVE_ACTIVE');
    `);
    database.close();

    expect(() => saveSelectedTargetWallet(root, selectedWallet))
      .toThrow("TARGET_WALLET_CHANGE_BLOCKED:DATABASE_NOT_PAPER_LIVE_DISABLED");
    expect(() => saveSelectedRulesetProfile(root, OPERATOR_RULESET_PROFILE_CONTEXT, {
      name: "Unsafe Gate",
      overrides: { buyMaximumPricePpm: 940_000 },
    })).toThrow("RULESET_PROFILE_CHANGE_BLOCKED:DATABASE_NOT_PAPER_LIVE_DISABLED");
    expect(operatorControlSnapshot(root)).toMatchObject({
      safety: { executionMode: "LIVE", liveGateState: "LIVE_ACTIVE", liveAllowed: false },
      controls: {
        targetWallet: { available: false, blockedReason: "DATABASE_NOT_PAPER_LIVE_DISABLED" },
        paper: { available: false, blockedReason: "DATABASE_NOT_PAPER_LIVE_DISABLED" },
        live: { available: false, blockedReason: "LIVE_UI_NOT_IMPLEMENTED" },
        parameters: { available: false, blockedReason: "DATABASE_NOT_PAPER_LIVE_DISABLED" },
      },
    });
  });

  it("feeds the same runtime selection into the desktop shell boundary", () => {
    const root = project();
    saveSelectedTargetWallet(root, selectedWallet);
    const common = join(process.cwd(), "操作入口/lib/common.sh");
    const result = spawnSync("zsh", [
      "-c",
      'PROJECT_ROOT="$1"; source "$2"; print -r -- "$TARGET_WALLET"',
      "zsh",
      root,
      common,
    ], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(selectedWallet);
  });
});
