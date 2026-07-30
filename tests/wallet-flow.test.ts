import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../prototype/live-ui/wallet-flow.js", import.meta.url), "utf8");

interface WalletFlow {
  firstValidAddress(accounts: unknown): string;
  parseChainId(value: unknown): number;
  requestWithTimeout(
    provider: { request(input: unknown): Promise<unknown> },
    request: unknown,
    options?: { timeoutMs?: number; label?: string },
  ): Promise<unknown>;
  runExclusive(
    lockManager: { request(name: string, options: unknown, callback: (lock: unknown) => unknown): unknown } | null,
    name: string,
    task: () => unknown,
  ): Promise<{ acquired: boolean; value?: unknown }>;
  walletErrorMessage(error: unknown): string;
}

function load(): WalletFlow {
  const windowObject = {
    setTimeout,
    clearTimeout,
  } as Record<string, unknown>;
  runInNewContext(source, { window: windowObject });
  return windowObject.HecatonchiresWalletFlow as WalletFlow;
}

describe("browser wallet flow", () => {
  it("reuses a previously authorized wallet address before requesting connection again", () => {
    const wallet = load();
    expect(wallet.firstValidAddress([
      "not-an-address",
      "0xfb54e3e216afd5b1892134d499024271faae5da4",
    ])).toBe("0xfb54e3e216afd5b1892134d499024271faae5da4");
    expect(wallet.firstValidAddress([])).toBe("");
  });

  it("normalizes both standard hexadecimal and numeric wallet chain identifiers", () => {
    const wallet = load();

    expect(wallet.parseChainId("0x89")).toBe(137);
    expect(wallet.parseChainId(137)).toBe(137);
    expect(wallet.parseChainId("137")).toBe(137);
    expect(Number.isNaN(wallet.parseChainId("polygon"))).toBe(true);
  });

  it("serializes wallet work when another browser tab already owns the lock", async () => {
    const wallet = load();
    const task = vi.fn();
    const lockManager = {
      request: vi.fn(async (_name: string, _options: unknown, callback: (lock: unknown) => unknown) => (
        callback(null)
      )),
    };

    await expect(wallet.runExclusive(lockManager, "wallet", task)).resolves.toEqual({
      acquired: false,
    });
    expect(task).not.toHaveBeenCalled();
  });

  it("runs wallet work while holding the browser lock", async () => {
    const wallet = load();
    const lockManager = {
      request: vi.fn(async (_name: string, _options: unknown, callback: (lock: unknown) => unknown) => (
        callback({ name: "wallet" })
      )),
    };

    await expect(wallet.runExclusive(lockManager, "wallet", async () => "done")).resolves.toEqual({
      acquired: true,
      value: "done",
    });
  });

  it("times out a wallet request and converts common pending errors into clear guidance", async () => {
    const wallet = load();
    const never = new Promise<unknown>(() => undefined);
    await expect(wallet.requestWithTimeout(
      { request: async () => never },
      { method: "personal_sign" },
      { timeoutMs: 5, label: "身份签名" },
    )).rejects.toMatchObject({ code: "WALLET_REQUEST_TIMEOUT" });
    expect(wallet.walletErrorMessage({ code: "WALLET_REQUEST_TIMEOUT" })).toContain("自动解除锁定");
    expect(wallet.walletErrorMessage({ code: -32002, message: "already pending" })).toContain(
      "已有一个待确认请求",
    );
    expect(wallet.walletErrorMessage({ code: 4001, message: "User rejected" })).toContain("取消");
  });
});
