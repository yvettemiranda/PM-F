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
  if (!snapshot) return "正在连接 · —";
  if (snapshot.database.status === "ERROR") return "后台异常";
  if (snapshot.database.status === "NOT_INITIALIZED") return "等待初始化";
  const runtime = snapshot.runtime.state;
  if (runtime === "RUNNING") return "同步中 · 运行";
  if (runtime === "RECOVERY_REQUIRED") return "需要恢复";
  return `同步正常 · ${formatTime(snapshot.targetRuntime?.updatedAt)}`;
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
          <span class="sync-state ${snapshot?.runtime?.state === "RECOVERY_REQUIRED" ? "warning" : ""}">
            <i></i><span>${escapeHtml(statusText(snapshot))}</span>
          </span>
          <button class="mode-button" id="mode-button" type="button" aria-label="当前模式 ${escapeHtml(mode)}"
            ${disabledAttr(mode !== "LIVE" && !gateAvailable, modeBlockedReason)}>
            <i></i><span>${escapeHtml(mode)}</span>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
          </button>
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
    <details class="fold-panel reveal" style="--delay: 85ms">
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
    ? "Live 运行时未配置"
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
    <details class="fold-panel ops-panel reveal" style="--delay: 105ms">
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
            : "Live 运行时未注入，启动、暂停和恢复均明确禁用。")
          : "Paper 启动/暂停复用桌面入口；恢复只收割经过身份验证的遗留进程，不会启动 Live。")}</p>
      </div>
    </details>
  `;
}

function livePanel(snapshot) {
  const gate = snapshot?.live?.gate;
  const blocked = snapshot?.live?.capability?.externalDependencies ?? [];
  const prerequisites = snapshot?.live?.prerequisites ?? [];
  const gateAvailable = snapshot?.control?.controls?.live?.gateAvailable === true;
  const runtimeConfigured = snapshot?.live?.capability?.execution === "AVAILABLE";
  const gateReason = snapshot?.control?.controls?.live?.blockedReason ?? "Live Gate 尚不可用";
  return `
    <details class="fold-panel ops-panel reveal" style="--delay: 125ms">
      <summary>
        <span class="fold-title"><i class="fold-icon">◆</i><strong>Live 安全状态</strong></span>
        <span class="fold-summary">${escapeHtml(gate ? `${gate.executionMode} · ${gate.state}` : "Gate 等待数据库")}</span>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </summary>
      <div class="fold-content ops-content">
        <div class="gate-banner ${gate?.state === "LIVE_ACTIVE" ? "danger" : ""}">
          <strong>${escapeHtml(gate?.state ?? "LIVE_DISABLED")}</strong>
          <span>${escapeHtml(gate?.reason ?? "Live 当前不会提交真实订单。")}</span>
        </div>
        <div class="prerequisite-list">
          ${prerequisites.length
            ? prerequisites.slice(0, 8).map((item) => `<span class="prerequisite ${item.status === "PASSED" ? "passed" : "blocked"}">${escapeHtml(item.key)} · ${escapeHtml(item.status)}</span>`).join("")
            : `<span class="empty-inline">数据库初始化后显示 Gate 前置条件</span>`}
        </div>
        <div class="ops-actions">
          <button class="secondary-button" data-action="live-preflight" type="button"
            ${disabledAttr(Boolean(state.busy) || !gateAvailable, gateAvailable ? "" : gateReason)}>检查 Gate</button>
          <button class="secondary-button" data-action="live-recover" type="button"
            ${disabledAttr(Boolean(state.busy) || !gateAvailable, gateAvailable ? "" : gateReason)}>恢复 Gate</button>
          <button class="secondary-button" data-action="live-reconcile" type="button"
            ${disabledAttr(Boolean(state.busy) || !runtimeConfigured, runtimeConfigured ? "" : "Live 对账运行时未配置")}>Live 对账</button>
          <button class="secondary-button danger-button" data-action="live-disable" type="button"
            ${disabledAttr(Boolean(state.busy) || gate?.state === "LIVE_DISABLED", "Live 当前已禁用")}>紧急停用 Live</button>
        </div>
        <p class="ops-note">当前未注入 ${escapeHtml(blocked.join("、"))}；Live 执行、订单取消和资金操作会保持明确禁用。</p>
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
      <details class="trade-details">
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
    <details class="fold-panel execution-panel reveal" style="--delay: 420ms">
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
  const retryableExecutionStates = new Set(["FAILED", "FROZEN"]);
  return `
    <details class="fold-panel domain-panel reveal" style="--delay: 440ms">
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

function render() {
  const app = document.querySelector("#app");
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
  app.innerHTML = `
    <div class="app-shell">
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
  bindEvents();
}

