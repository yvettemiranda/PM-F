import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const helpers = readFileSync(new URL("../prototype/live-ui/ui-state.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../prototype/live-ui/app.js", import.meta.url), "utf8");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function response(data: unknown) {
  return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
}

function page() {
  let transport: (...args: any[]) => any = async () => response({});
  let timerId = 0;
  const timers = new Map<number, { callback: () => void; milliseconds: number }>();
  const reload = vi.fn();
  const window: Record<string, any> = {
    location: { reload },
    setTimeout(callback: () => void, milliseconds: number) {
      timers.set(++timerId, { callback, milliseconds });
      return timerId;
    },
    clearTimeout(id: number) { timers.delete(id); },
    clearInterval() {},
  };
  runInNewContext(`${helpers}\n${app.slice(0, app.lastIndexOf("\nrefresh();"))}\n
    render = () => {};
    updateHeaderStatus = () => {};
    startWalletRequestWorker = () => {};
    window.test = { state, api, refresh, runAction, connectLiveWallet, disconnectLiveWallet,
      invalidateConnectedWallet, requestSafeShutdown };
  `, {
    window,
    AbortController,
    document: {
      querySelector() { return null; },
      addEventListener() {},
    },
    fetch: (...args: any[]) => transport(...args),
  });
  const api = window.test;
  api.state.snapshot = { value: "before", service: { instanceId: "current" } };
  api.state.serviceInstanceId = "current";
  api.state.loading = false;
  api.state.hasRenderedContent = true;
  return {
    ...api,
    window,
    reload,
    timers,
    setFetch(next: typeof transport) { transport = next; },
    fireTimeout(milliseconds: number) {
      const timer = [...timers.values()].find((entry) => entry.milliseconds === milliseconds);
      if (!timer) throw new Error(`No ${milliseconds}ms timer`);
      timer.callback();
    },
  };
}

