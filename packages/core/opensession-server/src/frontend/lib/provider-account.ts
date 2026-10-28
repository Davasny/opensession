/** The subscription identity shown throughout the UI: the name a person gave
 * the account in Settings, else its email. Older account records and API-key
 * entries may not have an email, so their internal name remains the
 * compatibility fallback rather than leaving the picker blank. */
export function providerAccountLabel(account: {
  name: string;
  label?: string | null;
  email?: string | null;
}): string {
  return account.label?.trim() || account.email?.trim() || account.name;
}
