import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../prototype/live-ui/wallet-provider.js", import.meta.url), "utf8");

class FakeWindow {
  ethereum: { request(): Promise<unknown> } | null = null;
  okxwallet: { request(): Promise<unknown> } | null = null;
  readonly Event = class {
    constructor(readonly type: string) {}
  };
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: { type: string; detail?: unknown }): void {
    this.listeners.get(event.type)?.forEach((listener) => listener(event));
  }

  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delay);
  }

  clearTimeout(timer: ReturnType<typeof setTimeout>): void {
    clearTimeout(timer);
  }
}

type WalletDiscovery = { discover(options?: Record<string, unknown>): Promise<unknown> };

function load(windowObject: FakeWindow): WalletDiscovery {
  const context = { window: windowObject };
  runInNewContext(source, context);
  return (windowObject as unknown as { HecatonchiresWalletProvider: WalletDiscovery })
    .HecatonchiresWalletProvider;
}

describe("browser wallet provider discovery", () => {
  it("uses an already injected EIP-1193 provider immediately", async () => {
    const windowObject = new FakeWindow();
    const provider = { request: async () => null };
    windowObject.ethereum = provider;
    const wallet = load(windowObject);

    await expect(wallet.discover()).resolves.toBe(provider);
  });

  it("prefers an announced OKX provider when injection is delayed", async () => {
    const windowObject = new FakeWindow();
    const okxProvider = { request: async () => null };
    const wallet = load(windowObject);
    const pending = wallet.discover({ timeoutMs: 100 });
    windowObject.dispatchEvent({
      type: "eip6963:announceProvider",
      detail: {
        info: { name: "OKX Wallet", rdns: "com.okx.wallet" },
        provider: okxProvider,
      },
    });

    await expect(pending).resolves.toBe(okxProvider);
  });

  it("waits for a delayed OKX announcement instead of selecting another injected wallet", async () => {
    const windowObject = new FakeWindow();
    const otherProvider = {
      isMetaMask: true,
      request: async () => null,
    };
    const okxProvider = {
      isOkxWallet: true,
      request: async () => null,
    };
    windowObject.ethereum = otherProvider;
    const wallet = load(windowObject);
    const pending = wallet.discover({ timeoutMs: 100 });
    windowObject.dispatchEvent({
      type: "eip6963:announceProvider",
      detail: {
        info: { name: "OKX Wallet", rdns: "com.okx.wallet" },
        provider: okxProvider,
      },
    });

    await expect(pending).resolves.toBe(okxProvider);
  });

  it("recognizes the OKX legacy injection point", async () => {
    const windowObject = new FakeWindow();
    const okxProvider = { request: async () => null };
    windowObject.okxwallet = okxProvider;
    const wallet = load(windowObject);

    await expect(wallet.discover()).resolves.toBe(okxProvider);
  });

  it("returns null instead of hanging when no wallet announces", async () => {
    const wallet = load(new FakeWindow());

    await expect(wallet.discover({ timeoutMs: 10 })).resolves.toBeNull();
  });
});
