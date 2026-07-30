// Pure status helpers for the localhost operator console. Keeping these
// decisions outside app.js makes refresh behavior deterministic and testable.
(function installHecatonchiresUiState(global) {
  const LIVE_DATA_STALE_AFTER_MS = 60_000;

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
    const liveMode = executionMode(snapshot) === "LIVE";
    const liveRuntimeState = snapshot.live?.runtime?.state;
    if (!liveMode && liveRuntimeState === "RUNNING") {
      return `后台在线 · ${timestamp} · Live 后台未停止（Gate 已禁用）`;
    }
    if (!liveMode && liveRuntimeState === "ERROR") {
      return `后台在线 · ${timestamp} · Live 后台异常（Gate 已禁用）`;
    }
    const runtimeState = liveMode
      ? liveRuntimeState
      : snapshot.runtime?.state;
    if (liveMode && runtimeState === "ERROR") {
      return `后台在线 · ${timestamp} · Live 运行异常`;
    }
    if (!liveMode && runtimeState === "RECOVERY_REQUIRED") {
      return `后台在线 · ${timestamp} · 需要恢复`;
    }
    if (runtimeState === "RUNNING") {
      return `后台在线 · ${timestamp} · ${liveMode ? "Live " : ""}运行中`;
    }
    return `后台在线 · ${timestamp}`;
  }

  function snapshotRenderKey(snapshot) {
    if (!snapshot) return "null";
    const generatedTimestamp = Date.parse(snapshot.generatedAt ?? "");
    const freshnessBucket = Number.isFinite(generatedTimestamp)
      ? Math.floor(generatedTimestamp / LIVE_DATA_STALE_AFTER_MS)
      : null;
    return JSON.stringify({ snapshot, freshnessBucket }, (key, value) => {
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
    const summarized = snapshot?.live?.positionSummary?.nonzeroCount;
    if (Number.isSafeInteger(summarized) && summarized >= 0) return summarized;
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
      const sourcePortfolio = snapshot?.paper?.portfolio ?? null;
      const paperValuationIncomplete = sourcePortfolio !== null
        && (
          (
            typeof sourcePortfolio.valuationStatus === "string"
            && sourcePortfolio.valuationStatus !== "COMPLETE"
          )
          || Number(sourcePortfolio.unpricedPositionCount ?? 0) > 0
        );
      const portfolio = paperValuationIncomplete
        ? {
          ...sourcePortfolio,
          positionValue: null,
          unrealizedPnl: null,
          totalEquity: null,
        }
        : sourcePortfolio;
      return {
        mode,
        portfolio,
        positionCount: Number.isSafeInteger(snapshot?.paper?.positionSummary?.nonzeroCount)
          ? snapshot.paper.positionSummary.nonzeroCount
          : Array.isArray(snapshot?.paper?.positions) ? snapshot.paper.positions.length : 0,
        valuationStatus: sourcePortfolio?.valuationStatus ?? null,
        observedAt: sourcePortfolio?.createdAt ?? null,
        stale: false,
      };
    }

    const directPortfolio = snapshot?.live?.portfolio;
    const valuation = Array.isArray(snapshot?.live?.valuations)
      ? snapshot.live.valuations[0]
      : null;
    const walletBalance = snapshot?.live?.walletBalance?.balance ?? null;
    const observedAt = valuation?.created_at
      ?? snapshot?.live?.walletBalance?.observedAt
      ?? null;
    const generatedAt = Date.parse(snapshot?.generatedAt ?? "");
    const observedTimestamp = Date.parse(observedAt ?? "");
    const stale = Number.isFinite(generatedAt)
      && Number.isFinite(observedTimestamp)
      && generatedAt - observedTimestamp > LIVE_DATA_STALE_AFTER_MS;
    const positionCount = livePositionCount(snapshot);
    const valuationComplete = valuation?.valuation_status === "COMPLETE"
      && Number(valuation?.unpriced_position_count ?? 0) === 0;
    const portfolio = directPortfolio ?? (valuation
      ? {
        cashBalance: rowMoneyView(valuation, "cash_balance_micros"),
        reservedBalance: rowMoneyView(valuation, "reserved_balance_micros"),
        availableBalance: rowMoneyView(valuation, "available_balance_micros"),
        positionValue: valuationComplete
          ? rowMoneyView(valuation, "position_value_micros")
          : null,
        realizedPnl: rowMoneyView(valuation, "realized_pnl_micros"),
        unrealizedPnl: valuationComplete
          ? rowMoneyView(valuation, "unrealized_pnl_micros")
          : null,
        totalEquity: valuationComplete
          ? rowMoneyView(valuation, "total_equity_micros")
          : positionCount === 0 ? walletBalance : null,
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
      observedAt,
      stale,
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
