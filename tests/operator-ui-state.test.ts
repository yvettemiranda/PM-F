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
  overviewFinancials(snapshot: Record<string, unknown>): {
    mode: string;
    portfolio: Record<string, unknown> | null;
    positionCount: number;
    valuationStatus: string | null;
  };
};

type Overview = (snapshot: Record<string, any>) => string;

function load(): UiState {
  const windowObject = {};
  runInNewContext(source, { window: windowObject });
  return (windowObject as { HecatonchiresUiState: UiState }).HecatonchiresUiState;
}

function loadOverview(): Overview {
  const windowObject = {};
  const renderPrefix = appSource.slice(0, appSource.indexOf("function bindEvents()"));
  runInNewContext(`${source}\n${renderPrefix}\nwindow.__overview = overview;`, { window: windowObject });
  return (windowObject as { __overview: Overview }).__overview;
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

  it("uses Live valuation in the overview after switching to Live", () => {
    const money = (display: string, micros: string) => ({ display, micros, currency: "pUSD" });
    const html = loadOverview()({
      control: {
        target: { walletAddress: "0x00000000000000000000000000000000000000ab" },
        controls: { targetWallet: { available: true } },
      },
      targetRuntime: { identityStatus: "IDENTITY_CONFIRMED" },
      database: { status: "AVAILABLE" },
      live: {
        gate: { executionMode: "LIVE", live_gate_state: "LIVE_ACTIVE" },
        walletBalance: { balance: money("42.00", "42000000") },
        valuations: [{
          total_equity_micros_view: money("42.00", "42000000"),
          available_balance_micros_view: money("17.00", "17000000"),
          position_value_micros_view: money("25.00", "25000000"),
          realized_pnl_micros_view: money("1.20", "1200000"),
        }],
        positions: [{ current_size_micros: "1" }],
      },
      paper: {
        portfolio: {
          totalEquity: money("1000.00", "1000000000"),
          availableBalance: money("1000.00", "1000000000"),
          positionValue: money("0.00", "0"),
          realizedPnl: money("0.00", "0"),
        },
        positions: [],
      },
    });

    expect(html).toContain(">42.00</strong>");
    expect(html).toContain(">17.00</strong>");
    expect(html).toContain(">25.00</strong>");
    expect(html).not.toContain(">1000.00</strong>");
  });

  it("uses the fresh Live wallet cash when no managed Live position is valued yet", () => {
    const ui = load();
    const result = ui.overviewFinancials({
      live: {
        gate: { executionMode: "LIVE" },
        walletBalance: {
          balance: { display: "42.00", micros: "42000000", currency: "pUSD" },
        },
        positions: [],
        valuations: [],
      },
      paper: {
        portfolio: {
          totalEquity: { display: "1000.00", micros: "1000000000", currency: "pUSD" },
        },
      },
    });

    expect(result.mode).toBe("LIVE");
    expect(result.portfolio).toMatchObject({
      totalEquity: { display: "42.00" },
      availableBalance: { display: "42.00" },
      positionValue: { display: "0.00" },
    });
  });
});
