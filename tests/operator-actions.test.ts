import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Phase0Database } from "../src/infra/sqlite/database.js";
import {
  DefaultOperatorLiveGateActions,
  UnconfiguredOperatorLiveRuntimeActions,
} from "../src/operator/operator-actions.js";

const directories: string[] = [];
const wallet = "0x0000000000000000000000000000000000000001";
const sourceVersion = { commit: "operator-action-test", dirty: false };

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function project(): { root: string; databasePath: string } {
  const root = mkdtempSync(join(tmpdir(), "ni-k-operator-actions-"));
  directories.push(root);
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config/default-target-wallet.txt"), `${wallet}\n`);
  mkdirSync(join(root, "data/phase0"), { recursive: true });
  const databasePath = join(root, "data/phase0/phase0.sqlite");
  const database = new Phase0Database(databasePath, sourceVersion);
  database.initialize();
  database.ensureTarget(wallet, "IDENTITY_CONFIRMED");
  database.close();
  return { root, databasePath };
}

describe("operator actions", () => {
  it("keeps preflight, request and confirmation fail-closed without external providers", async () => {
    const { root, databasePath } = project();
    const actions = new DefaultOperatorLiveGateActions(root);

    const result = await actions.preflight();

    expect(result.allowed).toBe(false);
    expect(result.executionMode).toBe("PAPER");
    expect(result.liveGateState).toBe("LIVE_DISABLED");
    expect(result.blockedReasons.length).toBeGreaterThan(0);

    const requested = await actions.requestActivation({
      actor: "TEST_OPERATOR",
      reason: "TEST_REQUEST",
    });
    expect(requested).toMatchObject({
      allowed: false,
      executionMode: "PAPER",
      liveGateState: "LIVE_DISABLED",
    });

    const confirmed = await actions.confirmActivation({
      actor: "TEST_OPERATOR",
      confirmationText: "ENABLE LIVE TRADING",
    });
    expect(confirmed).toMatchObject({
      allowed: false,
      executionMode: "PAPER",
      liveGateState: "LIVE_DISABLED",
    });

    const database = new DatabaseSync(databasePath, { readOnly: true });
    const state = database.prepare(
      "SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'",
    ).get() as { execution_mode: string; live_gate_state: string };
    database.close();
    expect(state).toEqual({ execution_mode: "PAPER", live_gate_state: "LIVE_DISABLED" });
  });

  it("exposes unconfigured Live execution as an explicit blocked result", async () => {
    const result = await new UnconfiguredOperatorLiveRuntimeActions().cancelOrder({
      orderId: "order-1",
      actor: "TEST",
      reason: "TEST",
    });

    expect(result).toMatchObject({
      accepted: false,
      code: "AUTHENTICATED_CLOB_CANCEL_ADAPTER_NOT_CONFIGURED",
    });
  });
});
