export type PaperAccountSelectionSource = "EXPLICIT" | "PERSISTED" | "CREATED";

export interface PaperAccountSelection {
  accountId: string;
  source: PaperAccountSelectionSource;
  replacedStalePersistedAccount: boolean;
}

export interface SelectPaperAccountInput {
  explicitAccountId?: string;
  persistedAccountId?: string;
  forceNew?: boolean;
  accountExists: (accountId: string) => boolean;
  createAccount: () => string;
}

const normalizedAccountId = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
};

/**
 * Chooses the durable Paper account without performing filesystem or database IO.
 * An explicit account ID is fail-closed; a stale automatically persisted ID is
 * replaced because it normally means the configured database was recreated.
 */
export function selectPaperAccount(input: SelectPaperAccountInput): PaperAccountSelection {
  const explicitAccountId = normalizedAccountId(input.explicitAccountId);
  const persistedAccountId = normalizedAccountId(input.persistedAccountId);

  if (explicitAccountId && !input.forceNew) {
    if (!input.accountExists(explicitAccountId)) {
      throw new Error(`PAPER_ACCOUNT_NOT_FOUND:${explicitAccountId}`);
    }
    return {
      accountId: explicitAccountId,
      source: "EXPLICIT",
      replacedStalePersistedAccount: false,
    };
  }

  if (persistedAccountId && !input.forceNew && input.accountExists(persistedAccountId)) {
    return {
      accountId: persistedAccountId,
      source: "PERSISTED",
      replacedStalePersistedAccount: false,
    };
  }

  return {
    accountId: input.createAccount(),
    source: "CREATED",
    replacedStalePersistedAccount: Boolean(persistedAccountId),
  };
}
