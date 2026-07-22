import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const TARGET_WALLET_PATTERN = /^0x[0-9a-f]{40}$/;

export const DEFAULT_TARGET_WALLET_FILE = "config/default-target-wallet.txt";
export const SELECTED_TARGET_WALLET_FILE = "data/operator/target-wallet.txt";
export const OPERATOR_ACTIVE_LOCK = "data/operator/run/active.lock";

export interface TargetWalletSelection {
  walletAddress: string;
  source: "OPERATOR_SELECTION" | "PROJECT_DEFAULT";
  selectedFile: string;
  updatedAt: string | null;
}

export function normalizeTargetWallet(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error("PAPER_CAMPAIGN_TARGET_WALLET_REQUIRED");
  }
  const normalized = value.trim().toLowerCase();
  if (!TARGET_WALLET_PATTERN.test(normalized)) {
    throw new Error(`PAPER_CAMPAIGN_TARGET_WALLET_INVALID:${value}`);
  }
  return normalized;
}

function readTargetWalletFile(path: string): string {
  let value: string;
  try {
    value = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`TARGET_WALLET_FILE_READ_FAILED:${path}`, { cause: error });
  }
  try {
    return normalizeTargetWallet(value);
  } catch (error) {
    throw new Error(`TARGET_WALLET_FILE_INVALID:${path}`, { cause: error });
  }
}

/**
 * Resolves the public target selected by the operator. Runtime selection lives
 * under ignored data/ so changing a target never changes the source version or
 * rebinds historical Campaign evidence.
 */
export function selectedTargetWallet(projectRoot: string): TargetWalletSelection {
  const selectedFile = resolve(projectRoot, SELECTED_TARGET_WALLET_FILE);
  if (existsSync(selectedFile)) {
    return {
      walletAddress: readTargetWalletFile(selectedFile),
      source: "OPERATOR_SELECTION",
      selectedFile: SELECTED_TARGET_WALLET_FILE,
      updatedAt: statSync(selectedFile).mtime.toISOString(),
    };
  }
  const defaultFile = resolve(projectRoot, DEFAULT_TARGET_WALLET_FILE);
  return {
    walletAddress: readTargetWalletFile(defaultFile),
    source: "PROJECT_DEFAULT",
    selectedFile: SELECTED_TARGET_WALLET_FILE,
    updatedAt: null,
  };
}

/**
 * Atomically changes only the next operator target. An existing operator lock
 * blocks the change, including a stale lock, so the stop/cleanup workflow gets
 * a chance to prove that no previous worker can keep writing for another target.
 */
export function saveSelectedTargetWallet(
  projectRoot: string,
  walletAddress: string,
): TargetWalletSelection {
  const normalized = normalizeTargetWallet(walletAddress);
  const activeLock = resolve(projectRoot, OPERATOR_ACTIVE_LOCK);
  if (existsSync(activeLock)) {
    throw new Error(`TARGET_WALLET_CHANGE_BLOCKED_BY_OPERATOR_LOCK:${OPERATOR_ACTIVE_LOCK}`);
  }
  const selectedFile = resolve(projectRoot, SELECTED_TARGET_WALLET_FILE);
  mkdirSync(dirname(selectedFile), { recursive: true });
  const temporaryFile = `${selectedFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryFile, `${normalized}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporaryFile, selectedFile);
  } catch (error) {
    rmSync(temporaryFile, { force: true });
    throw error;
  }
  return selectedTargetWallet(projectRoot);
}
