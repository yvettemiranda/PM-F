// Hecatonchires operator console. All values come from /api/operator/snapshot;
// the browser never owns account, risk, order, or mode state.

const state = {
  snapshot: null,
  loading: true,
  refreshing: false,
  busy: null,
  error: null,
  notice: null,
  refreshTimer: null,
  walletWorkerGeneration: 0,
  walletWorkerSessionId: null,
  walletWorkerRetryTimer: null,
  walletProvider: null,
  walletProviderCleanup: null,
  walletFlowActive: false,
  openPanels: new Set(),
  hasRenderedContent: false,
  lastRenderKey: null,
  serviceInstanceId: null,
  shuttingDown: false,
};

const SETTING_META = {
  buyPriceMinRatioPpm: { label: "目标价格下限", group: "价格与跟单", unit: "%", scale: 10_000 },
  buyPriceMaxRatioPpm: { label: "目标价格上限", group: "价格与跟单", unit: "%", scale: 10_000 },
  buyMaximumPricePpm: { label: "实际价格硬上限", group: "价格与跟单", unit: "", scale: 1_000_000 },
  buyFirstEntryMinimumAmountMicros: { label: "首次最小金额", group: "价格与跟单", unit: "pUSD", scale: 1_000_000 },
  buyMarketMinimumAutoLiftCapMicros: { label: "市场最低金额上限", group: "价格与跟单", unit: "pUSD", scale: 1_000_000 },
  smallFollowBuyMaxCount: { label: "小额跟单次数上限", group: "价格与跟单", unit: "次", scale: 1 },
  waitRatioPpm: { label: "等待价格比例", group: "等待与退出", unit: "%", scale: 10_000 },
  maxWaitMs: { label: "最长等待时间", group: "等待与退出", unit: "分钟", scale: 60_000 },
  followSellMaxSlippagePpm: { label: "跟随平仓最大滑点", group: "等待与退出", unit: "%", scale: 10_000 },
  stopTriggerRatioPpm: { label: "止损触发比例", group: "等待与退出", unit: "%", scale: 10_000 },
  stopSellMaxSlippagePpm: { label: "止损最大滑点", group: "等待与退出", unit: "%", scale: 10_000 },
  fallbackAmountMicros: { label: "固定兜底金额", group: "等待与退出", unit: "pUSD", scale: 1_000_000 },
  paperInitialBalanceMicros: { label: "Paper 初始余额", group: "Paper 账户限制", unit: "pUSD", scale: 1_000_000 },
  paperMaxSingleTradePpm: { label: "单笔资金上限", group: "Paper 账户限制", unit: "%", scale: 10_000 },
  paperMaxMarketExposurePpm: { label: "单市场敞口上限", group: "Paper 账户限制", unit: "%", scale: 10_000 },
  paperMaxPositionExposurePpm: { label: "单持仓敞口上限", group: "Paper 账户限制", unit: "%", scale: 10_000 },
};

const GROUP_ORDER = ["价格与跟单", "等待与退出", "Paper 账户限制"];

const DECISION_LABELS = {
  FOLLOWED: "已跟单",
  WAITING: "等待中",
  RISK_REJECTED: "风控拒绝",
  SKIPPED: "未执行",
  NOT_PROCESSED: "未处理",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? String(value).slice(0, 19).replace("T", " ")
    : date.toLocaleTimeString("zh-CN", { hour12: false });
}

