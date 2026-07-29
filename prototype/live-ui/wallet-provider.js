// Browser-wallet discovery for the operator console.
// Prefer EIP-6963 announcements so OKX is found reliably when several wallet
// extensions are installed or when injection finishes after the page loads.
(function installHecatonchiresWalletDiscovery(global) {
  const DEFAULT_TIMEOUT_MS = 1_500;

  function isProvider(value) {
    return value !== null
      && typeof value === "object"
      && typeof value.request === "function";
  }

  function providerScore(info) {
    const name = String(info?.name ?? "").toLowerCase();
    const rdns = String(info?.rdns ?? "").toLowerCase();
    if (name.includes("okx") || name.includes("okex") || rdns.includes("okx") || rdns.includes("okex")) {
      return 100;
    }
    return 10;
  }

  function discover(options = {}) {
    const windowObject = options.windowObject ?? global;
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
    const candidates = [];
    const seen = new Set();
    let settled = false;
    let timer = null;

    const addCandidate = (provider, info = null) => {
      if (!isProvider(provider) || seen.has(provider)) return;
      seen.add(provider);
      candidates.push({ provider, info, score: providerScore(info) });
    };

    const injected = windowObject.ethereum;
    if (Array.isArray(injected?.providers)) {
      injected.providers.forEach((provider) => addCandidate(provider));
    }
    addCandidate(injected);

    const choose = () => candidates
      .slice()
      .sort((left, right) => right.score - left.score)[0]?.provider ?? null;

    if (candidates.length > 0) return Promise.resolve(choose());

    return new Promise((resolve) => {
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer !== null) windowObject.clearTimeout(timer);
        windowObject.removeEventListener?.("eip6963:announceProvider", onAnnouncement);
        resolve(choose() ?? (isProvider(windowObject.ethereum) ? windowObject.ethereum : null));
      };
      const onAnnouncement = (event) => {
        const detail = event?.detail;
        addCandidate(detail?.provider, detail?.info ?? null);
        // One announcement is enough when it identifies OKX; otherwise keep
        // the short discovery window open for another wallet announcement.
        if (providerScore(detail?.info) === 100) finish();
      };

      windowObject.addEventListener?.("eip6963:announceProvider", onAnnouncement);
      timer = windowObject.setTimeout(finish, timeoutMs);
      try {
        const event = typeof windowObject.Event === "function"
          ? new windowObject.Event("eip6963:requestProvider")
          : { type: "eip6963:requestProvider" };
        windowObject.dispatchEvent?.(event);
      } catch {
        // The injected provider fallback below still has a chance to resolve.
      }
    });
  }

  global.HecatonchiresWalletProvider = { discover, isProvider };
})(window);
