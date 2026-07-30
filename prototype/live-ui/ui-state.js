// Pure status helpers for the localhost operator console. Keeping these
// decisions outside app.js makes refresh behavior deterministic and testable.
(function installHecatonchiresUiState(global) {
  function formatTime(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.valueOf())
      ? String(value).slice(0, 19).replace("T", " ")
      : date.toLocaleTimeString("zh-CN", { hour12: false });
  }

  function statusText(snapshot, connectionError = null) {
    if (connectionError) return "后台连接异常";
    if (!snapshot) return "正在连接后台";
    if (snapshot.database?.status === "ERROR") return "后台状态异常";
    if (snapshot.database?.status === "NOT_INITIALIZED") return "后台在线 · 等待初始化";
    const timestamp = formatTime(snapshot.generatedAt);
    if (snapshot.runtime?.state === "RECOVERY_REQUIRED") {
      return `后台在线 · ${timestamp} · 需要恢复`;
    }
    if (snapshot.runtime?.state === "RUNNING") {
      return `后台在线 · ${timestamp} · 运行中`;
    }
    return `后台在线 · ${timestamp}`;
  }

  function snapshotRenderKey(snapshot) {
    if (!snapshot) return "null";
    return JSON.stringify(snapshot, (key, value) => {
      if (
        key === "generatedAt"
        || key === "checkedAt"
        || key === "lastSeenAt"
        || key === "expiresAt"
      ) {
        return undefined;
      }
      return value;
    });
  }

  function serviceInstanceChanged(previousInstanceId, snapshot) {
    const nextInstanceId = snapshot?.service?.instanceId;
    return typeof previousInstanceId === "string"
      && previousInstanceId.length > 0
      && typeof nextInstanceId === "string"
      && nextInstanceId.length > 0
      && previousInstanceId !== nextInstanceId;
  }

  function executionMode(snapshot) {
    return snapshot?.live?.gate?.executionMode
      ?? snapshot?.control?.safety?.executionMode
      ?? "PAPER";
  }

  function rowMoneyView(row, key) {
    const value = row?.[`${key}_view`];
    return value && typeof value === "object" && typeof value.display === "string"
      ? value
      : null;
  }

  function livePositionCount(snapshot) {
    const positions = Array.isArray(snapshot?.live?.positions) ? snapshot.live.positions : [];
    return positions.filter((position) => String(position?.current_size_micros ?? "0") !== "0").length;
  }

  /**
   * Selects the financial source for the four compact overview cards.
   * Paper uses its projection; Live must never fall back to that projection.
   * Until a Live valuation exists, a wallet-cash-only account can still show an
   * exact equity/cash value; accounts with managed positions stay pending rather
   * than displaying demo numbers.
   */
  function overviewFinancials(snapshot) {
    const mode = executionMode(snapshot) === "LIVE" ? "LIVE" : "PAPER";
    if (mode === "PAPER") {
      return {
        mode,
        portfolio: snapshot?.paper?.portfolio ?? null,
        positionCount: Array.isArray(snapshot?.paper?.positions) ? snapshot.paper.positions.length : 0,
        valuationStatus: snapshot?.paper?.portfolio?.valuationStatus ?? null,
      };
    }

    const directPortfolio = snapshot?.live?.portfolio;
    const valuation = Array.isArray(snapshot?.live?.valuations)
      ? snapshot.live.valuations[0]
      : null;
    const walletBalance = snapshot?.live?.walletBalance?.balance ?? null;
    const positionCount = livePositionCount(snapshot);
    const portfolio = directPortfolio ?? (valuation
      ? {
        cashBalance: rowMoneyView(valuation, "cash_balance_micros"),
        reservedBalance: rowMoneyView(valuation, "reserved_balance_micros"),
        availableBalance: rowMoneyView(valuation, "available_balance_micros"),
        positionValue: rowMoneyView(valuation, "position_value_micros"),
        realizedPnl: rowMoneyView(valuation, "realized_pnl_micros"),
        unrealizedPnl: rowMoneyView(valuation, "unrealized_pnl_micros"),
        totalEquity: rowMoneyView(valuation, "total_equity_micros"),
      }
      : {
        cashBalance: walletBalance,
        reservedBalance: null,
        availableBalance: walletBalance,
        positionValue: positionCount === 0 && walletBalance
          ? { ...walletBalance, micros: "0", display: "0.00" }
          : null,
        realizedPnl: null,
        unrealizedPnl: null,
        totalEquity: positionCount === 0 ? walletBalance : null,
      });
    return {
      mode,
      portfolio,
      positionCount,
      valuationStatus: directPortfolio?.valuationStatus
        ?? valuation?.valuation_status
        ?? (positionCount === 0 && walletBalance ? "WALLET_CASH_ONLY" : "PENDING"),
    };
  }

  global.HecatonchiresUiState = {
    executionMode,
    overviewFinancials,
    formatTime,
    serviceInstanceChanged,
    snapshotRenderKey,
    statusText,
  };
})(window);
