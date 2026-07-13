import { describe, expect, it, vi } from "vitest";
import { selectPaperAccount } from "../src/paper/paper-account-selection.js";

describe("selectPaperAccount", () => {
  it("reuses a persisted account after restart", () => {
    const createAccount = vi.fn(() => "new-account");
    expect(selectPaperAccount({
      persistedAccountId: " durable-account\n",
      accountExists: (accountId) => accountId === "durable-account",
      createAccount,
    })).toEqual({
      accountId: "durable-account",
      source: "PERSISTED",
      replacedStalePersistedAccount: false,
    });
    expect(createAccount).not.toHaveBeenCalled();
  });

  it("replaces an automatically persisted account that is absent from a recreated database", () => {
    expect(selectPaperAccount({
      persistedAccountId: "stale-account",
      accountExists: () => false,
      createAccount: () => "replacement-account",
    })).toEqual({
      accountId: "replacement-account",
      source: "CREATED",
      replacedStalePersistedAccount: true,
    });
  });

  it("fails closed when an explicit account does not exist", () => {
    expect(() => selectPaperAccount({
      explicitAccountId: "operator-typo",
      accountExists: () => false,
      createAccount: () => "must-not-be-used",
    })).toThrow("PAPER_ACCOUNT_NOT_FOUND:operator-typo");
  });

  it("creates a fresh account only when explicitly requested", () => {
    expect(selectPaperAccount({
      persistedAccountId: "durable-account",
      forceNew: true,
      accountExists: () => true,
      createAccount: () => "fresh-account",
    })).toEqual({
      accountId: "fresh-account",
      source: "CREATED",
      replacedStalePersistedAccount: true,
    });
  });
});
