import { DatabaseSync } from "node:sqlite";
import type { SourceVersion } from "../infra/source-version.js";
import type { Signer } from "./signer.js";
import type { WalletProvider } from "./wallet-provider.js";

export interface LiveIdentityCheck {
  name: string;
  passed: boolean;
  reason: string;
}

export interface LiveIdentityBindingResult {
  accountId: string;
  ready: boolean;
  walletAddress: string | null;
  signerAddress: string | null;
  checks: LiveIdentityCheck[];
}

interface RegisteredIdentity {
  live_account_id: string;
  account_status: string;
  wallet_address: string;
  wallet_type: string;
  wallet_network: string;
  wallet_status: string;
  authorized_signer_address: string | null;
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

function address(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim().toLowerCase();
  return ADDRESS_RE.test(normalized) ? normalized : null;
}

/**
 * Verifies the public wallet/signer identity binding before a Live runtime
 * can consume Signals. It only calls address/status read methods and never
 * asks the signer to sign or the wallet to mutate allowances.
 */
export class LiveIdentityBinding {
  private readonly database: DatabaseSync;

  constructor(
    databasePath: string,
    private readonly walletProvider: WalletProvider,
    private readonly signer: Signer,
    private readonly environment: "PRODUCTION" | "TEST",
    private readonly sourceVersion: SourceVersion,
  ) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
  }

  async check(accountId: string): Promise<LiveIdentityBindingResult> {
    const registered = this.database.prepare(
      `SELECT a.live_account_id,a.status account_status,
              w.wallet_address,w.wallet_type,w.network wallet_network,w.status wallet_status,
              a.authorized_signer_address
       FROM live_accounts a
       JOIN live_wallets w ON w.live_wallet_id=a.live_wallet_id
       WHERE a.live_account_id=?`,
    ).get(accountId) as RegisteredIdentity | undefined;
    const checks: LiveIdentityCheck[] = [];
    if (!registered) {
      checks.push({ name: "registered_identity", passed: false, reason: "LIVE_ACCOUNT_NOT_FOUND" });
      return { accountId, ready: false, walletAddress: null, signerAddress: null, checks };
    }
    checks.push({
      name: "registered_identity",
      passed: registered.account_status === "ACTIVE" && registered.wallet_status === "ACTIVE",
      reason: registered.account_status === "ACTIVE" && registered.wallet_status === "ACTIVE"
        ? "OK"
        : `LIVE_ACCOUNT_OR_WALLET_NOT_ACTIVE:${registered.account_status}:${registered.wallet_status}`,
    });
    const expectedWallet = address(registered.wallet_address);
    const expectedSigner = address(registered.authorized_signer_address);
    checks.push({
      name: "registered_wallet_address",
      passed: expectedWallet !== null,
      reason: expectedWallet !== null ? "OK" : "LIVE_WALLET_ADDRESS_INVALID",
    });
    checks.push({
      name: "registered_signer_address",
      passed: expectedSigner !== null,
      reason: expectedSigner !== null ? "OK" : "LIVE_ACCOUNT_AUTHORIZED_SIGNER_INVALID",
    });
    checks.push({
      name: "runtime_component_types",
      passed: this.environment === "TEST"
        ? this.walletProvider.providerType === "FAKE" && this.signer.signerType === "FAKE"
        : this.walletProvider.providerType === "LIVE_READONLY" && this.signer.signerType === "LIVE",
      reason: this.environment === "TEST"
        ? this.walletProvider.providerType === "FAKE" && this.signer.signerType === "FAKE"
          ? "OK"
          : "TEST_LIVE_COMPONENTS_MUST_BE_FAKE"
        : this.walletProvider.providerType === "LIVE_READONLY" && this.signer.signerType === "LIVE"
          ? "OK"
          : "PRODUCTION_LIVE_COMPONENT_TYPES_REQUIRED",
    });
    let runtimeWallet: string | null = null;
    let runtimeSigner: string | null = null;
    try {
      runtimeWallet = address(await this.walletProvider.getAddress());
    } catch {
      checks.push({ name: "runtime_wallet_address", passed: false, reason: "WALLET_ADDRESS_READ_FAILED" });
    }
    try {
      runtimeSigner = address(await this.signer.address());
    } catch {
      checks.push({ name: "runtime_signer_address", passed: false, reason: "SIGNER_ADDRESS_READ_FAILED" });
    }
    if (runtimeWallet !== null) {
      checks.push({
        name: "runtime_wallet_address",
        passed: runtimeWallet === expectedWallet,
        reason: runtimeWallet === expectedWallet ? "OK" : "RUNTIME_WALLET_IDENTITY_MISMATCH",
      });
    }
    if (runtimeSigner !== null) {
      checks.push({
        name: "runtime_signer_address",
        passed: runtimeSigner === expectedSigner,
        reason: runtimeSigner === expectedSigner ? "OK" : "RUNTIME_SIGNER_IDENTITY_MISMATCH",
      });
    }
    let walletStatus: Awaited<ReturnType<WalletProvider["getStatus"]>> | null = null;
    try {
      walletStatus = await this.walletProvider.getStatus();
    } catch {
      checks.push({ name: "runtime_wallet_status", passed: false, reason: "WALLET_STATUS_READ_FAILED" });
    }
    if (walletStatus !== null) {
      checks.push({
        name: "runtime_wallet_status",
        passed: walletStatus.status === "ACTIVE",
        reason: walletStatus.status === "ACTIVE" ? "OK" : walletStatus.reason ?? `WALLET_${walletStatus.status}`,
      });
    }
    checks.push({
      name: "source_version",
      passed: this.sourceVersion.commit.trim().length > 0 && !this.sourceVersion.dirty,
      reason: this.sourceVersion.dirty ? "SOURCE_WORKTREE_DIRTY" : this.sourceVersion.commit.trim().length > 0 ? "OK" : "SOURCE_COMMIT_MISSING",
    });
    return {
      accountId,
      ready: checks.every((check) => check.passed),
      walletAddress: runtimeWallet,
      signerAddress: runtimeSigner,
      checks,
    };
  }

  close(): void {
    this.database.close();
  }
}
