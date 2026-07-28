import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Phase0Database } from "../src/infra/sqlite/database.js";
import {
  ConfiguredOperatorLiveRuntimeActions,
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

  it("routes explicitly injected LiveRuntime and LiveExecutor operations", async () => {
    let releaseRun!: () => void;
    const runtime = {
      recoverOnStartup: vi.fn(async () => ({ ready: true, recoveryRunId: "recovery-1" })),
      run: vi.fn(async (_options: unknown, signal?: AbortSignal) => {
        await new Promise<void>((resolve) => {
          releaseRun = resolve;
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }),
      emergencyStop: vi.fn(async () => undefined),
    };
    const executor = {
      cancelOrder: vi.fn(async () => undefined),
      retryExecution: vi.fn(async () => undefined),
      reconcile: vi.fn(async () => ({ reason: "LIVE_RECONCILED" })),
    };
    const walletSessionBinding = {
      session: {
        sessionId: "wallet-session-1",
        status: "CONNECTED" as const,
        walletAddress: "0x0000000000000000000000000000000000000001",
        chainId: 137,
        network: "POLYGON" as const,
        walletType: "EIP1193" as const,
        connectedAt: "2026-07-27T08:00:00.000Z",
        lastSeenAt: "2026-07-27T08:00:00.000Z",
        expiresAt: "2026-07-27T08:30:00.000Z",
      },
      assertCurrent: vi.fn(),
      onInvalidated: vi.fn(() => () => undefined),
    };
    const actions = new ConfiguredOperatorLiveRuntimeActions({
      runtime,
      executor,
      accountId: "live-account-1",
      runOptions: { intervalMs: 10, durationMs: 100 },
      walletSessionBinding,
      production: {
        FORMAL_WALLET: true,
        SECURE_SIGNER: true,
        READONLY_BALANCE: true,
        AUTHENTICATED_CLOB: true,
        COMPLIANCE: true,
        GEOBLOCK: true,
        CLOCK_SAFETY: true,
      },
    });
    expect(actions.capability).toMatchObject({
      execution: "AVAILABLE",
      orderManagement: "AVAILABLE",
      production: { SECURE_SIGNER: true, AUTHENTICATED_CLOB: true },
    });

    await expect(actions.start({ actor: "TEST", reason: "START" })).resolves.toMatchObject({
      accepted: true,
      code: "LIVE_RUNTIME_STARTED",
    });
    expect(runtime.recoverOnStartup).toHaveBeenCalledWith("live-account-1");
    expect(runtime.run).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "live-account-1", intervalMs: 10 }),
      expect.any(AbortSignal),
    );
    await expect(actions.start({ actor: "TEST", reason: "START_AGAIN" })).resolves.toMatchObject({
      accepted: false,
      code: "LIVE_RUNTIME_ALREADY_RUNNING",
    });
    await expect(actions.stop({ actor: "TEST", reason: "STOP" })).resolves.toMatchObject({
      accepted: true,
      code: "LIVE_RUNTIME_STOPPED",
    });
    releaseRun();

    await expect(actions.cancelOrder({
      orderId: "order-1",
      actor: "TEST",
      reason: "CANCEL",
    })).resolves.toMatchObject({ accepted: true, code: "LIVE_ORDER_CANCEL_ACCEPTED" });
    await expect(actions.reconcile({ actor: "TEST", reason: "RECONCILE" })).resolves.toMatchObject({
      accepted: true,
      code: "LIVE_RECONCILED",
    });
    await expect(actions.recover({ actor: "TEST", reason: "RECOVER" })).resolves.toMatchObject({
      accepted: true,
      code: "LIVE_RUNTIME_RECOVERED",
    });
    await expect(actions.retryExecution({
      executionId: "execution-1",
      actor: "TEST",
      reason: "RETRY",
    })).resolves.toMatchObject({ accepted: true, code: "LIVE_EXECUTION_RETRY_ACCEPTED" });
    expect(executor.cancelOrder).toHaveBeenCalledWith("order-1", "CANCEL");
    expect(executor.retryExecution).toHaveBeenCalledWith("execution-1", "RETRY");
  });

  it("does not accept start when synchronous startup recovery is blocked", async () => {
    const runtime = {
      recoverOnStartup: vi.fn(async () => ({ ready: false, reason: "ALLOWANCE_MISSING" })),
      run: vi.fn(async () => undefined),
      emergencyStop: vi.fn(async () => undefined),
    };
    const actions = new ConfiguredOperatorLiveRuntimeActions({
      runtime,
      executor: {
        cancelOrder: vi.fn(async () => undefined),
        retryExecution: vi.fn(async () => undefined),
        reconcile: vi.fn(async () => ({ reason: "LIVE_RECONCILED" })),
      },
      accountId: "live-account-1",
    });

    await expect(actions.start({ actor: "TEST", reason: "START" })).resolves.toMatchObject({
      accepted: false,
      code: "LIVE_RUNTIME_STARTUP_RECOVERY_BLOCKED",
    });
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it("emergency-stops when the accepted background loop later fails", async () => {
    const runtime = {
      recoverOnStartup: vi.fn(async () => ({ ready: true })),
      run: vi.fn(async () => {
        throw new Error("LOOP_CRASH");
      }),
      emergencyStop: vi.fn(async () => undefined),
    };
    const actions = new ConfiguredOperatorLiveRuntimeActions({
      runtime,
      executor: {
        cancelOrder: vi.fn(async () => undefined),
        retryExecution: vi.fn(async () => undefined),
        reconcile: vi.fn(async () => ({ reason: "LIVE_RECONCILED" })),
      },
      accountId: "live-account-1",
    });

    await expect(actions.start({ actor: "TEST", reason: "START" })).resolves.toMatchObject({
      accepted: true,
    });
    await vi.waitFor(() => {
      expect(runtime.emergencyStop).toHaveBeenCalledWith(
        "live-account-1",
        "LIVE_RUNTIME_BACKGROUND_FAILED:LOOP_CRASH",
        "SYSTEM",
      );
    });
    expect(actions.lastError).toBe("LOOP_CRASH");
  });

  it("fails closed and emergency-stops when the bound wallet session is replaced", async () => {
    let invalidate!: (reason: "REPLACED") => void;
    const runtime = {
      recoverOnStartup: vi.fn(async () => ({ ready: true })),
      run: vi.fn(async (_options: unknown, signal?: AbortSignal) => {
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      }),
      emergencyStop: vi.fn(async () => undefined),
    };
    const executor = {
      cancelOrder: vi.fn(async () => undefined),
      retryExecution: vi.fn(async () => undefined),
      reconcile: vi.fn(async () => ({ reason: "LIVE_RECONCILED" })),
    };
    const actions = new ConfiguredOperatorLiveRuntimeActions({
      runtime,
      executor,
      accountId: "live-account-1",
      walletSessionBinding: {
        session: {
          sessionId: "wallet-session-1",
          status: "CONNECTED",
          walletAddress: "0x0000000000000000000000000000000000000001",
          chainId: 137,
          network: "POLYGON",
          walletType: "EIP1193",
          connectedAt: "2026-07-27T08:00:00.000Z",
          lastSeenAt: "2026-07-27T08:00:00.000Z",
          expiresAt: "2026-07-27T08:30:00.000Z",
        },
        assertCurrent: vi.fn(),
        onInvalidated: vi.fn((listener) => {
          invalidate = listener as (reason: "REPLACED") => void;
          return () => undefined;
        }),
      },
      production: { FORMAL_WALLET: true, SECURE_SIGNER: true },
    });
    await expect(actions.start({ actor: "TEST", reason: "START" })).resolves.toMatchObject({
      accepted: true,
    });
    invalidate("REPLACED");
    await vi.waitFor(() => {
      expect(runtime.emergencyStop).toHaveBeenCalledWith(
        "live-account-1",
        "LIVE_WALLET_SESSION_REPLACED",
        "WALLET_SESSION_GUARD",
      );
    });
    expect(actions.capability.execution).toBe("PENDING_PREREQUISITES");
    await expect(actions.cancelOrder({
      orderId: "order-1",
      actor: "TEST",
      reason: "CANCEL",
    })).resolves.toMatchObject({
      accepted: false,
      code: "LIVE_WALLET_SESSION_INVALIDATED",
    });
    expect(executor.cancelOrder).not.toHaveBeenCalled();
  });
});
