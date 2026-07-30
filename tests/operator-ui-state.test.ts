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
type RuntimePanel = (snapshot: Record<string, any>) => string;
type LivePanel = (snapshot: Record<string, any>) => string;
type DomainDetails = (snapshot: Record<string, any>) => string;
type EventCard = (event: Record<string, any>, index: number) => string;

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

function loadRuntimePanel(): RuntimePanel {
  const windowObject = {};
  const renderPrefix = appSource.slice(0, appSource.indexOf("function bindEvents()"));
  runInNewContext(`${source}\n${renderPrefix}\nwindow.__runtimePanel = runtimePanel;`, { window: windowObject });
  return (windowObject as { __runtimePanel: RuntimePanel }).__runtimePanel;
}

function loadLivePanel(): LivePanel {
  const windowObject = {};
  const renderPrefix = appSource.slice(0, appSource.indexOf("function bindEvents()"));
  runInNewContext(`${source}\n${renderPrefix}\nwindow.__livePanel = livePanel;`, { window: windowObject });
  return (windowObject as { __livePanel: LivePanel }).__livePanel;
}

function loadDomainDetails(): DomainDetails {
  const windowObject = {};
  const renderPrefix = appSource.slice(0, appSource.indexOf("function bindEvents()"));
  runInNewContext(`${source}\n${renderPrefix}\nwindow.__domainDetails = domainDetails;`, { window: windowObject });
  return (windowObject as { __domainDetails: DomainDetails }).__domainDetails;
}