function displayValue(value, fallback = "—") {
  if (value && typeof value === "object" && "display" in value) return value.display;
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function moneyOrDash(value) {
  return value ? `${displayValue(value)} ${value.currency ?? "pUSD"}` : "—";
}

function microsToPusd(value) {
  if (!/^\d+$/.test(String(value ?? ""))) return "";
  const micros = BigInt(value);
  const whole = micros / 1_000_000n;
  const fraction = (micros % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function pusdToMicros(value, label) {
  const normalized = String(value ?? "").trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(normalized)) {
    throw new Error(`${label} 必须是大于 0 的数字，最多 6 位小数`);
  }
  const [whole, fraction = ""] = normalized.split(".");
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0") || "0");
  if (micros <= 0n) throw new Error(`${label} 必须大于 0`);
  return micros.toString();
}

function disabledAttr(disabled, reason = "") {
  return disabled
    ? `disabled aria-disabled="true"${reason ? ` title="${escapeHtml(reason)}"` : ""}`
    : "";
}

function logo() {
  return `
    <span class="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 36 36">
        <path d="M10 9v18M26 9v18M10 18h16" />
        <circle cx="10" cy="7" r="2" /><circle cx="26" cy="7" r="2" />
        <circle cx="10" cy="29" r="2" /><circle cx="26" cy="29" r="2" />
      </svg>
    </span>
  `;
}

function currentMode(snapshot) {
  return snapshot?.live?.gate?.executionMode
    ?? snapshot?.control?.safety?.executionMode
    ?? "PAPER";
}

function statusText(snapshot) {
  return window.HecatonchiresUiState.statusText(snapshot, state.error);
}

function header(snapshot) {
  const mode = currentMode(snapshot);
  const gateAvailable = snapshot?.control?.controls?.live?.gateAvailable === true;
  const modeBlockedReason = snapshot?.control?.controls?.live?.blockedReason ?? "Live Gate 尚不可用";
  return `
    <header class="topbar">
      <div class="topbar-inner">
        <div class="brand">${logo()}<span>Hecatonchires</span></div>
        <div class="top-actions">
          <span class="sync-state ${snapshot?.runtime?.state === "RECOVERY_REQUIRED" ? "warning" : ""}" data-role="backend-status">
            <i></i><span>${escapeHtml(statusText(snapshot))}</span>
          </span>
          <button class="mode-button" id="mode-button" type="button" aria-label="当前模式 ${escapeHtml(mode)}"
            ${disabledAttr(mode !== "LIVE" && !gateAvailable, modeBlockedReason)}>
            <i></i><span>${escapeHtml(mode)}</span>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
          </button>
          <button class="service-exit-button" data-action="service-shutdown" type="button" aria-label="安全退出 Hecatonchires">退出</button>
        </div>
      </div>
    </header>
  `;
}

function overview(snapshot) {
  const target = snapshot?.control?.target?.walletAddress ?? "";
  const targetControl = snapshot?.control?.controls?.targetWallet;
  const targetBlocked = targetControl?.available !== true;
  const targetReason = targetControl?.blockedReason ?? "目标地址当前不可修改";
  const portfolio = snapshot?.paper?.portfolio;
  const summary = [
    ["总权益", portfolio?.totalEquity, "pUSD"],
    ["可用现金", portfolio?.availableBalance, "pUSD"],
    ["持仓价值", portfolio?.positionValue, `${snapshot?.paper?.positions?.length ?? 0} 个仓位`],
    ["已实现盈亏", portfolio?.realizedPnl, "pUSD", portfolio?.realizedPnl?.micros?.startsWith("-") ? "" : "positive"],
  ];
  return `
    <section class="overview-card reveal" style="--delay: 40ms">
      <div class="target-row">
        <div class="target-heading">
          <span class="target-icon">◎</span>
          <div><strong>目标地址</strong><span id="target-feedback">${escapeHtml(
            snapshot?.targetRuntime?.identityStatus === "IDENTITY_CONFIRMED" ? "地址有效" : "待验证",
          )}</span></div>
        </div>
        <div class="target-box">
          <input class="target-input" id="target-input" value="${escapeHtml(target)}" aria-label="目标地址" spellcheck="false"
            ${disabledAttr(targetBlocked, targetReason)} />
          <button class="confirm-button" id="apply-target" type="button" ${disabledAttr(targetBlocked, targetReason)}>确认</button>
        </div>
      </div>
      <div class="summary-strip">
        ${summary.map(([label, value, unit, tone]) => `
          <div class="summary-cell">
            <span>${escapeHtml(label)}</span>
            <strong class="${tone ?? ""}">${escapeHtml(displayValue(value, snapshot?.database?.status === "NOT_INITIALIZED" ? "—" : "暂无"))}</strong>
            <small>${escapeHtml(value ? unit : "")}</small>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function toDisplayRule(key, value) {
  const meta = SETTING_META[key];
  if (!meta || typeof value !== "number") return value ?? "";
  return meta.scale === 1 ? value : Number(value) / meta.scale;
}

function fromDisplayRule(key, value) {
  const meta = SETTING_META[key];
  const number = Number(value);
  if (!meta || !Number.isFinite(number)) return number;
  return Math.round(number * meta.scale);
}

function settingsSummary(rules) {
  const min = toDisplayRule("buyPriceMinRatioPpm", rules?.buyPriceMinRatioPpm);
  const max = toDisplayRule("buyPriceMaxRatioPpm", rules?.buyPriceMaxRatioPpm);
  const wait = toDisplayRule("maxWaitMs", rules?.maxWaitMs);
  if ([min, max, wait].some((value) => value === undefined || value === null)) return "后台默认参数";
  return `价格 ${min}–${max}% · 等待 ${wait} 分钟`;
}

function settingsPanel(snapshot) {
  const rules = snapshot?.control?.ruleset?.rules ?? {};
  const parameterControl = snapshot?.control?.controls?.parameters;
  const parametersBlocked = parameterControl?.available !== true;
  const parametersBlockedReason = parameterControl?.blockedReason ?? "参数当前不可修改";
  const editable = snapshot?.control?.ruleset?.rules
    ? snapshot.control.controls.parameters.editableKeys.filter((key) => SETTING_META[key])
    : [];
  const groups = GROUP_ORDER.map((group) => {
    const keys = editable.filter((key) => SETTING_META[key].group === group);
    if (!keys.length) return "";
    return `
      <section class="settings-section">
        <h3>${escapeHtml(group)}</h3>
        <div class="settings-grid">
          ${keys.map((key) => {
            const meta = SETTING_META[key];
            const suffix = meta.unit ? `<em>${escapeHtml(meta.unit)}</em>` : "";
            return `
              <label class="settings-field">
                <span>${escapeHtml(meta.label)}</span>
                <div class="input-suffix">
                  <input name="${escapeHtml(key)}" type="number" step="${meta.scale === 1 ? "1" : "0.01"}"
                    value="${escapeHtml(toDisplayRule(key, rules[key]))}"
                    ${disabledAttr(parametersBlocked, parametersBlockedReason)} />
                  ${suffix}
                </div>
              </label>
            `;
          }).join("")}
        </div>
      </section>
    `;
  }).join("");
  return `
    <details class="fold-panel reveal" data-panel-id="settings" style="--delay: 85ms">
      <summary>
        <span class="fold-title"><i class="fold-icon">⚙</i><strong>跟单设置</strong></span>
        <span class="fold-summary" id="settings-summary">${escapeHtml(settingsSummary(rules))}</span>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </summary>
      <div class="fold-content settings-content">
        <form class="settings-form" id="settings-form">
          ${groups}
          <p class="settings-system-note">${escapeHtml(parametersBlocked
            ? `当前不可修改：${parametersBlockedReason}`
            : "参数由后台规则集校验，保存后从下一轮 Campaign 生效；运行中的 Campaign 不会被重写。")}</p>
          <div class="settings-actions">
            <span id="settings-status">当前：${escapeHtml(snapshot?.control?.ruleset?.name ?? "后台默认")}</span>
            <div>
              <button class="secondary-button" id="settings-default" type="button"
                ${disabledAttr(parametersBlocked, parametersBlockedReason)}>恢复默认</button>
              <button class="confirm-button" type="submit"
                ${disabledAttr(parametersBlocked, parametersBlockedReason)}>保存设置</button>
            </div>
          </div>
        </form>
      </div>
    </details>
  `;
}

function runtimePanel(snapshot) {
  const runtime = snapshot?.runtime;
  const mode = currentMode(snapshot);
  const paper = snapshot?.paper;
  const campaign = runtime?.campaign;
  const liveMode = mode === "LIVE";
  const paperControl = snapshot?.control?.controls?.paper;
  const liveCapability = snapshot?.live?.capability?.execution;
  const runtimeAvailable = liveMode
    ? liveCapability === "AVAILABLE"
    : paperControl?.available === true;
  const unavailableReason = liveMode
    ? "Live 生产链路已准备，等待正式钱包与生产前置条件"
    : paperControl?.blockedReason ?? "Paper 当前不可运行";
  const startDisabled = Boolean(state.busy) || !runtimeAvailable || runtime?.state === "RUNNING";
  const stopDisabled = Boolean(state.busy) || !runtimeAvailable || runtime?.state !== "RUNNING";
  const recoverDisabled = Boolean(state.busy)
    || !runtimeAvailable
    || (!liveMode && runtime?.state !== "RECOVERY_REQUIRED");
  const startBlockedReason = !runtimeAvailable
    ? unavailableReason
    : runtime?.state === "RUNNING"
      ? `${mode} 正在运行`
      : "";
  const stopBlockedReason = !runtimeAvailable
    ? unavailableReason
    : runtime?.state !== "RUNNING"
      ? `${mode} 当前未运行`
      : "";
  const recoverBlockedReason = !runtimeAvailable
    ? unavailableReason
    : (!liveMode && runtime?.state !== "RECOVERY_REQUIRED")
      ? "没有需要恢复的遗留 Paper 运行"
      : "";
  const accountStatus = liveMode
    ? snapshot?.live?.accounts?.[0]?.status ?? "未配置"
    : paper?.account?.status ?? "未初始化";
  return `
    <details class="fold-panel ops-panel reveal" data-panel-id="runtime" style="--delay: 105ms">
      <summary>
        <span class="fold-title"><i class="fold-icon">▶</i><strong>运行与恢复</strong></span>
        <span class="fold-summary">${escapeHtml(
          runtime?.state === "RECOVERY_REQUIRED"
            ? "发现遗留运行，建议先恢复"
            : `${mode} · ${runtime?.state ?? "等待连接"}${campaign?.state ? ` · Campaign ${campaign.state}` : ""}`,
        )}</span>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </summary>
      <div class="fold-content ops-content">
        <div class="ops-status">
          <div><span>后台状态</span><strong>${escapeHtml(runtime?.state ?? "—")}</strong></div>
          <div><span>${liveMode ? "Live" : "Paper"} 账户</span><strong>${escapeHtml(accountStatus)}</strong></div>
          <div><span>最新 Observe</span><strong>${escapeHtml(runtime?.observe?.state ?? "—")}</strong></div>
        </div>
        <div class="ops-actions">
          <button class="confirm-button" data-action="runtime-start" data-mode="${escapeHtml(mode)}" type="button"
            ${disabledAttr(startDisabled, state.busy ? "" : startBlockedReason)}>启动 ${escapeHtml(mode)}</button>
          <button class="secondary-button" data-action="runtime-stop" data-mode="${escapeHtml(mode)}" type="button"
            ${disabledAttr(stopDisabled, state.busy ? "" : stopBlockedReason)}>安全暂停 ${escapeHtml(mode)}</button>
          <button class="secondary-button" data-action="runtime-recover" data-mode="${escapeHtml(mode)}" type="button"
            ${disabledAttr(recoverDisabled, state.busy ? "" : recoverBlockedReason)}>恢复 ${escapeHtml(mode)}</button>
        </div>
        <p class="ops-note">${escapeHtml(liveMode
          ? (runtimeAvailable
            ? "Live 生命周期通过已注入运行时执行，并继续受 Gate、风控、审计和恢复机制约束。"
            : "Live 生产路径已接入；连接正式钱包并完成生产预检后，启动、暂停和恢复会自动开放。")
          : "Paper 启动/暂停复用桌面入口；恢复只收割经过身份验证的遗留进程，不会启动 Live。")}</p>
      </div>
    </details>
  `;
}

function livePanel(snapshot) {
  const gate = snapshot?.live?.gate;
  const blocked = snapshot?.live?.capability?.externalDependencies ?? [];
  const prerequisites = snapshot?.live?.prerequisites ?? [];
  const production = snapshot?.live?.production;
  const walletSession = snapshot?.live?.walletSession;
  const walletBalance = snapshot?.live?.walletBalance;
  const walletPositionBaseline = snapshot?.live?.walletPositionBaseline;
  const walletConnected = walletSession?.status === "CONNECTED";
  const walletNeedsReconnect = !walletConnected && Boolean(production?.config?.walletAddress);
  const gateAvailable = snapshot?.control?.controls?.live?.gateAvailable === true;
  const runtimeConfigured = snapshot?.live?.capability?.execution === "AVAILABLE";
  const walletSetupAvailable = snapshot?.live?.capability?.walletSetup === "AVAILABLE";
  const gateReason = snapshot?.control?.controls?.live?.blockedReason ?? "Live Gate 尚不可用";
  const checkLabels = {
    FORMAL_WALLET: "正式钱包",
    SECURE_SIGNER: "安全 Signer",
    READONLY_BALANCE: "只读余额",
    AUTHENTICATED_CLOB: "认证 CLOB",
    COMPLIANCE: "合规",
    GEOBLOCK: "地域限制",
    CLOCK_SAFETY: "时钟安全",
    LIVE_LIMITS: "小额限额",
    LIVE_RUNTIME: "LiveRuntime",
    USER_AUTHORIZATION: "用户授权",
  };
  const signatureTypeLabels = {
    EOA: "普通浏览器钱包（EOA）",
    POLY_PROXY: "Polymarket Proxy",
    POLY_GNOSIS_SAFE: "Polymarket Gnosis Safe",
    POLY_1271: "Polymarket Deposit Wallet",
  };
  return `
    <details class="fold-panel ops-panel reveal" data-panel-id="live" style="--delay: 125ms">
      <summary>
        <span class="fold-title"><i class="fold-icon">◆</i><strong>Live 安全状态</strong></span>
        <span class="fold-summary">${escapeHtml(gate ? `${gate.executionMode} · ${gate.state}` : "Gate 等待数据库")}</span>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </summary>
      <div class="fold-content ops-content">
        <div class="gate-banner ${gate?.state === "LIVE_ACTIVE" ? "danger" : ""}">
          <strong>${escapeHtml(production?.status === "READY" ? "生产路径已就绪" : "生产路径待前置条件")}</strong>
          <span>${escapeHtml(walletNeedsReconnect
            ? "本地服务已重启或会话已过期，请在 OKX 重新签名；这不会授权交易。"
            : gate?.reason ?? "当前不会提交真实订单；连接正式钱包后继续完成预检。")}</span>
        </div>
        <div class="live-production-config">
          <div class="production-heading">
            <div><strong>生产钱包准备</strong><span>连接后只保存公开身份；每次签名和链上交易都由你的浏览器钱包确认。</span></div>
            <span class="production-status ${production?.status === "READY" ? "ready" : "pending"}">
              ${escapeHtml(production?.status === "READY"
                ? "可预检"
                : walletConnected
                  ? "已连接"
                  : walletNeedsReconnect ? "需重新签名" : "等待连接")}
            </span>
          </div>
          <div class="production-config-row">
            <input class="target-input" id="live-wallet-address" value="${escapeHtml(
              walletSession?.walletAddress ?? production?.config?.walletAddress ?? "",
            )}"
              placeholder="连接后显示正式钱包地址" aria-label="正式钱包地址" spellcheck="false" readonly />
            <span class="network-select">${escapeHtml(
              production?.config?.network === "POLYGON_AMOY" ? "Polygon Amoy（测试）" : "Polygon 主网",
            )}</span>
            ${walletConnected
              ? `<button class="secondary-button" data-action="live-wallet-disconnect" type="button"
                  ${disabledAttr(Boolean(state.busy), "")}>断开钱包</button>`
              : `<button class="confirm-button" data-action="live-wallet-connect" type="button"
                  ${disabledAttr(Boolean(state.busy), "")}>连接钱包</button>`}
          </div>
          <div class="wallet-session-meta">
            <span>钱包会话：${escapeHtml(walletConnected
              ? "已证明地址控制权"
              : walletNeedsReconnect ? "未连接 · 请重新签名" : "未连接")}</span>
            <span>Signer：${escapeHtml(walletSession?.signerStatus === "READY"
              ? "钱包签名通道已准备"
              : walletConnected ? "正在装配" : "未连接")}</span>
            <span>实际余额：${escapeHtml(walletBalance
              ? `${walletBalance.balance.display} pUSD`
              : "连接并检查 Gate 后显示")}</span>
            <span>启动前仓位：${escapeHtml(walletPositionBaseline
              ? `${walletPositionBaseline.positionCount} 项 · 已隔离`
              : "尚未建立基线")}</span>
          </div>
          <form class="live-limit-form" id="live-config-form">
            <div class="live-limit-heading">
              <div><strong>Live 风险参数</strong><span>默认：10 pUSD 资金上限、1 pUSD 单笔、3 pUSD 总敞口、1 pUSD 单日止损；可按你的实际资金修改。</span></div>
              <span>${escapeHtml(production?.config?.limitsConfirmedAt ? "已确认" : "待确认")}</span>
            </div>
            <div class="live-limit-grid">
              <label class="settings-field">
                <span>钱包类型</span>
                <input name="signatureType" value="${escapeHtml(production?.config?.signatureType ?? "EOA")}" type="hidden" />
                <div class="readonly-field">${escapeHtml(
                  signatureTypeLabels[production?.config?.signatureType] ?? "等待自动识别",
                )}</div>
              </label>
              <label class="settings-field live-wallet-field">
                <span>交易资金地址</span>
                <input name="tradingWalletAddress" value="${escapeHtml(
                  production?.config?.tradingWalletAddress ?? production?.config?.walletAddress ?? "",
                )}" placeholder="连接后自动识别" spellcheck="false" readonly />
              </label>
              ${[
                ["liveBankroll", "Live 资金上限", "liveBankrollMicros"],
                ["maxTradeSize", "单笔上限", "maxTradeSizeMicros"],
                ["maxExposure", "总敞口上限", "maxExposureMicros"],
                ["maxDailyLoss", "单日亏损上限", "maxDailyLossMicros"],
              ].map(([name, label, key]) => `
                <label class="settings-field">
                  <span>${label}</span>
                  <div class="field-with-unit">
                    <input name="${name}" type="number" min="0.000001" step="0.000001"
                      value="${escapeHtml(microsToPusd(production?.config?.[key]))}" required />
                    <em>pUSD</em>
                  </div>
                </label>
              `).join("")}
            </div>
            <label class="live-confirm-check">
              <input name="acceptCompliance" type="checkbox" ${production?.config?.complianceAcceptedAt ? "checked" : ""} />
              <span>我确认本人所在地区与账户允许使用该交易服务，并接受实时地域检查失败时系统立即阻断。</span>
            </label>
            <div class="live-limit-confirm">
              <span>保存后立即按这组参数执行；实际钱包余额只展示，不作为最低准入条件。</span>
              <button class="confirm-button" type="submit" ${disabledAttr(Boolean(state.busy), "")}>保存参数</button>
            </div>
          </form>
        </div>
        <div class="production-check-list">
          ${(production?.checks ?? []).map((item) => `
            <span class="production-check ${item.status === "READY" ? "ready" : "pending"}"
              title="${escapeHtml(item.reason ?? "")}">
              <i></i>${escapeHtml(checkLabels[item.key] ?? item.key)} · ${item.status === "READY" ? "就绪" : "待完成"}
            </span>
          `).join("")}
        </div>
        <div class="prerequisite-list">
          ${prerequisites.length
            ? prerequisites.slice(0, 8).map((item) => {
              const visibleStatus = item.effectiveStatus ?? item.status;
              const title = item.effectiveReason === "SOURCE_DIRTY"
                ? "当前运行源码含未验证改动"
                : item.effectiveReason === "SOURCE_COMMIT_MISMATCH"
                  ? "证据属于旧版本，需要重新验证"
                  : "";
              return `<span class="prerequisite ${visibleStatus === "PASSED" ? "passed" : "blocked"}"${title ? ` title="${escapeHtml(title)}"` : ""}>${escapeHtml(item.key)} · ${escapeHtml(visibleStatus)}</span>`;
            }).join("")
            : `<span class="empty-inline">数据库初始化后显示 Gate 前置条件</span>`}
        </div>
        <div class="ops-actions">
          <button class="confirm-button" data-action="live-activate" type="button"
            ${disabledAttr(Boolean(state.busy) || !gateAvailable, gateAvailable ? "" : gateReason)}>一键检查并切换 LIVE</button>
          <button class="secondary-button danger-button" data-action="live-disable" type="button"
            ${disabledAttr(Boolean(state.busy) || gate?.state === "LIVE_DISABLED", "Live 当前已禁用")}>紧急停用 Live</button>
        </div>
        <details class="live-advanced-actions">
          <summary>高级诊断</summary>
          <div class="ops-actions">
            <button class="secondary-button" data-action="live-wallet-setup" type="button"
              ${disabledAttr(
                Boolean(state.busy) || !walletConnected || !walletSetupAvailable,
                walletConnected ? "钱包链上授权运行时尚未准备" : "请先连接正式钱包",
              )}>仅检查交易授权</button>
            <button class="secondary-button" data-action="live-preflight" type="button"
              ${disabledAttr(Boolean(state.busy) || !gateAvailable, gateAvailable ? "" : gateReason)}>仅检查 Gate</button>
            <button class="secondary-button" data-action="live-recover" type="button"
              ${disabledAttr(Boolean(state.busy) || !gateAvailable, gateAvailable ? "" : gateReason)}>仅恢复 Gate</button>
            <button class="secondary-button" data-action="live-reconcile" type="button"
              ${disabledAttr(Boolean(state.busy) || !runtimeConfigured, runtimeConfigured ? "" : "连接钱包后自动装配 LiveRuntime")}>仅执行 Live 对账</button>
          </div>
        </details>
        <p class="ops-note">${escapeHtml(production?.status === "READY"
          ? "生产前置条件已齐备；点击一次即可自动检查并切换，无需重新保存参数。"
          : `当前待完成：${blocked.length ? blocked.join("、") : "钱包和确认步骤"}。点击一键切换后系统会自动逐项处理；失败时保持 Paper，不需要重填已保存参数。`)}</p>
      </div>
    </details>
  `;
}

function metric(label, value) {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(displayValue(value))}</strong></div>`;
}

function eventCard(event, index) {
  const decision = event.mine.decision.toLowerCase();
  const action = event.action.toLowerCase();
  const targetAmount = event.action === "SELL"
    ? event.target.sellRatio?.display ?? "—"
    : `${moneyOrDash(event.target.amount)}${event.target.capitalRatio ? ` · ${event.target.capitalRatio.display}` : ""}`;
  const ownAmount = event.action === "SELL"
    ? moneyOrDash(event.mine.realizedPnl)
    : moneyOrDash(event.mine.amount);
  const status = event.mine.executionState ?? event.mine.positionStatus ?? DECISION_LABELS[event.mine.decision];
  return `
    <article class="trade-card reveal" data-decision="${escapeHtml(decision)}" style="--delay: ${140 + index * 45}ms">
      <header class="trade-head">
        <div class="trade-title">
          <div class="trade-meta">
            <time>${escapeHtml(formatTime(event.occurredAt))}</time>
            <span class="action-chip ${escapeHtml(action)}">${escapeHtml(event.action)}</span>
            <span class="outcome-chip ${escapeHtml(event.outcome.toLowerCase())}">${escapeHtml(event.outcome)}</span>
          </div>
          <h2>${escapeHtml(event.market.question)}</h2>
        </div>
        <span class="decision-chip ${escapeHtml(decision)}">${escapeHtml(DECISION_LABELS[event.mine.decision])}</span>
      </header>
      <div class="trade-flow">
        <section class="trade-side target-side">
          <div class="side-heading"><span class="side-avatar">目</span><strong>目标地址</strong></div>
          <div class="metric-list">
            ${metric(event.action === "SELL" ? "平仓价" : "开仓价", event.target.price)}
            ${metric(event.action === "SELL" ? "平仓比例" : "目标金额", targetAmount)}
            ${metric("目标 Signal", event.target.signalStatus)}
          </div>
        </section>
        <div class="flow-connector" aria-hidden="true">
          <span class="flow-line"><i></i></span>
          <svg viewBox="0 0 16 16"><path d="m6 3 5 5-5 5" /></svg>
        </div>
        <section class="trade-side own-side">
          <div class="side-heading"><span class="side-avatar">我</span><strong>我的情况</strong></div>
          <div class="metric-list">
            ${metric(event.action === "SELL" ? "平仓价" : "成交价", event.mine.averagePrice)}
            ${metric(event.action === "SELL" ? "实际盈亏" : "我的投入", ownAmount)}
            ${metric("执行状态", status)}
          </div>
        </section>
      </div>
      <details class="trade-details" data-panel-id="trade-${index}">
        <summary class="trade-footer">
          <span><i></i>${escapeHtml(status)}</span>
          <span><span class="detail-label closed-label">查看明细</span><span class="detail-label open-label">收起明细</span><svg viewBox="0 0 16 16"><path d="m4 6 4 4 4-4" /></svg></span>
        </summary>
        <div class="details">
          <p>目标：${escapeHtml(event.target.reason)} · 我的决定：${escapeHtml(event.mine.reason)}</p>
          <div class="audit-flow"><span>目标事件</span><i></i><span>Signal</span><i></i><span>Risk ${escapeHtml(event.mine.riskDecision ?? "—")}</span><i></i><span>Paper Execution</span></div>
        </div>
      </details>
    </article>
  `;
}

function executionDetails(snapshot) {
  const events = snapshot?.comparisons ?? [];
  return `
    <details class="fold-panel execution-panel reveal" data-panel-id="executions" style="--delay: 420ms">
      <summary>
        <span class="fold-title"><i class="fold-icon">≡</i><strong>执行明细</strong></span>
        <span class="fold-summary">目标、跟单决定、成交与原因</span>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </summary>
      <div class="execution-wrap">
        ${events.length ? `
          <table class="execution-table">
            <thead><tr><th>时间</th><th>市场</th><th>目标动作</th><th>目标价格</th><th>目标金额 / 比例</th><th>跟单决定</th><th>我的价格</th><th>我的金额 / 盈亏</th><th>状态与原因</th></tr></thead>
            <tbody>
              ${events.map((event) => {
                const decision = event.mine.decision.toLowerCase();
                return `
                  <tr>
                    <td><time>${escapeHtml(formatTime(event.occurredAt))}</time></td>
                    <td><strong>${escapeHtml(event.market.question)}</strong><span>${escapeHtml(event.outcome)}</span></td>
                    <td><span class="table-action ${escapeHtml(event.action.toLowerCase())}">${escapeHtml(event.action)}</span></td>
                    <td><strong>${escapeHtml(displayValue(event.target.price))}</strong></td>
                    <td><strong>${escapeHtml(event.action === "SELL" ? displayValue(event.target.sellRatio) : moneyOrDash(event.target.amount))}</strong></td>
                    <td><span class="table-status ${escapeHtml(decision)}">${escapeHtml(DECISION_LABELS[event.mine.decision])}</span></td>
                    <td><strong>${escapeHtml(displayValue(event.mine.averagePrice))}</strong></td>
                    <td><strong>${escapeHtml(moneyOrDash(event.mine.amount ?? event.mine.realizedPnl))}</strong><span>${escapeHtml(event.mine.positionStatus ?? "")}</span></td>
                    <td><strong>${escapeHtml(event.mine.executionState ?? "—")}</strong><span>${escapeHtml(event.mine.reason)}</span></td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        ` : `<div class="empty-state compact">还没有可展示的执行记录。</div>`}
      </div>
    </details>
  `;
}

function rowCell(row, key) {
  const view = row[`${key}_view`];
  if (view && typeof view === "object") return displayValue(view);
  const value = row[key];
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function recordTable(title, rows, columns, actionRenderer = null) {
  if (!rows?.length) return `<section class="record-section"><h3>${escapeHtml(title)}</h3><p class="empty-inline">暂无记录</p></section>`;
  const actionHeader = actionRenderer ? "<th>操作</th>" : "";
  return `
    <section class="record-section">
      <h3>${escapeHtml(title)} <small>${rows.length}</small></h3>
      <div class="record-scroll"><table class="record-table"><thead><tr>${columns.map(([key, label]) => `<th>${escapeHtml(label)}</th>`).join("")}${actionHeader}</tr></thead>
      <tbody>${rows.slice(0, 30).map((row) => `<tr>${columns.map(([key]) => `<td>${escapeHtml(rowCell(row, key))}</td>`).join("")}${actionRenderer ? `<td>${actionRenderer(row)}</td>` : ""}</tr>`).join("")}</tbody></table></div>
    </section>
  `;
}

function domainDetails(snapshot) {
  const paper = snapshot?.paper;
  const live = snapshot?.live;
  const runtime = snapshot?.runtime;
  const liveExecutionAvailable = live?.capability?.execution === "AVAILABLE";
  const liveOrderManagementAvailable = live?.capability?.orderManagement === "AVAILABLE";
  const retryableExecutionStates = new Set(["WAITING_EXECUTION", "EXIT_PENDING", "STOP_EXIT_PENDING"]);
  return `
    <details class="fold-panel domain-panel reveal" data-panel-id="backend" style="--delay: 440ms">
      <summary>
        <span class="fold-title"><i class="fold-icon">▦</i><strong>后台明细</strong></span>
        <span class="fold-summary">信号 · 市场 · 风险 · 账本 · 日志 · 恢复</span>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </summary>
      <div class="fold-content domain-content">
        <div class="domain-counts">
          ${[
            ["Signals", snapshot?.signals?.length ?? 0],
            ["Markets", snapshot?.markets?.length ?? 0],
            ["Risk", snapshot?.riskDecisions?.length ?? 0],
            ["Paper Orders", paper?.orders?.length ?? 0],
            ["Paper Fills", paper?.fills?.length ?? 0],
            ["Paper Positions", paper?.positions?.length ?? 0],
            ["Live Executions", live?.executions?.length ?? 0],
            ["Live Orders", live?.orders?.length ?? 0],
            ["Live Fills", live?.fills?.length ?? 0],
            ["Live Quarantine", live?.quarantines?.length ?? 0],
            ["Live Recovery", live?.recovery?.length ?? 0],
            ["Audit", live?.audit?.length ?? 0],
          ].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}
        </div>
        ${recordTable("Observe 运行", runtime?.observe ? [runtime.observe] : [], [["state", "状态"], ["startedAt", "开始"], ["lastHeartbeatAt", "心跳"], ["processedEvents", "事件"], ["emittedSignals", "Signal"], ["stopReason", "停止原因"]])}
        ${recordTable("最新轮询", runtime?.latestPoll ? [runtime.latestPoll] : [], [["sequence", "序号"], ["status", "状态"], ["completedAt", "完成时间"], ["newEvents", "新事件"], ["signalsEmitted", "Signal"], ["errorDetail", "错误"]])}
        ${recordTable("Campaign", runtime?.campaign ? [runtime.campaign] : [], [["campaign_id", "Campaign"], ["state", "状态"], ["created_at", "创建时间"]])}
        ${recordTable("目标对账异常", runtime?.reconciliation?.openIssues, [["issue_type", "类型"], ["sync_status", "同步"], ["status", "状态"], ["created_at", "时间"], ["resolved_at", "解决时间"]])}
        ${recordTable("Signals", snapshot?.signals, [["signal_type", "动作"], ["status", "状态"], ["target_price_units", "目标价格"], ["target_size_micros", "目标数量"], ["reason", "原因"]])}
        ${recordTable("市场数据", snapshot?.markets, [["question", "问题"], ["slug", "Slug"], ["condition_id", "Condition"], ["market_end_time", "结束时间"], ["market_end_time_status", "时间状态"]])}
        ${recordTable("风险决定", snapshot?.riskDecisions, [["executor_mode", "模式"], ["decision", "决定"], ["requested_amount_micros", "金额"], ["risk_reason", "原因"], ["created_at", "时间"]])}
        ${recordTable("Paper 执行", paper?.executions, [["execution_type", "类型"], ["state", "状态"], ["requested_amount_micros", "请求金额"], ["filled_notional_micros", "成交金额"], ["fee_micros", "手续费"], ["reason", "原因"]])}
        ${recordTable("Paper 订单", paper?.orders, [["side", "方向"], ["state", "状态"], ["vwap_price_units", "VWAP"], ["filled_notional_micros", "成交金额"], ["reject_reason", "拒绝原因"]])}
        ${recordTable("Paper 成交", paper?.fills, [["side", "方向"], ["price_units", "价格"], ["size_micros", "数量"], ["notional_micros", "金额"], ["created_at", "时间"]])}
        ${recordTable("Paper 持仓", paper?.positions, [["outcome", "结果"], ["status", "状态"], ["entry_price_units", "开仓价"], ["current_size_micros", "当前数量"], ["realized_pnl_micros", "已实现盈亏"]])}
        ${recordTable("Paper 资金账本", paper?.ledger?.cash, [["entry_type", "类型"], ["cash_delta_micros", "现金变化"], ["cash_after_micros", "现金余额"], ["created_at", "时间"]])}
        ${recordTable("Paper 手续费", paper?.ledger?.fees, [["paper_execution_id", "执行"], ["fee_micros", "手续费"], ["created_at", "时间"]])}
        ${recordTable("Paper 盈亏账本", paper?.ledger?.pnl, [["pnl_type", "类型"], ["proceeds_micros", "收入"], ["cost_basis_micros", "成本"], ["pnl_micros", "盈亏"], ["created_at", "时间"]])}
        ${recordTable("Live Gate", live?.gateRuns, [["run_type", "检查"], ["allowed", "允许"], ["execution_mode", "模式"], ["live_gate_state", "Gate"], ["created_at", "时间"]])}
        ${recordTable("Live 账户", live?.accounts, [["name", "账户"], ["status", "状态"], ["initial_bankroll_micros", "初始资金"], ["risk_budget_micros", "风险预算"], ["authorized_signer_address", "Signer 地址"], ["updated_at", "更新时间"]])}
        ${recordTable("Live 执行", live?.executions, [["execution_type", "类型"], ["state", "状态"], ["requested_amount_micros", "请求金额"], ["filled_notional_micros", "成交金额"], ["attempt_count", "尝试"], ["reason", "原因"]], (row) => {
          const retryable = retryableExecutionStates.has(String(row.state ?? ""));
          if (!retryable) return '<span class="table-action-note">无需重试</span>';
          return `<button class="table-action-button" type="button" data-live-execution-retry="${escapeHtml(row.live_execution_id)}"
            ${disabledAttr(!liveExecutionAvailable, "Live Executor 未配置")}>重试</button>`;
        })}
        ${recordTable("Live 订单", live?.orders, [["side", "方向"], ["status", "状态"], ["price_units", "价格"], ["filled_notional_micros", "成交金额"], ["external_order_id", "外部订单"]], (row) => {
          const terminal = Number(row.is_terminal) === 1;
          if (terminal) return '<span class="table-action-note">已终态</span>';
          return `<button class="table-action-button danger" type="button" data-live-order-cancel="${escapeHtml(row.live_order_id)}"
            ${disabledAttr(!liveOrderManagementAvailable, "Live 订单管理运行时未配置")}>取消</button>`;
        })}
        ${recordTable("Live 订单尝试", live?.attempts, [["action", "动作"], ["status", "状态"], ["attempt_sequence", "次数"], ["error_reason", "错误"], ["created_at", "时间"]])}
        ${recordTable("Live 成交", live?.fills, [["side", "方向"], ["fill_price_units", "价格"], ["fill_size_micros", "数量"], ["fill_notional_micros", "金额"], ["created_at", "时间"]])}
        ${recordTable("Live 持仓", live?.positions, [["outcome", "结果"], ["status", "状态"], ["entry_price_units", "开仓价"], ["current_size_micros", "当前数量"], ["realized_pnl_micros", "盈亏"]])}
        ${recordTable("Live 现金账本", live?.ledger?.cash, [["entry_type", "类型"], ["cash_delta_micros", "现金变化"], ["reserved_delta_micros", "保留变化"], ["cash_after_micros", "现金余额"], ["created_at", "时间"]])}
        ${recordTable("Live 手续费账本", live?.ledger?.fees, [["live_execution_id", "执行"], ["fee_source", "来源"], ["fee_micros", "手续费"], ["created_at", "时间"]])}
        ${recordTable("Live 盈亏账本", live?.ledger?.pnl, [["pnl_type", "类型"], ["proceeds_micros", "收入"], ["cost_basis_micros", "成本"], ["pnl_micros", "盈亏"], ["created_at", "时间"]])}
        ${recordTable("Live 估值", live?.valuations, [["valuation_status", "状态"], ["total_equity_micros", "总权益"], ["available_balance_micros", "可用现金"], ["position_value_micros", "持仓价值"], ["created_at", "时间"]])}
        ${recordTable("Live 对账", live?.reconciliation, [["status", "状态"], ["checks_json", "检查"], ["created_at", "时间"]])}
        ${recordTable("恢复记录", live?.recovery, [["status", "状态"], ["recovered_open_orders", "订单"], ["recovered_fills", "成交"], ["recovered_positions", "持仓"], ["reason", "原因"]])}
        ${recordTable("Live 隔离异常", live?.quarantines, [["signal_sequence", "序号"], ["failure_stage", "阶段"], ["reason", "原因"], ["risk_decision_id", "风控决定"], ["created_at", "时间"]])}
        ${recordTable("审计日志", live?.audit, [["timestamp", "时间"], ["action", "动作"], ["reason", "原因"], ["metadata_json", "元数据"]])}
        ${recordTable("运行日志索引", runtime?.logs, [["name", "文件"], ["updatedAt", "更新时间"], ["sizeBytes", "大小"]])}
        ${recordTable("报告索引", runtime?.reports, [["name", "文件"], ["updatedAt", "更新时间"], ["sizeBytes", "大小"]])}
      </div>
    </details>
  `;
}

function loadingView() {
  return `<main class="page"><section class="empty-state loading-state"><span class="loading-dot"></span><strong>正在读取后台状态</strong><span>仅从 localhost 控制面加载</span></section></main>`;
}

function errorView() {
  return `<main class="page"><section class="empty-state error-state"><strong>后台暂时不可用</strong><span>${escapeHtml(state.error ?? "未知错误")}</span><button class="secondary-button" id="retry-button" type="button">重新连接</button></section></main>`;
}

function shutdownView() {
  return `
    <main class="page shutdown-page">
      <section class="empty-state shutdown-state">
        ${logo()}
        <strong>Hecatonchires 已安全关闭</strong>
        <span>Live 已停用，后台服务正在退出。下次使用时，双击桌面的 Hecatonchires.command 即可。</span>
      </section>
    </main>
  `;
}

function render() {
  const app = document.querySelector("#app");
  for (const panel of app.querySelectorAll("details[data-panel-id]")) {
    const panelId = panel.dataset.panelId;
    if (!panelId) continue;
    if (panel.open) state.openPanels.add(panelId);
    else state.openPanels.delete(panelId);
  }
  if (state.shuttingDown) {
    app.innerHTML = shutdownView();
    return;
  }
  if (state.loading) {
    app.innerHTML = loadingView();
    return;
  }
  if (state.error && !state.snapshot) {
    app.innerHTML = errorView();
    document.querySelector("#retry-button")?.addEventListener("click", () => refresh());
    return;
  }
  const snapshot = state.snapshot;
  const initialContentRender = !state.hasRenderedContent;
  app.innerHTML = `
    <div class="app-shell${initialContentRender ? "" : " refresh-render"}">
      ${header(snapshot)}
      <main class="page">
        ${state.notice ? `<div class="ui-notice ${state.notice.kind}"><strong>${escapeHtml(state.notice.title)}</strong><span>${escapeHtml(state.notice.message)}</span></div>` : ""}
        ${overview(snapshot)}
        ${settingsPanel(snapshot)}
        ${runtimePanel(snapshot)}
        ${livePanel(snapshot)}
        <div class="feed-heading reveal" style="--delay: 145ms">
          <div><h1>跟单记录</h1><p>目标交易与我的执行结果</p></div>
          <span>${escapeHtml(snapshot.comparisons.length ? `${snapshot.comparisons.length} 条` : "暂无记录")}</span>
        </div>
        <div class="trade-list">${snapshot.comparisons.length
          ? snapshot.comparisons.map(eventCard).join("")
          : `<div class="empty-state compact">后台还没有目标事件，出现 Signal 后会在这里对照展示。</div>`}</div>
        ${executionDetails(snapshot)}
        ${domainDetails(snapshot)}
      </main>
    </div>
  `;
  for (const panel of app.querySelectorAll("details[data-panel-id]")) {
    panel.open = state.openPanels.has(panel.dataset.panelId);
  }
  bindEvents();
  state.hasRenderedContent = true;
  state.lastRenderKey = window.HecatonchiresUiState.snapshotRenderKey(snapshot);
}

async function api(path, init = {}) {
  const requestInit = { ...init };
  const timeoutMs = requestInit.timeoutMs;
  delete requestInit.timeoutMs;
  const controller = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? new AbortController()
    : null;
  const timeout = controller === null
    ? null
    : window.setTimeout(() => controller.abort(), timeoutMs);
  if (!requestInit.method && requestInit.body !== undefined) requestInit.method = "POST";
  let response;
  try {
    response = await fetch(path, {
      cache: "no-store",
      ...requestInit,
      ...(controller === null ? {} : { signal: controller.signal }),
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("后台响应超时");
    throw error;
  } finally {
    if (timeout !== null) window.clearTimeout(timeout);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`HTTP_${response.status}`);
  }
  if (!response.ok || payload.ok !== true) {
    const error = payload.error ?? {};
    const failure = new Error(error.message ?? `HTTP_${response.status}`);
    failure.code = error.code;
    failure.details = error.details;
    throw failure;
  }
  return payload.data;
}

function updateHeaderStatus() {
  const element = document.querySelector('[data-role="backend-status"]');
  if (!element) return;
  const text = element.querySelector("span");
  if (text) text.textContent = statusText(state.snapshot);
  element.classList.toggle(
    "warning",
    Boolean(state.error) || state.snapshot?.runtime?.state === "RECOVERY_REQUIRED",
  );
}

function refreshInteractionActive() {
  return Boolean(
    state.busy
    || state.walletFlowActive
    || document.querySelector("#modal-backdrop")
    || document.activeElement?.matches(
      "#target-input, #settings-form input, #live-config-form input, #live-config-form select",
    ),
  );
}

async function refresh(silent = false) {
  if (state.shuttingDown) return;
  if (state.refreshing) return;
  if (!silent) state.loading = state.snapshot === null;
  state.refreshing = true;
  if (!state.snapshot) render();
  let renderRequired = !silent || !state.hasRenderedContent;
  let serviceReplaced = false;
  try {
    const data = await api("/api/operator/snapshot", {
      method: "GET",
      headers: {},
      timeoutMs: 8_000,
    });
    if (
      window.HecatonchiresUiState.serviceInstanceChanged(
        state.serviceInstanceId,
        data,
      )
    ) {
      serviceReplaced = true;
      window.location.reload();
      return;
    }
    state.serviceInstanceId = data?.service?.instanceId ?? state.serviceInstanceId;
    renderRequired = renderRequired
      || window.HecatonchiresUiState.snapshotRenderKey(data) !== state.lastRenderKey;
    state.snapshot = data;
    state.error = null;
    if (state.snapshot?.live?.walletSession?.status === "CONNECTED") startWalletRequestWorker();
  } catch (error) {
    state.error = error.message;
    renderRequired = state.snapshot === null;
  } finally {
    state.loading = false;
    state.refreshing = false;
    if (serviceReplaced) return;
    if (renderRequired && (!silent || !refreshInteractionActive())) render();
    else updateHeaderStatus();
  }
}

function discoverWalletProvider() {
  const discovery = window.HecatonchiresWalletProvider;
  if (typeof discovery?.discover === "function") {
    return discovery.discover({ timeoutMs: 3_000 });
  }
  return Promise.resolve(window.okxwallet?.ethereum ?? window.okxwallet ?? window.ethereum);
}

function walletFlow() {
  const flow = window.HecatonchiresWalletFlow;
  if (!flow) throw new Error("WALLET_FLOW_HELPERS_UNAVAILABLE");
  return flow;
}

function setWalletProgress(title, message) {
  state.notice = { kind: "processing", title, message };
  render();
}

function setNotice(kind, title, message) {
  state.notice = { kind, title, message };
  window.setTimeout(() => {
    if (state.notice?.title === title) {
      state.notice = null;
      render();
    }
  }, 4200);
}

async function runAction(label, path, init = {}, options = {}) {
  state.busy = label;
  state.notice = { kind: "processing", title: "处理中", message: label };
  render();
  try {
    const data = await api(path, init);
    if (data.snapshot) state.snapshot = data.snapshot;
    state.error = null;
    setNotice("success", "已完成", options.success ?? label);
    return data;
  } catch (error) {
    const reason = typeof options.formatError === "function"
      ? options.formatError(error)
      : error.details?.blockedReasons?.join("、") ?? error.message;
    setNotice("error", "操作未执行", reason);
    throw error;
  } finally {
    state.busy = null;
    render();
  }
}

async function applyTarget() {
  const input = document.querySelector("#target-input");
  const feedback = document.querySelector("#target-feedback");
  const value = input.value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    feedback.textContent = "地址格式不正确";
    feedback.className = "invalid";
    input.classList.add("invalid");
    return;
  }
  try {
    await runAction("保存目标地址", "/api/operator/target", {
      method: "PUT",
      body: JSON.stringify({ walletAddress: value }),
    }, { success: "目标地址已保存，下一轮按新目标执行。" });
    input.classList.remove("invalid");
  } catch {
    feedback.textContent = "保存失败";
    feedback.className = "invalid";
    return;
  }
  feedback.textContent = "地址已确认";
  feedback.className = "confirmed";
}

function collectSettings(form) {
  const overrides = {};
  const keys = state.snapshot?.control?.controls?.parameters?.editableKeys ?? [];
  for (const key of keys) {
    if (!SETTING_META[key]) continue;
    const field = form.elements[key];
    if (!field || field.value === "") continue;
    const value = fromDisplayRule(key, field.value);
    if (!Number.isSafeInteger(value)) throw new Error(`${key} 不是有效数字`);
    overrides[key] = value;
  }
  return overrides;
}

async function saveSettings(event) {
  event.preventDefault();
  try {
    const overrides = collectSettings(event.currentTarget);
    await runAction("保存跟单设置", "/api/operator/ruleset", {
      method: "PUT",
      body: JSON.stringify({ name: "Hecatonchires Operator", overrides }),
    }, { success: "参数已保存，下一轮 Campaign 按新参数执行。" });
  } catch (error) {
    setNotice("error", "参数未保存", error.message);
  }
}

async function restoreDefaults() {
  try {
    await runAction("恢复默认参数", "/api/operator/ruleset", {
      method: "DELETE",
    }, { success: "已恢复后台默认参数。" });
  } catch {
    // runAction already surfaces the backend reason.
  }
}

function clearWalletProviderBinding() {
  state.walletProviderCleanup?.();
  state.walletProviderCleanup = null;
}

async function invalidateConnectedWallet(message) {
  if (state.busy === "断开失效钱包") return;
  const sessionId = state.snapshot?.live?.walletSession?.sessionId;
  state.walletWorkerGeneration += 1;
  state.walletWorkerSessionId = null;
  clearWalletProviderBinding();
  state.walletProvider = null;
  if (!sessionId) {
    setNotice("error", "钱包会话已失效", message);
    return;
  }
  state.busy = "断开失效钱包";
  try {
    const data = await api("/api/operator/live/wallet-session/disconnect", {
      body: JSON.stringify({ sessionId }),
    });
    if (data.snapshot) state.snapshot = data.snapshot;
  } catch {
    // The next snapshot remains authoritative if the old session already expired.
  } finally {
    state.busy = null;
    setNotice("error", "钱包会话已失效", `${message} 请重新连接钱包。`);
    render();
  }
}

function bindWalletProvider(provider) {
  clearWalletProviderBinding();
  if (typeof provider?.on !== "function") return;
  const accountsChanged = (accounts) => {
    const expected = state.snapshot?.live?.walletSession?.walletAddress?.toLowerCase();
    const actual = Array.isArray(accounts) && typeof accounts[0] === "string"
      ? accounts[0].toLowerCase()
      : null;
    if (expected && actual !== expected) {
      void invalidateConnectedWallet("OKX 当前账户已经变化。");
    }
  };
  const chainChanged = (chainId) => {
    const parsed = typeof chainId === "string" && /^0x[0-9a-f]+$/i.test(chainId)
      ? Number.parseInt(chainId, 16)
      : Number.NaN;
    if (state.snapshot?.live?.walletSession?.status === "CONNECTED" && parsed !== 137) {
      void invalidateConnectedWallet("OKX 已离开 Polygon 主网。");
    }
  };
  const disconnected = () => {
    if (state.snapshot?.live?.walletSession?.status === "CONNECTED") {
      void invalidateConnectedWallet("OKX 已断开当前网页。");
    }
  };
  provider.on("accountsChanged", accountsChanged);
  provider.on("chainChanged", chainChanged);
  provider.on("disconnect", disconnected);
  state.walletProviderCleanup = () => {
    if (typeof provider.removeListener !== "function") return;
    provider.removeListener("accountsChanged", accountsChanged);
    provider.removeListener("chainChanged", chainChanged);
    provider.removeListener("disconnect", disconnected);
  };
}

async function connectLiveWallet() {
  if (state.walletFlowActive) return false;
  state.walletFlowActive = true;
  state.busy = "连接钱包";
  state.notice = { kind: "processing", title: "正在检查 OKX", message: "正在确认钱包扩展和既有授权状态。" };
  render();
  try {
    const flow = walletFlow();
    const coordinated = await flow.runExclusive(
      window.navigator?.locks ?? null,
      "hecatonchires:wallet-connect",
      async () => {
        const provider = await discoverWalletProvider();
        if (!provider || typeof provider.request !== "function") {
          throw new Error(
            "当前页面没有收到 OKX 钱包。请确认扩展已启用，然后只保留一个 Hecatonchires 页面并刷新重试。",
          );
        }
        state.walletProvider = provider;

        let accounts = [];
        try {
          accounts = await flow.requestWithTimeout(
            provider,
            { method: "eth_accounts" },
            { timeoutMs: 10_000, label: "读取已授权账户" },
          );
        } catch {
          // The explicit connection request below remains authoritative if a
          // read-only probe races with an extension wake-up.
        }
        let walletAddress = flow.firstValidAddress(accounts);
        if (!walletAddress) {
          setWalletProgress(
            "等待 OKX 连接确认",
            "请在 OKX 中确认把当前账户连接到 Hecatonchires；这一步不会签名或移动资金。",
          );
          accounts = await flow.requestWithTimeout(
            provider,
            { method: "eth_requestAccounts" },
            { timeoutMs: 90_000, label: "连接钱包" },
          );
          walletAddress = flow.firstValidAddress(accounts);
        } else {
          setWalletProgress(
            "已识别 OKX 账户",
            "本站已有连接授权，因此不会重复弹出连接窗口；下一步只会请求身份签名。",
          );
        }
        if (!walletAddress) throw new Error("钱包没有返回有效地址");

        let chainId = await flow.requestWithTimeout(
          provider,
          { method: "eth_chainId" },
          { timeoutMs: 10_000, label: "读取钱包网络" },
        );
        const parsedChainId = typeof chainId === "string" && /^0x[0-9a-f]+$/i.test(chainId)
          ? Number.parseInt(chainId, 16)
          : Number.NaN;
        if (parsedChainId !== 137) {
          setWalletProgress("等待网络切换", "请在 OKX 中确认切换到 Polygon 主网。");
          await flow.requestWithTimeout(
            provider,
            {
              method: "wallet_switchEthereumChain",
              params: [{ chainId: "0x89" }],
            },
            { timeoutMs: 90_000, label: "切换 Polygon 主网" },
          );
          chainId = await flow.requestWithTimeout(
            provider,
            { method: "eth_chainId" },
            { timeoutMs: 10_000, label: "确认钱包网络" },
          );
          if (
            typeof chainId !== "string"
            || !/^0x[0-9a-f]+$/i.test(chainId)
            || Number.parseInt(chainId, 16) !== 137
          ) {
            throw new Error("请把钱包切换到 Polygon 主网");
          }
        }
        const challenge = await api("/api/operator/live/wallet-session/challenge", {
          body: JSON.stringify({ chainId }),
        });
        setWalletProgress(
          "等待身份签名",
          "请在 OKX 确认 Hecatonchires 身份签名；签名只证明地址控制权，不授权交易或移动资金。",
        );
        const signature = await flow.requestWithTimeout(
          provider,
          {
            method: "personal_sign",
            params: [challenge.message, walletAddress],
          },
          { timeoutMs: 120_000, label: "身份签名" },
        );
        if (typeof signature !== "string" || !signature.startsWith("0x")) {
          throw new Error("钱包没有返回签名");
        }
        const connection = await runAction("连接正式钱包", "/api/operator/live/wallet-session/connect", {
          body: JSON.stringify({
            challengeId: challenge.challengeId,
            walletAddress,
            chainId,
            signature,
          }),
        }, { success: "钱包已连接，Live 签名通道已准备。" });
        if (connection.runtime?.accepted === false) {
          setNotice(
            "success",
            "钱包已连接",
            `身份已证明，但 LiveRuntime 暂未装配：${connection.runtime.code}`,
          );
          render();
        }
        bindWalletProvider(provider);
        startWalletRequestWorker();
      },
    );
    if (!coordinated.acquired) {
      setNotice(
        "error",
        "另一个页面正在连接钱包",
        "请切回已经打开的 Hecatonchires 页面完成 OKX 确认；本页没有重复发送请求。",
      );
      return false;
    }
    return state.snapshot?.live?.walletSession?.status === "CONNECTED";
  } catch (error) {
    setNotice("error", "钱包未连接", walletFlow().walletErrorMessage(error));
    return false;
  } finally {
    state.walletFlowActive = false;
    state.busy = null;
    render();
  }
}

async function disconnectLiveWallet() {
  const sessionId = state.snapshot?.live?.walletSession?.sessionId;
  if (!sessionId) return;
  try {
    state.walletWorkerGeneration += 1;
    state.walletWorkerSessionId = null;
    if (state.walletWorkerRetryTimer !== null) {
      window.clearTimeout(state.walletWorkerRetryTimer);
      state.walletWorkerRetryTimer = null;
    }
    await runAction("断开钱包", "/api/operator/live/wallet-session/disconnect", {
      body: JSON.stringify({ sessionId }),
    }, { success: "钱包会话已断开，Live 继续保持禁用。" });
    clearWalletProviderBinding();
    state.walletProvider = null;
  } catch {
    // runAction already surfaces the backend reason.
  }
}

async function requestSafeShutdown() {
  state.busy = "安全退出";
  state.notice = { kind: "processing", title: "正在安全退出", message: "正在停用 Live 并关闭后台服务。" };
  render();
  try {
    await api("/api/operator/service/shutdown", {
      body: JSON.stringify({ actor: "LOCAL_OPERATOR", reason: "UI_SAFE_EXIT" }),
    });
    state.shuttingDown = true;
    if (state.refreshTimer !== null) window.clearInterval(state.refreshTimer);
    state.walletWorkerGeneration += 1;
    state.walletWorkerSessionId = null;
    if (state.walletWorkerRetryTimer !== null) window.clearTimeout(state.walletWorkerRetryTimer);
    clearWalletProviderBinding();
    state.walletProvider = null;
    render();
  } catch (error) {
    state.busy = null;
    setNotice("error", "安全退出未完成", error.message);
    render();
  }
}

async function saveLiveConfiguration(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const tradingWalletAddress = form.elements.tradingWalletAddress.value.trim();
    const body = {
      signatureType: form.elements.signatureType.value,
      ...(tradingWalletAddress ? { tradingWalletAddress } : {}),
      liveBankrollMicros: pusdToMicros(form.elements.liveBankroll.value, "Live 资金上限"),
      maxTradeSizeMicros: pusdToMicros(form.elements.maxTradeSize.value, "单笔上限"),
      maxExposureMicros: pusdToMicros(form.elements.maxExposure.value, "总敞口上限"),
      maxDailyLossMicros: pusdToMicros(form.elements.maxDailyLoss.value, "单日亏损上限"),
      confirmLimits: true,
      acceptCompliance: form.elements.acceptCompliance.checked,
    };
    const result = await runAction("保存 Live 风险参数", "/api/operator/live/configuration", {
      method: "PUT",
      body: JSON.stringify(body),
    }, { success: "" });
    if (result.reconnectRequired) {
      setNotice(
        "success",
        "Live 参数已保存",
        "实际限额或钱包身份已变化，旧运行时已安全断开；重新连接一次即可应用。",
      );
    } else {
      setNotice(
        "success",
        "Live 参数已保存",
        "参数已保存；如果钱包已经连接，不需要重新连接。",
      );
    }
    render();
  } catch (error) {
    setNotice("error", "Live 参数未保存", error.message);
  }
}

function walletRequestError(error) {
  if (error && typeof error === "object") {
    return String(error.message ?? error.code ?? "钱包拒绝了请求");
  }
  return String(error ?? "钱包拒绝了请求");
}

async function completeWalletRequest(sessionId, requestId, result) {
  await api("/api/operator/live/wallet-requests/complete", {
    body: JSON.stringify({ sessionId, requestId, ...result }),
  });
}

async function processWalletRequest(provider, session, request) {
  const flow = walletFlow();
  const activeChainId = await flow.requestWithTimeout(
    provider,
    { method: "eth_chainId" },
    { timeoutMs: 10_000, label: "确认钱包网络" },
  );
  const parsedChainId = typeof activeChainId === "string" && /^0x[0-9a-f]+$/i.test(activeChainId)
    ? Number.parseInt(activeChainId, 16)
    : Number.NaN;
  if (parsedChainId !== request.chainId || parsedChainId !== session.chainId) {
    throw new Error("钱包网络已变化，请切回 Polygon 主网");
  }
  const accounts = await flow.requestWithTimeout(
    provider,
    { method: "eth_accounts" },
    { timeoutMs: 10_000, label: "确认钱包账户" },
  );
  const activeAddress = flow.firstValidAddress(accounts);
  if (typeof activeAddress !== "string"
    || activeAddress.toLowerCase() !== request.walletAddress.toLowerCase()
    || activeAddress.toLowerCase() !== session.walletAddress.toLowerCase()) {
    throw new Error("钱包账户已变化，请重新连接");
  }
  const result = await flow.requestWithTimeout(
    provider,
    { method: request.method, params: request.params },
    { timeoutMs: 120_000, label: request.purpose },
  );
  if (typeof result !== "string") throw new Error("钱包没有返回有效结果");
  await completeWalletRequest(session.sessionId, request.requestId, { result });
}

async function walletRequestWorker(generation) {
  const provider = state.walletProvider ?? await discoverWalletProvider();
  if (provider && typeof provider.request === "function") {
    state.walletProvider = provider;
    bindWalletProvider(provider);
  }
  while (generation === state.walletWorkerGeneration) {
    const session = state.snapshot?.live?.walletSession;
    if (!provider || typeof provider.request !== "function" || session?.status !== "CONNECTED") return;
    try {
      const data = await api(
        `/api/operator/live/wallet-requests/next?sessionId=${encodeURIComponent(session.sessionId)}`,
        { method: "GET", headers: {} },
      );
      if (!data.request) {
        await new Promise((resolve) => window.setTimeout(resolve, 700));
        continue;
      }
      try {
        await processWalletRequest(provider, session, data.request);
        setNotice("success", "钱包操作已确认", data.request.purpose);
      } catch (error) {
        await completeWalletRequest(session.sessionId, data.request.requestId, {
          error: walletRequestError(error),
        }).catch(() => undefined);
        setNotice("error", "钱包操作未完成", walletRequestError(error));
      }
    } catch (error) {
      if (error.code === "LIVE_WALLET_SESSION_INVALIDATED"
        || error.code === "LIVE_WALLET_SESSION_NOT_FOUND") return;
      await new Promise((resolve) => window.setTimeout(resolve, 1_200));
    }
  }
}

function startWalletRequestWorker() {
  const sessionId = state.snapshot?.live?.walletSession?.sessionId;
  if (!sessionId || state.walletWorkerSessionId === sessionId) return;
  if (state.walletWorkerRetryTimer !== null) {
    window.clearTimeout(state.walletWorkerRetryTimer);
    state.walletWorkerRetryTimer = null;
  }
  state.walletWorkerGeneration += 1;
  state.walletWorkerSessionId = sessionId;
  const generation = state.walletWorkerGeneration;
  void walletFlow().runExclusive(
    window.navigator?.locks ?? null,
    `hecatonchires:wallet-worker:${sessionId}`,
    () => walletRequestWorker(generation),
  ).finally(() => {
    if (generation !== state.walletWorkerGeneration) return;
    state.walletWorkerSessionId = null;
    if (state.snapshot?.live?.walletSession?.sessionId === sessionId) {
      state.walletWorkerRetryTimer = window.setTimeout(() => {
        state.walletWorkerRetryTimer = null;
        startWalletRequestWorker();
      }, 1_500);
    }
  });
}

function activationFailureReason(error) {
  const details = error?.details ?? {};
  const stageLabels = {
    GATE: "Gate",
    RECONCILIATION: "Live 对账",
    WALLET: "钱包授权",
    GATE_REFRESH: "最终 Gate",
    CONFIRMATION: "最终确认",
    RUNTIME_START: "Live 启动",
  };
  const stage = stageLabels[details.stage] ?? "Live 准备";
  const reason = details.reason
    ?? details.result?.details?.reason
    ?? details.result?.code
    ?? details.blockedReasons?.[0]
    ?? error?.message
    ?? "未知原因";
  return `${stage}未通过：${reason}`;
}

async function activateLive() {
  try {
    if (state.snapshot?.live?.walletSession?.status !== "CONNECTED") {
      const connected = await connectLiveWallet();
      if (!connected) return;
    }
    await runAction("一键切换 Live", "/api/operator/live/activate", {
      body: JSON.stringify({
        actor: "LOCAL_OPERATOR",
        reason: "UI_ONE_CLICK_LIVE",
        confirmationText: "ENABLE LIVE TRADING",
      }),
    }, {
      success: "Live 已启动；Gate、对账、钱包准备和运行时均已通过。",
      formatError: activationFailureReason,
    });
  } catch (error) {
    showModal(
      "仍保持 PAPER",
      `<p>${escapeHtml(activationFailureReason(error))}</p>`,
      "失败步骤已经自动回滚，不需要重新保存参数。",
      "知道了",
    );
  }
}

function showModeModal() {
  const mode = currentMode(state.snapshot);
  if (mode === "LIVE") {
    showModal(
      "切回 PAPER",
      `<div class="mode-preview"><span class="current"><i></i>LIVE</span><svg viewBox="0 0 20 20"><path d="m6 4 6 6-6 6" /></svg><span>PAPER</span></div><p>切回 Paper 会先执行 Live Gate 紧急停用，后台状态才是最终结果。</p>`,
      "切换需要二次确认。",
      "确认切回 PAPER",
      async () => {
        try {
          await runAction("停用 Live Gate", "/api/operator/live/emergency-disable", {
            body: JSON.stringify({ actor: "LOCAL_OPERATOR", reason: "UI_SWITCH_TO_PAPER" }),
          }, { success: "已切回 PAPER。" });
        } catch {
          // Authoritative error already shown.
        }
      },
    );
    return;
  }
  const config = state.snapshot?.live?.production?.config;
  const limits = [
    `资金 ${microsToPusd(config?.liveBankrollMicros) || "—"} pUSD`,
    `单笔 ${microsToPusd(config?.maxTradeSizeMicros) || "—"} pUSD`,
    `总敞口 ${microsToPusd(config?.maxExposureMicros) || "—"} pUSD`,
    `单日止损 ${microsToPusd(config?.maxDailyLossMicros) || "—"} pUSD`,
  ].join(" · ");
  showModal(
    "切换到 LIVE",
    `<div class="mode-preview"><span class="current"><i></i>PAPER</span><svg viewBox="0 0 20 20"><path d="m6 4 6 6-6 6" /></svg><span>LIVE</span></div><p>确认后系统会自动连接钱包、检查 Gate、完成 Live 对账、检查必要授权并启动；缺少条件时自动回到 Paper。</p><p><strong>${escapeHtml(limits)}</strong></p>`,
    "OKX 仍可能要求确认身份签名或链上授权；系统不会读取私钥，也不会跳过官方地域检查。",
    "确认并切换 LIVE",
    activateLive,
  );
}

async function actionClick(action, input = {}) {
  const mode = String(input.mode ?? currentMode(state.snapshot)).toUpperCase();
  if (action === "runtime-start") await runAction(`启动 ${mode}`, "/api/operator/runtime/start", { body: JSON.stringify({ mode, actor: "LOCAL_OPERATOR", reason: "UI_RUNTIME_START" }) }, { success: `${mode} 启动请求已提交，页面会持续刷新状态。` });
  if (action === "runtime-stop") await runAction(`安全暂停 ${mode}`, "/api/operator/runtime/stop", { body: JSON.stringify({ mode, actor: "LOCAL_OPERATOR", reason: "UI_RUNTIME_STOP" }) }, { success: `${mode} 安全暂停请求已提交。` });
  if (action === "runtime-recover") await runAction(`恢复 ${mode}`, "/api/operator/runtime/recover", { body: JSON.stringify({ mode, actor: "LOCAL_OPERATOR", reason: "UI_RUNTIME_RECOVER" }) }, { success: `${mode} 恢复请求已提交。` });
  if (action === "live-preflight") await runAction("检查 Live Gate", "/api/operator/live/preflight", { body: "{}" }, { success: "Live Gate 检查完成。" });
  if (action === "live-recover") await runAction("恢复 Live Gate", "/api/operator/live/recover", { body: "{}" }, { success: "Live Gate 恢复检查完成。" });
  if (action === "live-wallet-connect") await connectLiveWallet();
  if (action === "live-wallet-disconnect") await disconnectLiveWallet();
  if (action === "service-shutdown") {
    showModal(
      "安全退出 Hecatonchires",
      "<p>程序会先停用 Live、断开当前钱包会话，再关闭本机后台服务。</p>",
      "下次使用只需再次双击桌面的 Hecatonchires.command。",
      "确认退出",
      requestSafeShutdown,
    );
  }
  if (action === "live-activate") showModeModal();
  if (action === "live-wallet-setup") {
    showModal(
      "设置交易授权",
      "<p>系统会先检查 Exchange V3 的 pUSD 与仓位授权；只有额度不足时才请求钱包发送链上交易。pUSD 授权金额不会超过已确认的 Live 资金上限。</p>",
      "钱包可能连续显示两次交易确认。每笔都必须由你在钱包中单独批准。",
      "开始检查",
      async () => {
        closeModal();
        await runAction("设置钱包交易授权", "/api/operator/live/wallet-setup", {
          body: JSON.stringify({ actor: "LOCAL_OPERATOR", reason: "UI_WALLET_ALLOWANCE_SETUP" }),
        }, { success: "交易授权检查完成，额度已刷新。" });
      },
    );
  }
  if (action === "live-disable") {
    showModal("紧急停用 Live", "<p>这会把执行模式切回 PAPER，并记录一条后台审计。</p>", "确认后立即生效。", "确认停用", async () => {
      await runAction("紧急停用 Live", "/api/operator/live/emergency-disable", { body: JSON.stringify({ actor: "LOCAL_OPERATOR", reason: "UI_EMERGENCY_DISABLE" }) }, { success: "Live 已停用。" });
    });
  }
  if (action === "live-reconcile") await runAction("Live 对账检查", "/api/operator/live/reconcile", { body: JSON.stringify({ actor: "LOCAL_OPERATOR", reason: "UI_RECONCILIATION" }) }, { success: "Live 对账请求已提交。" });
}

function bindEvents() {
  document.querySelector("#mode-button")?.addEventListener("click", showModeModal);
  document.querySelector("#apply-target")?.addEventListener("click", applyTarget);
  document.querySelector("#settings-form")?.addEventListener("submit", saveSettings);
  document.querySelector("#settings-default")?.addEventListener("click", restoreDefaults);
  document.querySelector("#live-config-form")?.addEventListener("submit", saveLiveConfiguration);
  document.querySelector("#target-input")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") applyTarget();
  });
  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => actionClick(button.dataset.action, button.dataset).catch(() => undefined));
  });
  document.querySelectorAll("[data-live-order-cancel]").forEach((button) => {
    button.addEventListener("click", () => {
      const orderId = button.dataset.liveOrderCancel;
      showModal(
        "取消 Live 订单",
        `<p>仅当 Live 订单管理运行时已注入且后台校验通过时才会执行。</p><code>${escapeHtml(orderId)}</code>`,
        "该操作会写入审计记录，并以后台返回状态为准。",
        "确认取消",
        async () => {
          await runAction("取消 Live 订单", `/api/operator/live/orders/${encodeURIComponent(orderId)}/cancel`, {
            body: JSON.stringify({ actor: "LOCAL_OPERATOR", reason: "UI_ORDER_CANCEL" }),
          }, { success: "Live 订单取消请求已提交。" });
        },
      );
    });
  });
  document.querySelectorAll("[data-live-execution-retry]").forEach((button) => {
    button.addEventListener("click", () => {
      const executionId = button.dataset.liveExecutionRetry;
      showModal(
        "重试 Live 执行",
        `<p>重试仍会重新经过 Gate、风控、订单和审计链路。</p><code>${escapeHtml(executionId)}</code>`,
        "只有等待中或退出待处理执行可从这里请求重试。",
        "确认重试",
        async () => {
          await runAction("重试 Live 执行", `/api/operator/live/executions/${encodeURIComponent(executionId)}/retry`, {
            body: JSON.stringify({ actor: "LOCAL_OPERATOR", reason: "UI_EXECUTION_RETRY" }),
          }, { success: "Live 执行重试请求已提交。" });
        },
      );
    });
  });
}

