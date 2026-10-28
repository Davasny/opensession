/** Longest display name a person can give a connected provider account. */
export const MAX_ACCOUNT_LABEL_LENGTH = 80;

/** A copy of the account with its display name set, or cleared when empty. */
export function withLabel<T extends { label?: string }>(
  account: T,
  label: string,
): T {
  const next = { ...account };
  const trimmed = label.trim().slice(0, MAX_ACCOUNT_LABEL_LENGTH);
  if (trimmed) next.label = trimmed;
  else delete next.label;
  return next;
}

/** The name shown for an account: its display name, else its email, else
 *  the internal name older and API-key records carry. */
export function accountDisplayName(account: {
  name: string;
  label?: string;
  email?: string;
}): string {
  return account.label?.trim() || account.email?.trim() || account.name;
}