describe("operator UI request ordering", () => {
  it("ignores a snapshot sent before a mutation, including an obsolete service identity", async () => {
    const ui = page();
    const poll = deferred<ReturnType<typeof response>>();
    ui.setFetch((path: string) => path === "/api/operator/snapshot"
      ? poll.promise
      : response({ snapshot: { value: "saved", service: { instanceId: "current" } } }));
    const pending = ui.refresh(true);
    await ui.runAction("save", "/api/operator/ruleset", { method: "PUT" });
    poll.resolve(response({ value: "old", service: { instanceId: "obsolete" } }));
    await pending;
    expect(ui.state.snapshot.value).toBe("saved");
    expect(ui.state.error).toBeNull();
    expect(ui.state.refreshing).toBe(false);
    expect(ui.reload).not.toHaveBeenCalled();
  });

  it("ignores a pre-mutation connection failure after a successful action", async () => {
    const ui = page();
    const poll = deferred<ReturnType<typeof response>>();
    ui.setFetch((path: string) => path === "/api/operator/snapshot"
      ? poll.promise
      : response({ snapshot: { value: "saved" } }));
    const pending = ui.refresh(true);
    await ui.runAction("save", "/api/operator/ruleset", { method: "PUT" });
    poll.reject(new Error("old connection failure"));
    await pending;
    expect(ui.state.snapshot.value).toBe("saved");
    expect(ui.state.error).toBeNull();
    expect(ui.state.refreshing).toBe(false);
  });

  it("invalidates polls started during an action and resumes normal polling afterward", async () => {
    const ui = page();
    const mutation = deferred<ReturnType<typeof response>>();
    const poll = deferred<ReturnType<typeof response>>();
    ui.setFetch((path: string) => path === "/api/operator/snapshot" ? poll.promise : mutation.promise);
    const action = ui.runAction("start", "/api/operator/runtime/start");
    const refresh = ui.refresh(true);
    mutation.resolve(response({ snapshot: { value: "running" } }));
    await action;
    poll.resolve(response({ value: "stopped" }));
    await refresh;
    expect(ui.state.snapshot.value).toBe("running");
    ui.setFetch(() => response({ value: "fresh" }));
    await ui.refresh(true);
    expect(ui.state.snapshot.value).toBe("fresh");
  });

  it("serializes repeated mutations and releases the guard after a failure", async () => {
    const ui = page();
    const mutation = deferred<ReturnType<typeof response>>();
    const fetch = vi.fn(() => mutation.promise);
    ui.setFetch(fetch);
    const action = ui.runAction("first", "/api/operator/runtime/start");
    const rejection = expect(action).rejects.toThrow("backend failure");
    await expect(ui.runAction("second", "/api/operator/runtime/start")).rejects.toThrow("当前操作正在处理");
    expect(fetch).toHaveBeenCalledTimes(1);
    mutation.reject(new Error("backend failure"));
    await rejection;
    expect(ui.state.actionPending).toBe(false);
    expect(ui.state.busy).toBeNull();
    ui.setFetch(() => response({ snapshot: { value: "recovered" } }));
    await ui.runAction("retry", "/api/operator/runtime/start");
    expect(ui.state.snapshot.value).toBe("recovered");
  });

  it("allows the wallet connection flow to submit its HTTP mutation after signing", async () => {
    const ui = page();
    const walletAddress = "0x0000000000000000000000000000000000000001";
    const provider = { request() {} };
    ui.window.HecatonchiresWalletProvider = { discover: async () => provider };
    ui.window.HecatonchiresWalletFlow = {
      async runExclusive(_locks: unknown, _key: string, action: () => Promise<void>) {
        await action();
        return { acquired: true };
      },
      async requestWithTimeout(_provider: unknown, request: { method: string }) {
        if (request.method === "eth_accounts") return [walletAddress];
        if (request.method === "eth_chainId") return "0x89";
        if (request.method === "personal_sign") return "0xsignature";
        throw new Error(request.method);
      },
      firstValidAddress(accounts: string[]) { return accounts[0]; },
      parseChainId(value: string) { return Number.parseInt(value, 16); },
      walletErrorMessage(error: Error) { return error.message; },
    };
    const fetch = vi.fn((path) => path.endsWith("/challenge")
      ? response({ challengeId: "challenge", message: "prove address" })
      : response({ snapshot: { live: { walletSession: { status: "CONNECTED", sessionId: "session" } } } }));
    ui.setFetch(fetch);
    expect(await ui.connectLiveWallet()).toBe(true);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/operator/live/wallet-session/challenge",
      "/api/operator/live/wallet-session/connect",
    ]);
    expect(ui.state.walletFlowActive).toBe(false);
    expect(ui.state.actionPending).toBe(false);
    expect(ui.state.busy).toBeNull();
  });

  it("does not stop the signing worker when a duplicate disconnect is blocked", async () => {
    const ui = page();
    ui.state.snapshot.live = { walletSession: { status: "CONNECTED", sessionId: "session" } };
    ui.state.walletWorkerSessionId = "session";
    const mutation = deferred<ReturnType<typeof response>>();
    const fetch = vi.fn(() => mutation.promise);
    ui.setFetch(fetch);
    const action = ui.runAction("activate", "/api/operator/live/activate");
    const generation = ui.state.walletWorkerGeneration;
    await ui.disconnectLiveWallet();
    expect(ui.state.walletWorkerGeneration).toBe(generation);
    expect(ui.state.walletWorkerSessionId).toBe("session");
    expect(fetch).toHaveBeenCalledTimes(1);
    mutation.resolve(response({}));
    await action;
  });

  it("lets wallet invalidation supersede an action without accepting its obsolete reply", async () => {
    const ui = page();
    ui.state.snapshot.live = { walletSession: { status: "CONNECTED", sessionId: "old-session" } };
    const mutation = deferred<ReturnType<typeof response>>();
    const disconnect = deferred<ReturnType<typeof response>>();
    ui.setFetch((path: string) => path.endsWith("/disconnect") ? disconnect.promise : mutation.promise);
    const action = ui.runAction("activate", "/api/operator/live/activate");
    const actionRejection = expect(action).rejects.toThrow("后台状态已更新");
    const invalidation = ui.invalidateConnectedWallet("账户已变化");
    mutation.resolve(response({ snapshot: { value: "obsolete connected state" } }));
    await actionRejection;
    expect(ui.state.snapshot.value).toBe("before");
    expect(ui.state.busy).toBe("断开失效钱包");
    await expect(ui.runAction("retry", "/api/operator/live/activate")).rejects.toThrow("当前操作正在处理");
    disconnect.resolve(response({ snapshot: { value: "disconnected" } }));
    await invalidation;
    expect(ui.state.snapshot.value).toBe("disconnected");
    expect(ui.state.walletInvalidationPending).toBe(false);
    expect(ui.state.busy).toBeNull();
  });

  it("does not restore a late snapshot or connection error after safe shutdown", async () => {
    for (const rejectPoll of [false, true]) {
      const ui = page();
      const poll = deferred<ReturnType<typeof response>>();
      ui.setFetch((path: string) => path === "/api/operator/snapshot" ? poll.promise : response({ accepted: true }));
      const refresh = ui.refresh(true);
      await ui.requestSafeShutdown();
      if (rejectPoll) poll.reject(new Error("server stopped"));
      else poll.resolve(response({ value: "obsolete", service: { instanceId: "obsolete" } }));
      await refresh;
      expect(ui.state.shuttingDown).toBe(true);
      expect(ui.state.snapshot.value).toBe("before");
      expect(ui.state.error).toBeNull();
      expect(ui.state.refreshing).toBe(false);
      expect(ui.reload).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])("lets safe shutdown supersede a suspended action, action settles first: %s", async (actionFirst) => {
    const ui = page();
    ui.state.snapshot.live = { walletSession: { status: "CONNECTED", sessionId: "session" } };
    const mutation = deferred<ReturnType<typeof response>>();
    const shutdown = deferred<ReturnType<typeof response>>();
    const fetch = vi.fn((path: string) => path.endsWith("/shutdown") ? shutdown.promise : mutation.promise);
    ui.setFetch(fetch);
    const action = ui.runAction("activate", "/api/operator/live/activate");
    const actionRejection = expect(action).rejects.toThrow("后台状态已更新");
    const exiting = ui.requestSafeShutdown();
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/operator/live/activate", "/api/operator/service/shutdown",
    ]);
    expect(ui.state.actionPending).toBe(true);
    expect(ui.state.shutdownPending).toBe(true);
    expect(ui.state.busy).toBe("安全退出");
    await ui.requestSafeShutdown();
    await expect(ui.runAction("new", "/api/operator/ruleset")).rejects.toThrow("当前操作正在处理");
    expect(await ui.connectLiveWallet()).toBe(false);
    await ui.disconnectLiveWallet();
    expect(fetch).toHaveBeenCalledTimes(2);

    if (actionFirst) {
      mutation.resolve(response({ snapshot: { value: "obsolete connected state" } }));
      await actionRejection;
      expect(ui.state.busy).toBe("安全退出");
      expect(ui.state.notice.title).toBe("正在安全退出");
    }
    shutdown.resolve(response({ accepted: true }));
    await exiting;
    if (!actionFirst) {
      expect(ui.state.actionPending).toBe(true);
      mutation.resolve(response({ snapshot: { value: "obsolete connected state" } }));
      await actionRejection;
    }
    expect(ui.state.shuttingDown).toBe(true);
    expect(ui.state.actionPending).toBe(false);
    expect(ui.state.shutdownPending).toBe(false);
    expect(ui.state.busy).toBeNull();
    expect(ui.state.snapshot.value).toBe("before");
  });

  it("does not let an earlier wallet invalidation overwrite a pending shutdown", async () => {
    const ui = page();
    ui.state.snapshot.live = { walletSession: { status: "CONNECTED", sessionId: "session" } };
    const invalidation = deferred<ReturnType<typeof response>>();
    const shutdown = deferred<ReturnType<typeof response>>();
    ui.setFetch((path: string) => path.endsWith("/shutdown") ? shutdown.promise : invalidation.promise);
    const disconnecting = ui.invalidateConnectedWallet("账户已变化");
    const exiting = ui.requestSafeShutdown();
    invalidation.resolve(response({ snapshot: { value: "late disconnected state" } }));
    await disconnecting;
    expect(ui.state.snapshot.value).toBe("before");
    expect(ui.state.notice.title).toBe("正在安全退出");
    expect(ui.state.busy).toBe("安全退出");
    expect(ui.state.walletInvalidationPending).toBe(false);
    shutdown.resolve(response({ accepted: true }));
    await exiting;
    expect(ui.state.shutdownPending).toBe(false);
    expect(ui.state.busy).toBeNull();
  });

  it.each([false, true])("releases a failed shutdown while preserving pending invalidation, invalidation starts first: %s", async (invalidationFirst) => {
    const ui = page();
    ui.state.snapshot.live = { walletSession: { status: "CONNECTED", sessionId: "session" } };
    const invalidation = deferred<ReturnType<typeof response>>();
    const shutdown = deferred<ReturnType<typeof response>>();
    ui.setFetch((path: string) => path.endsWith("/shutdown") ? shutdown.promise : invalidation.promise);
    let disconnecting: Promise<void>;
    let exiting: Promise<void>;
    if (invalidationFirst) {
      disconnecting = ui.invalidateConnectedWallet("账户已变化");
      exiting = ui.requestSafeShutdown();
    } else {
      exiting = ui.requestSafeShutdown();
      disconnecting = ui.invalidateConnectedWallet("账户已变化");
    }
    expect(ui.state.busy).toBe("安全退出");
    shutdown.reject(new Error("shutdown temporarily failed"));
    await exiting;
    expect(ui.state.shutdownPending).toBe(false);
    expect(ui.state.actionPending).toBe(false);
    expect(ui.state.walletInvalidationPending).toBe(true);
    expect(ui.state.busy).toBe("断开失效钱包");
    expect(ui.state.notice.title).toBe("安全退出未完成");
    invalidation.resolve(response({ snapshot: { value: "late disconnected state" } }));
    await disconnecting;
    expect(ui.state.walletInvalidationPending).toBe(false);
    expect(ui.state.busy).toBeNull();
    expect(ui.state.notice.title).toBe("安全退出未完成");
    expect(ui.state.snapshot.value).toBe("before");
    ui.setFetch(() => response({ snapshot: { value: "recovered" } }));
    await ui.runAction("retry", "/api/operator/ruleset");
    expect(ui.state.snapshot.value).toBe("recovered");
  });

  it("allows retrying failed shutdown while the superseded mutation is still suspended", async () => {
    const ui = page();
    const mutation = deferred<ReturnType<typeof response>>();
    const shutdown = deferred<ReturnType<typeof response>>();
    ui.setFetch((path: string) => path.endsWith("/shutdown") ? shutdown.promise : mutation.promise);
    const action = ui.runAction("activate", "/api/operator/live/activate");
    const actionRejection = expect(action).rejects.toThrow("后台状态已更新");
    const exiting = ui.requestSafeShutdown();
    shutdown.reject(new Error("shutdown temporarily failed"));
    await exiting;
    expect(ui.state.shutdownPending).toBe(false);
    expect(ui.state.actionPending).toBe(true);
    expect(ui.state.busy).toBeNull();
    ui.setFetch(() => response({ accepted: true }));
    await ui.requestSafeShutdown();
    expect(ui.state.shuttingDown).toBe(true);
    mutation.resolve(response({ snapshot: { value: "obsolete" } }));
    await actionRejection;
    expect(ui.state.actionPending).toBe(false);
    expect(ui.state.snapshot.value).toBe("before");
  });

  it.each([false, true])("ignores a wallet signature from before shutdown, shutdown fails: %s", async (shutdownFails) => {
    const ui = page();
    const walletAddress = "0x0000000000000000000000000000000000000001";
    const signature = deferred<string>();
    const signing = deferred<void>();
    const provider = { request() {} };
    ui.window.HecatonchiresWalletProvider = { discover: async () => provider };
    ui.window.HecatonchiresWalletFlow = {
      async runExclusive(_locks: unknown, _key: string, action: () => Promise<void>) {
        await action();
        return { acquired: true };
      },
      async requestWithTimeout(_provider: unknown, request: { method: string }) {
        if (request.method === "eth_accounts") return [walletAddress];
        if (request.method === "eth_chainId") return "0x89";
        if (request.method === "personal_sign") {
          signing.resolve();
          return signature.promise;
        }
        throw new Error(request.method);
      },
      firstValidAddress(accounts: string[]) { return accounts[0]; },
      parseChainId(value: string) { return Number.parseInt(value, 16); },
      walletErrorMessage(error: Error) { return error.message; },
    };
    const fetch = vi.fn((path: string) => {
      if (path.endsWith("/challenge")) return response({ challengeId: "challenge", message: "prove address" });
      if (shutdownFails) throw new Error("shutdown temporarily failed");
      return response({ accepted: true });
    });
    ui.setFetch(fetch);
    const connecting = ui.connectLiveWallet();
    await signing.promise;
    await ui.requestSafeShutdown();
    const notice = ui.state.notice;
    signature.resolve("0xsignature");
    expect(await connecting).toBe(false);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/operator/live/wallet-session/challenge", "/api/operator/service/shutdown",
    ]);
    expect(ui.state.notice).toBe(notice);
    expect(ui.state.walletFlowActive).toBe(false);
    expect(ui.state.actionPending).toBe(false);
    expect(ui.state.shutdownPending).toBe(false);
    expect(ui.state.busy).toBeNull();
  });

  it("keeps the snapshot deadline active while reading a stalled response body", async () => {
    const ui = page();
    ui.setFetch((_path: string, init: { signal: AbortSignal }) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
    }));
    const refresh = ui.refresh(true);
    // fetch has produced headers; the body has not arrived.
    await Promise.resolve();
    expect(ui.state.refreshing).toBe(true);
    ui.fireTimeout(8_000);
    await refresh;
    expect(ui.state.error).toBe("后台响应超时");
    expect(ui.state.refreshing).toBe(false);
    ui.setFetch(() => response({ value: "reconnected" }));
    await ui.refresh(true);
    expect(ui.state.snapshot.value).toBe("reconnected");
    expect(ui.state.error).toBeNull();
  });
});
