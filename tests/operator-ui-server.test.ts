import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOperatorUiServer,
  type OperatorUiServerOptions,
  type OperatorLiveGateActions,
  type OperatorLiveRuntimeActions,
  type OperatorRuntimeActions,
} from "../src/operator/operator-ui-server.js";

const directories: string[] = [];
const servers: Array<ReturnType<typeof createOperatorUiServer>> = [];
const defaultWallet = "0x0000000000000000000000000000000000000001";
const selectedWallet = "0x00000000000000000000000000000000000000ab";

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function project(): { root: string; staticRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "ni-k-operator-ui-server-"));
  directories.push(root);
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config/default-target-wallet.txt"), `${defaultWallet}\n`);
  const staticRoot = join(root, "ui");
  mkdirSync(staticRoot);
  writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>Hecatonchires</title>");
  return { root, staticRoot };
}

async function listen(input: {
  runtimeActions?: OperatorRuntimeActions;
  liveGateActions?: OperatorLiveGateActions;
  liveRuntimeActions?: OperatorLiveRuntimeActions;
  connectedLiveRuntimeFactory?: OperatorUiServerOptions["connectedLiveRuntimeFactory"];
} = {}) {
  const fixture = project();
  const serverOptions: OperatorUiServerOptions = {
    projectRoot: fixture.root,
    staticRoot: fixture.staticRoot,
    ...(input.runtimeActions === undefined ? {} : { runtimeActions: input.runtimeActions }),
    ...(input.liveGateActions === undefined ? {} : { liveGateActions: input.liveGateActions }),
    ...(input.liveRuntimeActions === undefined ? {} : { liveRuntimeActions: input.liveRuntimeActions }),
    ...(input.connectedLiveRuntimeFactory === undefined
      ? {}
      : { connectedLiveRuntimeFactory: input.connectedLiveRuntimeFactory }),
  };
  const server = createOperatorUiServer(serverOptions);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { ...fixture, server, baseUrl };
}

function mutation(
  baseUrl: string,
  path: string,
  input: { method?: string; body?: unknown } = {},
): Promise<Response> {
  const init: RequestInit = {
    method: input.method ?? "POST",
    headers: {
      "content-type": "application/json",
      origin: baseUrl,
    },
  };
  if (input.body !== undefined) init.body = JSON.stringify(input.body);
  return fetch(`${baseUrl}${path}`, init);
}