function loadEventCard(): EventCard {
  const windowObject = {};
  const renderPrefix = appSource.slice(0, appSource.indexOf("function bindEvents()"));
  runInNewContext(`${source}\n${renderPrefix}\nwindow.__eventCard = eventCard;`, { window: windowObject });
  return (windowObject as { __eventCard: EventCard }).__eventCard;
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

  it("uses the Live runtime rather than the Paper runtime in the header", () => {
    const ui = load();
    const value = snapshot({
      runtime: { state: "STOPPED" },
      live: {
        gate: { executionMode: "LIVE", state: "LIVE_ACTIVE" },
        runtime: { state: "RUNNING", lastError: null },
      },
    });

    expect(ui.statusText(value)).toContain("Live 运行中");
    expect(ui.statusText(value)).not.toContain("Paper");
  });

  it("warns when a Live runtime remains active after the Gate returns to Paper", () => {
    const value = snapshot({
      runtime: { state: "STOPPED" },
      live: {
        gate: { executionMode: "PAPER", state: "LIVE_DISABLED" },
        runtime: { state: "RUNNING", lastError: null },
      },
    });

    expect(load().statusText(value)).toContain("Live 后台未停止");
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
          valuation_status: "COMPLETE",
          unpriced_position_count: 0,
          created_at: "2026-07-29T04:00:00.000Z",
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

  it("does not treat a truncated Live position list as a cash-only account", () => {
    const result = load().overviewFinancials({
      live: {
        gate: { executionMode: "LIVE" },
        walletBalance: {
          balance: { display: "42.00", micros: "42000000", currency: "pUSD" },
        },
        positionSummary: { nonzeroCount: 1 },
        positions: [],
        valuations: [],
      },
      paper: { portfolio: null, positions: [] },
    });

    expect(result.positionCount).toBe(1);
    expect(result.valuationStatus).toBe("PENDING");
    expect(result.portfolio?.availableBalance).toMatchObject({ display: "42.00" });
    expect(result.portfolio?.totalEquity).toBeNull();
    expect(result.portfolio?.positionValue).toBeNull();
  });

  it("renders the Live runtime state instead of the Paper operator state in Live mode", () => {
    const html = loadRuntimePanel()({
      runtime: { state: "STOPPED", observe: { state: "COMPLETED" } },
      live: {
        gate: { executionMode: "LIVE", state: "LIVE_ACTIVE" },
        runtime: { state: "RUNNING", lastError: null },
        selectedAccount: { status: "ACTIVE" },
        capability: { execution: "AVAILABLE" },
      },
      paper: { account: { status: "ACTIVE" } },
    });

    expect(html).toContain("LIVE · RUNNING");
    expect(html).toContain("<strong>RUNNING</strong>");
    expect(html).not.toContain("LIVE · STOPPED");
  });

  it("keeps the manual Live start button disabled unless the Gate is active", () => {
    const html = loadRuntimePanel()({
      runtime: { state: "STOPPED", observe: { state: "COMPLETED" } },
      live: {
        gate: { executionMode: "LIVE", state: "LIVE_DISABLED" },
        runtime: { state: "STOPPED", lastError: null },
        selectedAccount: { status: "ACTIVE" },
        capability: { execution: "AVAILABLE" },
      },
      paper: { account: { status: "ACTIVE" } },
    });

    expect(html).toMatch(/data-action="runtime-start"[^>]*disabled/);
    expect(html).toContain("Live Gate 尚未处于 LIVE_ACTIVE");
  });

  it("keeps emergency stop available for a residual runtime after the Gate is disabled", () => {
    const html = loadLivePanel()({
      control: {
        controls: {
          live: { gateAvailable: true },
        },
      },
      live: {
        gate: {
          executionMode: "PAPER",
          state: "LIVE_DISABLED",
          reason: "USER_STOP",
        },
        runtime: { state: "RUNNING", lastError: null },
        capability: {
          execution: "AVAILABLE",
          walletSetup: "AVAILABLE",
          externalDependencies: [],
        },
        walletSession: { status: "DISCONNECTED" },
        production: {
          status: "PENDING_PREREQUISITES",
          config: {},
          checks: [],
        },
        prerequisites: [],
        valuations: [],
        positions: [],
      },
      paper: { positions: [] },
    });

    expect(html).toContain("Runtime RUNNING");
    expect(html).toMatch(/data-action="live-disable"[^>]*>紧急停用 Live/);
    expect(html).not.toMatch(/data-action="live-disable"[^>]*disabled/);
    expect(html).toMatch(/data-action="live-activate"[^>]*disabled/);
  });

  it("keeps Live execution retry disabled while the Gate is in Paper", () => {
    const html = loadDomainDetails()({
      runtime: {},
      signals: [],
      markets: [],
      riskDecisions: [],
      paper: { executions: [], orders: [], fills: [], positions: [], ledger: {} },
      live: {
        gate: { executionMode: "PAPER", state: "LIVE_DISABLED" },
        capability: { execution: "AVAILABLE", orderManagement: "AVAILABLE" },
        executions: [{
          live_execution_id: "execution-1",
          state: "WAITING_EXECUTION",
        }],
        orders: [],
        attempts: [],
        fills: [],
        positions: [],
        ledger: {},
        gateRuns: [],
        accounts: [],
        reconciliation: [],
        recovery: [],
        quarantines: [],
        valuations: [],
        audit: [],
      },
    });

    expect(html).toMatch(/data-live-execution-retry="execution-1"[^>]*disabled/);
    expect(html).toContain("Live Gate 尚未处于 LIVE_ACTIVE");
  });

  it("labels an old Live balance as stale instead of presenting it as current", () => {
    const html = loadOverview()({
      generatedAt: "2026-07-29T04:00:00.000Z",
      control: {
        target: { walletAddress: "0x00000000000000000000000000000000000000ab" },
        controls: { targetWallet: { available: true } },
      },
      targetRuntime: { identityStatus: "IDENTITY_CONFIRMED" },
      database: { status: "AVAILABLE" },
      live: {
        gate: { executionMode: "LIVE", live_gate_state: "LIVE_ACTIVE" },
        walletBalance: {
          balance: { display: "42.00", micros: "42000000", currency: "pUSD" },
          observedAt: "2026-07-29T03:00:00.000Z",
        },
        valuations: [],
        positions: [],
      },
      paper: { portfolio: null, positions: [] },
    });

    expect(html).toContain("Live 数据已过期");
  });

  it("does not present an incomplete Live valuation as exact total equity", () => {
    const result = load().overviewFinancials({
      generatedAt: "2026-07-29T04:00:00.000Z",
      live: {
        gate: { executionMode: "LIVE" },
        walletBalance: {
          balance: { display: "17.00", micros: "17000000", currency: "pUSD" },
          observedAt: "2026-07-29T04:00:00.000Z",
        },
        valuations: [{
          total_equity_micros_view: { display: "42.00", micros: "42000000", currency: "pUSD" },
          available_balance_micros_view: { display: "17.00", micros: "17000000", currency: "pUSD" },
          position_value_micros_view: { display: "25.00", micros: "25000000", currency: "pUSD" },
          realized_pnl_micros_view: { display: "1.20", micros: "1200000", currency: "pUSD" },
          valuation_status: "INCOMPLETE",
          unpriced_position_count: 1,
          created_at: "2026-07-29T04:00:00.000Z",
        }],
        positionSummary: { nonzeroCount: 1 },
        positions: [],
      },
      paper: {
        portfolio: {
          totalEquity: { display: "1000.00", micros: "1000000000", currency: "pUSD" },
        },
      },
    });

    expect(result.portfolio).toMatchObject({
      availableBalance: { display: "17.00" },
      realizedPnl: { display: "1.20" },
    });
    expect(result.portfolio?.totalEquity).toBeNull();
    expect(result.portfolio?.positionValue).toBeNull();
    expect(result.positionCount).toBe(1);
  });

  it("does not present an incomplete Paper valuation as exact total equity", () => {
    const result = load().overviewFinancials({
      live: { gate: { executionMode: "PAPER" } },
      paper: {
        portfolio: {
          availableBalance: { display: "742.80", micros: "742800000", currency: "pUSD" },
          positionValue: { display: "257.20", micros: "257200000", currency: "pUSD" },
          realizedPnl: { display: "18.42", micros: "18420000", currency: "pUSD" },
          totalEquity: { display: "1000.00", micros: "1000000000", currency: "pUSD" },
          valuationStatus: "INCOMPLETE",
          unpricedPositionCount: 1,
        },
        positionSummary: { nonzeroCount: 3 },
        positions: [],
      },
    });

    expect(result.portfolio).toMatchObject({
      availableBalance: { display: "742.80" },
      realizedPnl: { display: "18.42" },
    });
    expect(result.portfolio?.totalEquity).toBeNull();
    expect(result.portfolio?.positionValue).toBeNull();
    expect(result.positionCount).toBe(3);
  });

  it("labels the execution path in card details with the current mode", () => {
    const html = loadEventCard()({
      occurredAt: "2026-07-29T04:00:00.000Z",
      action: "BUY",
      outcome: "YES",
      market: { question: "Example market" },
      target: {
        price: { display: "0.500" },
        amount: { display: "1.00", currency: "pUSD" },
        capitalRatio: null,
        signalStatus: "PUBLISHED",
        reason: "TARGET_BUY",
      },
      mine: {
        mode: "LIVE",
        decision: "NOT_PROCESSED",
        executionState: null,
        positionStatus: null,
        averagePrice: null,
        amount: null,
        realizedPnl: null,
        riskDecision: null,
        reason: "尚未进入 LIVE 执行链路",
      },
    }, 0);

    expect(html).toContain("Live Execution");
    expect(html).not.toContain("Paper Execution");
  });
});