function showModal(title, content, note, confirmLabel, onConfirm) {
  document.querySelector("#modal-root").innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <section class="modal" role="dialog" aria-modal="true">
        <h2>${escapeHtml(title)}</h2>
        <div class="modal-content">${content}</div>
        <div class="modal-note">${escapeHtml(note)}</div>
        <div class="modal-actions">
          <button class="secondary-button" id="modal-cancel" type="button">取消</button>
          ${confirmLabel ? `<button class="confirm-button" id="modal-confirm" type="button">${escapeHtml(confirmLabel)}</button>` : ""}
        </div>
      </section>
    </div>
  `;
  document.querySelector("#modal-cancel")?.addEventListener("click", closeModal);
  document.querySelector("#modal-backdrop")?.addEventListener("click", (event) => {
    if (event.target.id === "modal-backdrop") closeModal();
  });
  document.querySelector("#modal-confirm")?.addEventListener("click", () => {
    const callback = onConfirm;
    const modalRoot = document.querySelector("#modal-backdrop");
    callback?.(modalRoot);
    if (modalRoot?.isConnected) closeModal();
  });
}

function closeModal() {
  document.querySelector("#modal-root").innerHTML = "";
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModal();
});

refresh();
state.refreshTimer = window.setInterval(() => refresh(true), 3000);
window.addEventListener("focus", () => refresh(true));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refresh(true);
});
window.setTimeout(() => {
  if (state.snapshot?.live?.walletSession?.status === "CONNECTED") startWalletRequestWorker();
}, 0);