describe("operator UI server", () => {
  it("serves the real snapshot and static UI from one localhost origin", async () => {
    const { baseUrl } = await listen();
    const snapshotResponse = await fetch(`${baseUrl}/api/operator/snapshot`);
    expect(snapshotResponse.status).toBe(200);
    expect(snapshotResponse.headers.get("cache-control")).toBe("no-store");
    expect(await snapshotResponse.json()).toMatchObject({
      ok: true,
      data: {
        schemaVersion: "operator-dashboard-v1",
        targetRuntime: null,
        comparisons: [],
      },
    });

    const pageResponse = await fetch(`${baseUrl}/`);
    expect(pageResponse.status).toBe(200);
    expect(await pageResponse.text()).toContain("Hecatonchires");
  });

  it("connects target and complete ruleset mutations to the existing operator services", async () => {
    const { baseUrl } = await listen();

    const targetResponse = await mutation(baseUrl, "/api/operator/target", {
      method: "PUT",
      body: { walletAddress: selectedWallet.toUpperCase() },
    });
    expect(targetResponse.status).toBe(200);
    expect(await targetResponse.json()).toMatchObject({
      ok: true,
      data: {
        result: { walletAddress: selectedWallet, source: "OPERATOR_SELECTION" },
        snapshot: { control: { target: { walletAddress: selectedWallet } } },
      },
    });

    const rulesetResponse = await mutation(baseUrl, "/api/operator/ruleset", {
      method: "PUT",
      body: {
        name: "UI profile",
        overrides: { buyMaximumPricePpm: 940_000 },
      },
    });
    expect(rulesetResponse.status).toBe(200);
    expect(await rulesetResponse.json()).toMatchObject({
      ok: true,
      data: {
        result: {
          source: "OPERATOR_PROFILE",
          name: "UI profile",
          rules: { buyMaximumPricePpm: 940_000 },
        },
      },
    });

    const resetResponse = await mutation(baseUrl, "/api/operator/ruleset", {
      method: "DELETE",
    });
    expect(resetResponse.status).toBe(200);
    expect(await resetResponse.json()).toMatchObject({
      ok: true,
      data: {
        result: { reset: true },
        snapshot: { control: { ruleset: { source: "PROJECT_DEFAULT" } } },
      },
    });
  });

  it("stores only public Live production wallet metadata and reports pending prerequisites", async () => {
    const { baseUrl } = await listen();
    const response = await mutation(baseUrl, "/api/operator/live/configuration", {
      method: "PUT",
      body: {
        walletAddress: selectedWallet.toUpperCase(),
        network: "POLYGON",
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: {
        config: {
          schemaVersion: "live-production-config-v1",
          walletAddress: selectedWallet,
          network: "POLYGON",
          walletBinding: "SECURE_HOST_INJECTION",
        },
        snapshot: {
          live: {
            production: {
              path: "PRODUCTION_LIVE",
              status: "PENDING_PREREQUISITES",
              checks: expect.arrayContaining([
                expect.objectContaining({ key: "SECURE_SIGNER", status: "PENDING" }),
              ]),
            },
          },
        },
      },
    });
  });

  it("connects a browser EIP-1193 wallet through a one-time challenge", async () => {
    const account = privateKeyToAccount("0x0123456789012345678901234567890123456789012345678901234567890123");
    const connectedActions: OperatorLiveRuntimeActions = {
      capability: {
        execution: "AVAILABLE",
        orderManagement: "AVAILABLE",
        production: {
          FORMAL_WALLET: true,
          SECURE_SIGNER: true,
          READONLY_BALANCE: true,
          AUTHENTICATED_CLOB: true,
          COMPLIANCE: true,
          GEOBLOCK: true,
          CLOCK_SAFETY: true,
        },
      },
      start: vi.fn(async () => ({ accepted: true, code: "LIVE_RUNTIME_STARTED" })),
      stop: vi.fn(async () => ({ accepted: true, code: "LIVE_RUNTIME_STOPPED" })),
      cancelOrder: vi.fn(async () => ({ accepted: true, code: "LIVE_ORDER_CANCEL_ACCEPTED" })),
      reconcile: vi.fn(async () => ({ accepted: true, code: "LIVE_RECONCILED" })),
      recover: vi.fn(async () => ({ accepted: true, code: "LIVE_RUNTIME_RECOVERED" })),
      retryExecution: vi.fn(async () => ({ accepted: true, code: "LIVE_EXECUTION_RETRY_ACCEPTED" })),
    };
    const connectedLiveRuntimeFactory = vi.fn(async () => connectedActions);
    const { baseUrl, root } = await listen({ connectedLiveRuntimeFactory });
    const challengeResponse = await mutation(baseUrl, "/api/operator/live/wallet-session/challenge", {
      body: { chainId: "0x89" },
    });
    expect(challengeResponse.status).toBe(200);
    const challengePayload = await challengeResponse.json() as {
      ok: boolean;
      data: { challengeId: string; message: string };
    };
    const signature = await account.signMessage({ message: challengePayload.data.message });
    const connectResponse = await mutation(baseUrl, "/api/operator/live/wallet-session/connect", {
      body: {
        challengeId: challengePayload.data.challengeId,
        walletAddress: account.address,
        chainId: "0x89",
        signature,
      },
    });
    expect(connectResponse.status).toBe(200);
    const connectPayload = await connectResponse.json() as {
      data: { session: { sessionId: string } };
    };
    expect(connectPayload).toMatchObject({
      ok: true,
      data: {
        session: {
          status: "CONNECTED",
          walletAddress: account.address.toLowerCase(),
          network: "POLYGON",
          walletType: "EIP1193",
        },
        snapshot: {
          live: {
            walletSession: {
              status: "CONNECTED",
              signerStatus: "READY",
            },
            capability: {
              execution: "AVAILABLE",
              orderManagement: "AVAILABLE",
            },
            production: {
              status: "PENDING_PREREQUISITES",
              checks: expect.arrayContaining([
                expect.objectContaining({ key: "FORMAL_WALLET", status: "READY" }),
              ]),
            },
          },
        },
      },
    });
    expect(connectedLiveRuntimeFactory).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: root,
      walletSession: expect.objectContaining({ walletAddress: account.address.toLowerCase() }),
      walletSessionBinding: expect.objectContaining({
        session: expect.objectContaining({ walletAddress: account.address.toLowerCase() }),
      }),
    }));
    const persisted = readFileSync(join(root, "data/operator/live-production.json"), "utf8");
    expect(persisted).not.toMatch(/private|seed|mnemonic|secret|apiKey/i);

    const disconnectResponse = await mutation(baseUrl, "/api/operator/live/wallet-session/disconnect", {
      body: { sessionId: connectPayload.data.session.sessionId },
    });
    expect(disconnectResponse.status).toBe(200);
    expect(await disconnectResponse.json()).toMatchObject({
      ok: true,
      data: { session: { status: "DISCONNECTED" } },
    });
    const disconnectedSnapshot = await (await fetch(`${baseUrl}/api/operator/snapshot`)).json() as {
      data: {
        live: {
          capability: { execution: string };
          production: { checks: Array<{ key: string; status: string }> };
        };
      };
    };
    expect(disconnectedSnapshot.data.live.capability.execution).toBe("PENDING_PREREQUISITES");
    expect(disconnectedSnapshot.data.live.production.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "FORMAL_WALLET", status: "PENDING" })]),
    );
    const blockedStart = await mutation(baseUrl, "/api/operator/runtime/start", {
      body: { mode: "LIVE", actor: "test", reason: "after disconnect" },
    });
    expect(blockedStart.status).toBe(409);
    expect(await blockedStart.json()).toMatchObject({
      ok: false,
      error: { code: "LIVE_WALLET_SESSION_INVALIDATED" },
    });
    expect(connectedActions.start).not.toHaveBeenCalled();
    expect(connectedActions.stop).toHaveBeenCalledWith(expect.objectContaining({
      actor: "WALLET_SESSION_GUARD",
      reason: "LIVE_WALLET_SESSION_DISCONNECTED",
    }));
  });

  it("routes Paper lifecycle, Live Gate and Live runtime operations without front-end fake state", async () => {
    const runtimeActions: OperatorRuntimeActions = {
      startPaper: vi.fn(async () => ({ accepted: true, operation: "PAPER_START" as const, pid: 101 })),
      stopPaper: vi.fn(async () => ({ accepted: true, operation: "PAPER_STOP" as const, pid: 102 })),
      recoverPaper: vi.fn(async () => ({ accepted: true, operation: "PAPER_RECOVER" as const, pid: 103 })),
    };
    const liveGateActions: OperatorLiveGateActions = {
      preflight: vi.fn(async () => ({
        allowed: false,
        runId: "gate-run-1",
        blockedReasons: ["USER_EXPLICIT_AUTHORIZATION:MISSING"],
        checks: [],
        requestedExecutionMode: "LIVE" as const,
        executionMode: "PAPER",
        liveGateState: "LIVE_DISABLED",
      })),
      requestActivation: vi.fn(async () => ({
        allowed: false,
        runId: "gate-run-2",
        blockedReasons: ["LIVE_BALANCE_UNAVAILABLE"],
        checks: [],
        requestedExecutionMode: "LIVE" as const,
        executionMode: "PAPER",
        liveGateState: "LIVE_DISABLED",
      })),
      confirmActivation: vi.fn(async () => ({
        allowed: false,
        runId: "gate-run-3",
        blockedReasons: ["NOT_ARMING:LIVE_DISABLED"],
        checks: [],
        requestedExecutionMode: "LIVE" as const,
        executionMode: "PAPER",
        liveGateState: "LIVE_DISABLED",
      })),
      emergencyDisable: vi.fn(async () => undefined),
      recover: vi.fn(async () => ({
        allowed: false,
        runId: "gate-run-4",
        blockedReasons: ["LIVE_BALANCE_UNAVAILABLE"],
        checks: [],
        requestedExecutionMode: "LIVE" as const,
        executionMode: "PAPER",
        liveGateState: "LIVE_DISABLED",
      })),
    };
    const liveRuntimeActions: OperatorLiveRuntimeActions = {
      capability: {
        execution: "AVAILABLE",
        orderManagement: "AVAILABLE",
      },
      start: vi.fn(async () => ({ accepted: false, code: "LIVE_RUNTIME_NOT_CONFIGURED" })),
      stop: vi.fn(async () => ({ accepted: true, code: "LIVE_STOP_ACCEPTED" })),
      cancelOrder: vi.fn(async () => ({ accepted: true, code: "CANCEL_ACCEPTED" })),
      reconcile: vi.fn(async () => ({ accepted: true, code: "RECONCILIATION_ACCEPTED" })),
      recover: vi.fn(async () => ({ accepted: true, code: "RECOVERY_ACCEPTED" })),
      retryExecution: vi.fn(async () => ({ accepted: true, code: "RETRY_ACCEPTED" })),
    };
    const { baseUrl } = await listen({
      runtimeActions,
      liveGateActions,
      liveRuntimeActions,
    });
    const snapshot = await fetch(`${baseUrl}/api/operator/snapshot`);
    expect(await snapshot.json()).toMatchObject({
      ok: true,
      data: {
        live: {
          capability: {
            execution: "AVAILABLE",
            orderManagement: "AVAILABLE",
          },
        },
      },
    });

    const start = await mutation(baseUrl, "/api/operator/runtime/start", {
      body: { mode: "PAPER" },
    });
    expect(start.status).toBe(202);
    expect(runtimeActions.startPaper).toHaveBeenCalledOnce();

    const stop = await mutation(baseUrl, "/api/operator/runtime/stop", {
      body: { mode: "PAPER" },
    });
    expect(stop.status).toBe(202);
    expect(runtimeActions.stopPaper).toHaveBeenCalledOnce();

    const recovery = await mutation(baseUrl, "/api/operator/runtime/recover", {
      body: { mode: "PAPER" },
    });
    expect(recovery.status).toBe(202);
    expect(runtimeActions.recoverPaper).toHaveBeenCalledOnce();

    const request = await mutation(baseUrl, "/api/operator/live/request", {
      body: { actor: "LOCAL_OPERATOR", reason: "UI_MODE_SWITCH" },
    });
    expect(request.status).toBe(409);
    expect(await request.json()).toMatchObject({
      ok: false,
      error: {
        code: "LIVE_GATE_BLOCKED",
        details: { runId: "gate-run-2", blockedReasons: ["LIVE_BALANCE_UNAVAILABLE"] },
      },
    });

    const cancel = await mutation(baseUrl, "/api/operator/live/orders/order-7/cancel", {
      body: { actor: "LOCAL_OPERATOR", reason: "USER_REQUEST" },
    });
    expect(cancel.status).toBe(202);
    expect(liveRuntimeActions.cancelOrder).toHaveBeenCalledWith({
      orderId: "order-7",
      actor: "LOCAL_OPERATOR",
      reason: "USER_REQUEST",
    });
  });

  it("rejects cross-origin mutations, malformed JSON and oversized request bodies", async () => {
    const { baseUrl } = await listen();
    const crossOrigin = await fetch(`${baseUrl}/api/operator/target`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body: JSON.stringify({ walletAddress: selectedWallet }),
    });
    expect(crossOrigin.status).toBe(403);
    expect(await crossOrigin.json()).toMatchObject({
      ok: false,
      error: { code: "ORIGIN_NOT_ALLOWED" },
    });

    const malformed = await fetch(`${baseUrl}/api/operator/target`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin: baseUrl,
      },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      ok: false,
      error: { code: "INVALID_JSON" },
    });

    const oversized = await fetch(`${baseUrl}/api/operator/target`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin: baseUrl,
      },
      body: JSON.stringify({ walletAddress: selectedWallet, padding: "x".repeat(70_000) }),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({
      ok: false,
      error: { code: "REQUEST_BODY_TOO_LARGE" },
    });
  });
});
