// Browser-wallet discovery for the operator console.
// Prefer EIP-6963 announcements so OKX is found reliably when several wallet
// extensions are installed or when injection finishes after the page loads.
(function installHecatonchiresWalletDiscovery(global) {
  const DEFAULT_TIMEOUT_MS = 1_500;
  const candidates = [];
  let candidateSequence = 0;

  function isProvider(value) {
    return value !== null
      && typeof value === "object"
      && typeof value.request === "function";
  }

  function providerScore(info, provider) {
    const name = String(info?.name ?? "").toLowerCase();
    const rdns = String(info?.rdns ?? "").toLowerCase();
    if (
      provider?.isOkxWallet === true
      || provider?.isOKExWallet === true
      || name.includes("okx")
      || name.includes("okex")
      || rdns.includes("okx")
      || rdns.includes("okex")
    ) {
      return 100;
    }
    if (
      provider?.isMetaMask === true
      || provider?.isCoinbaseWallet === true
      || provider?.isBraveWallet === true
    ) {
      return 1;
    }
    return 10;
  }

  function addCandidate(provider, info = null) {
    if (!isProvider(provider)) return;
    const score = providerScore(info, provider);
    const sequence = ++candidateSequence;
    const existing = candidates.find((candidate) => candidate.provider === provider);
    if (existing) {
      if (score >= existing.score) existing.info = info;
      existing.score = Math.max(existing.score, score);
      existing.sequence = sequence;
      return;
    }
    candidates.push({ provider, info, score, sequence });
  }

  function addInjectedCandidates(windowObject) {
    const legacyOkx = windowObject.okxwallet;
    addCandidate(legacyOkx?.ethereum, { name: "OKX Wallet", rdns: "com.okx.wallet" });
    addCandidate(legacyOkx, { name: "OKX Wallet", rdns: "com.okx.wallet" });
    const injected = windowObject.ethereum;
    if (Array.isArray(injected?.providers)) {
      injected.providers.forEach((provider) => addCandidate(provider));
    }
    addCandidate(injected);
  }

  function choose() {
    return candidates
      .slice()
      .sort((left, right) => right.score - left.score || right.sequence - left.sequence)[0] ?? null;
  }

  function requestAnnouncements(windowObject) {
    try {
      const event = typeof windowObject.Event === "function"
        ? new windowObject.Event("eip6963:requestProvider")
        : { type: "eip6963:requestProvider" };
      windowObject.dispatchEvent?.(event);
    } catch {
      // Legacy injection can still be discovered without EIP-6963.
    }
  }

  global.addEventListener?.("eip6963:announceProvider", (event) => {
    const detail = event?.detail;
    addCandidate(detail?.provider, detail?.info ?? null);
  });
  addInjectedCandidates(global);
  requestAnnouncements(global);

  function discover(options = {}) {
    const windowObject = options.windowObject ?? global;
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
    let settled = false;
    let timer = null;

    addInjectedCandidates(windowObject);
    const current = choose();
    const injectedProviders = windowObject.ethereum?.providers;
    const shouldWaitForPreferredWallet = current?.score === 1
      || Array.isArray(injectedProviders) && injectedProviders.length > 1;
    if (current?.score === 100 || current !== null && !shouldWaitForPreferredWallet) {
      return Promise.resolve(current.provider);
    }

    return new Promise((resolve) => {
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer !== null) windowObject.clearTimeout(timer);
        windowObject.removeEventListener?.("eip6963:announceProvider", onAnnouncement);
        addInjectedCandidates(windowObject);
        resolve(choose()?.provider ?? null);
      };
      const onAnnouncement = (event) => {
        const detail = event?.detail;
        addCandidate(detail?.provider, detail?.info ?? null);
        // One announcement is enough when it identifies OKX; otherwise keep
        // the short discovery window open for another wallet announcement.
        if (providerScore(detail?.info, detail?.provider) === 100) finish();
      };

      windowObject.addEventListener?.("eip6963:announceProvider", onAnnouncement);
      timer = windowObject.setTimeout(finish, timeoutMs);
      requestAnnouncements(windowObject);
    });
  }

  global.HecatonchiresWalletProvider = { discover, isProvider };
})(window);
