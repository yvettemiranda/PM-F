// Browser-wallet flow helpers shared by the operator console.
// They keep wallet prompts serialized across duplicate tabs and make a stuck
// extension request recoverable without weakening backend or Live safety.
(function installHecatonchiresWalletFlow(global) {
  const DEFAULT_TIMEOUT_MS = 120_000;

  function firstValidAddress(accounts) {
    if (!Array.isArray(accounts)) return "";
    const address = accounts.find(
      (value) => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value),
    );
    return address ?? "";
  }

  function walletErrorMessage(error) {
    const code = error && typeof error === "object" ? error.code : undefined;
    const rawMessage = error && typeof error === "object"
      ? String(error.message ?? "")
      : String(error ?? "");
    const normalized = rawMessage.toLowerCase();
    if (code === 4001 || normalized.includes("user rejected") || normalized.includes("user denied")) {
      return "你已在 OKX 取消本次请求。";
    }
    if (
      code === -32002
      || normalized.includes("already pending")
      || normalized.includes("already processing")
      || normalized.includes("request already")
    ) {
      return "OKX 已有一个待确认请求。请只保留一个 Hecatonchires 页面，并在 OKX 完成或取消现有请求后重试。";
    }
    if (code === "WALLET_REQUEST_TIMEOUT") {
      return "等待 OKX 确认超时，页面已自动解除锁定。请打开 OKX 处理仍在等待的请求后重试。";
    }
    return rawMessage || "钱包连接被取消或未通过安全证明。";
  }

  function requestWithTimeout(provider, request, options = {}) {
    if (!provider || typeof provider.request !== "function") {
      return Promise.reject(new Error("WALLET_PROVIDER_UNAVAILABLE"));
    }
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
    const label = String(options.label ?? "钱包请求");
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = global.setTimeout(() => {
        if (settled) return;
        settled = true;
        const timeoutError = new Error(`${label}等待超时`);
        timeoutError.code = "WALLET_REQUEST_TIMEOUT";
        reject(timeoutError);
      }, timeoutMs);
      Promise.resolve()
        .then(() => provider.request(request))
        .then(
          (value) => {
            if (settled) return;
            settled = true;
            global.clearTimeout(timer);
            resolve(value);
          },
          (error) => {
            if (settled) return;
            settled = true;
            global.clearTimeout(timer);
            reject(error);
          },
        );
    });
  }

  async function runExclusive(lockManager, name, task) {
    if (!lockManager || typeof lockManager.request !== "function") {
      return { acquired: true, value: await task() };
    }
    return lockManager.request(
      name,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock) return { acquired: false };
        return { acquired: true, value: await task() };
      },
    );
  }

  global.HecatonchiresWalletFlow = {
    firstValidAddress,
    requestWithTimeout,
    runExclusive,
    walletErrorMessage,
  };
})(window);
