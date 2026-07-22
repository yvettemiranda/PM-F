import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { operatorControlSnapshot } from "../src/operator/operator-control.js";
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
      controls: {
        targetWallet: { available: true, blockedReason: null },
        paper: { available: true, blockedReason: null },
        live: { available: false, blockedReason: "LIVE_RUNTIME_NOT_WIRED" },
        parameters: { available: false, blockedReason: "COMPILE_TIME_RULESET" },
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