async function api(path, init = {}) {
  const requestInit = { ...init };
  if (!requestInit.method && requestInit.body !== undefined) requestInit.method = "POST";
  const response = await fetch(path, {
    cache: "no-store",
    ...requestInit,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
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

async function refresh(silent = false) {
  const activeEditor = silent
    && document.activeElement?.matches("#target-input, #settings-form input");
  if (!silent) state.loading = state.snapshot === null;
  state.refreshing = true;
  if (!state.snapshot) render();
  try {
    const data = await api("/api/operator/snapshot", { method: "GET", headers: {} });
    state.snapshot = data;
    state.error = null;
  } catch (error) {
    state.error = error.message;
  } finally {
    state.loading = false;
    state.refreshing = false;
    if (!activeEditor) render();
  }
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
    const reason = error.details?.blockedReasons?.join("、") ?? error.message;
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

async function liveRequest() {
  try {
    const data = await runAction("检查 Live Gate", "/api/operator/live/request", {
      body: JSON.stringify({ actor: "LOCAL_OPERATOR", reason: "UI_MODE_SWITCH" }),
    });
    if (data.result?.allowed) showLiveConfirmation();
  } catch (error) {
    showModal(
      "Live 仍保持禁用",
      `<p>安全 Gate 没有允许切换，所有 Paper 数据保持不变。</p>`,
      error.details?.blockedReasons?.join("、") ?? error.message,
      "知道了",
    );
  }
}

function showLiveConfirmation() {
  showModal(
    "二次确认进入 Live",
    `<p>请确认你已理解 Live 会连接外部账户。输入固定确认词后才会再次检查 Gate。</p><input class="modal-input" id="confirmation-text" value="" placeholder="ENABLE LIVE TRADING" autocomplete="off" />`,
    "当前 UI 仍不会加载私钥；缺少任何外部依赖时后台会拒绝。",
    "确认进入 Live",
    async (modalRoot) => {
      const confirmationText = modalRoot.querySelector("#confirmation-text")?.value ?? "";
      try {
        await runAction("确认 Live", "/api/operator/live/confirm", {
          body: JSON.stringify({ actor: "LOCAL_OPERATOR", confirmationText }),
        }, { success: "Live Gate 已确认。" });
      } catch {
        // runAction and the following modal contain the authoritative reason.
      }
    },
  );
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
  showModal(
    "切换到 LIVE",
    `<div class="mode-preview"><span class="current"><i></i>PAPER</span><svg viewBox="0 0 20 20"><path d="m6 4 6 6-6 6" /></svg><span>LIVE</span></div><p>第一次确认只会请求后台 Gate 检查，不会直接提交订单。</p>`,
    "Live 当前默认禁用，缺少外部依赖时会明确拒绝。",
    "请求 Live 检查",
    liveRequest,
  );
}

async function actionClick(action, input = {}) {
  const mode = String(input.mode ?? currentMode(state.snapshot)).toUpperCase();
  if (action === "runtime-start") await runAction(`启动 ${mode}`, "/api/operator/runtime/start", { body: JSON.stringify({ mode, actor: "LOCAL_OPERATOR", reason: "UI_RUNTIME_START" }) }, { success: `${mode} 启动请求已提交，页面会持续刷新状态。` });
  if (action === "runtime-stop") await runAction(`安全暂停 ${mode}`, "/api/operator/runtime/stop", { body: JSON.stringify({ mode, actor: "LOCAL_OPERATOR", reason: "UI_RUNTIME_STOP" }) }, { success: `${mode} 安全暂停请求已提交。` });
  if (action === "runtime-recover") await runAction(`恢复 ${mode}`, "/api/operator/runtime/recover", { body: JSON.stringify({ mode, actor: "LOCAL_OPERATOR", reason: "UI_RUNTIME_RECOVER" }) }, { success: `${mode} 恢复请求已提交。` });
  if (action === "live-preflight") await runAction("检查 Live Gate", "/api/operator/live/preflight", { body: "{}" }, { success: "Live Gate 检查完成。" });
  if (action === "live-recover") await runAction("恢复 Live Gate", "/api/operator/live/recover", { body: "{}" }, { success: "Live Gate 恢复检查完成。" });
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
        "只有失败或冻结执行可从这里请求恢复。",
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
