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

  global.HecatonchiresUiState = {
    formatTime,
    serviceInstanceChanged,
    snapshotRenderKey,
    statusText,
  };
})(window);
