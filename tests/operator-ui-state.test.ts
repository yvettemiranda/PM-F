import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../prototype/live-ui/ui-state.js", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../prototype/live-ui/app.js", import.meta.url), "utf8");

type UiState = {
  statusText(snapshot: Record<string, unknown> | null, connectionError?: string | null): string;
  snapshotRenderKey(snapshot: Record<string, unknown> | null): string;
  serviceInstanceChanged(
    previousInstanceId: string | null,
    snapshot: Record<string, unknown> | null,
  ): boolean;
};

function load(): UiState {
  const windowObject = {};
  runInNewContext(source, { window: windowObject });
  return (windowObject as { HecatonchiresUiState: UiState }).HecatonchiresUiState;
}

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generatedAt: "2026-07-29T04:00:00.000Z",
    database: { status: "AVAILABLE" },
    runtime: { state: "STOPPED" },
    service: { instanceId: "service-a" },
    live: {
      production: { checkedAt: "2026-07-29T04:00:00.000Z" },
      walletSession: { lastSeenAt: "2026-07-29T04:00:00.000Z" },
    },
    ...overrides,
  };
}

describe("operator UI state projection", () => {
  it("does not impose a hidden 100 pUSD ceiling on operator-defined Live limits", () => {
    expect(appSource).not.toContain("parsed > 100");
    expect(appSource).not.toContain('max="100"');
    expect(appSource).not.toContain("CONFIRM SMALL LIVE LIMITS");
  });

  it("uses the current backend snapshot time instead of the last target update", () => {
    const ui = load();

    expect(ui.statusText(snapshot())).toContain("12:00:00");
    expect(ui.statusText(snapshot())).not.toContain("同步正常");
  });

  it("reports a client connection failure instead of stale healthy text", () => {
    expect(load().statusText(snapshot(), "fetch failed")).toBe("后台连接异常");
  });

  it("does not request a full render for refresh-only timestamps", () => {
    const ui = load();
    const before = snapshot();
    const after = snapshot({
      generatedAt: "2026-07-29T04:00:03.000Z",
      live: {
        production: { checkedAt: "2026-07-29T04:00:03.000Z" },
        walletSession: { lastSeenAt: "2026-07-29T04:00:03.000Z" },
      },
    });

    expect(ui.snapshotRenderKey(after)).toBe(ui.snapshotRenderKey(before));
  });

  it("detects a backend service replacement", () => {
    const ui = load();

    expect(ui.serviceInstanceChanged("service-a", snapshot({
      service: { instanceId: "service-b" },
    }))).toBe(true);
    expect(ui.serviceInstanceChanged("service-a", snapshot())).toBe(false);
  });
});
