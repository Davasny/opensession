/**
 * Low-level Linear GraphQL transport: status classification, bounded retries
 * for responses that were rejected before Linear applied the request, and one
 * token rotation on a 401.
 */
import { fetchWithTimeout } from "../../server/shared/fetch-with-timeout";

const LINEAR_GQL = "https://api.linear.app/graphql";

/** A non-JSON or unauthorized response the caller can classify. */
export class LinearApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "LinearApiError";
  }
}

/** Rate limits and gateway failures are safe to retry: the request was
 *  rejected before Linear applied it. Network errors are NOT retried because a
 *  timed-out mutation may already have landed. */
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 250;
const RETRY_MAX_DELAY_MS = 2_000;

function retryDelayMs(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0)
      return Math.min(seconds * 1000, RETRY_MAX_DELAY_MS);
    const date = Date.parse(header);
    if (Number.isFinite(date))
      return Math.min(Math.max(0, date - Date.now()), RETRY_MAX_DELAY_MS);
  }
  return Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
}

export type RefreshAccessToken = (
  accessToken: string,
) => Promise<string | null>;

export async function linearGraphql(
  accessToken: string,
  query: string,
  variables: Record<string, unknown> = {},
  refreshAccessToken?: RefreshAccessToken,
): Promise<any> {
  let token = accessToken;
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    const response = await fetchWithTimeout(LINEAR_GQL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < MAX_ATTEMPTS - 1) {
      // Drain the body so the failed attempt releases its socket.
      await response.text().catch(() => {});
      const delay = retryDelayMs(response, attempt);
      if (delay > 0) await Bun.sleep(delay);
      continue;
    }

    if (response.status === 401) {
      await response.text().catch(() => {});
      // A revoked token can still look unexpired locally. Rotate it once and
      // replay this request; the exchange itself is single-flight per org.
      if (!refreshed && refreshAccessToken) {
        refreshed = true;
        const next = await refreshAccessToken(token).catch(() => null);
        if (next) {
          token = next;
          continue;
        }
      }
      throw new LinearApiError("Linear API unauthorized", 401);
    }
    if (!response.ok) {
      // Preserve the existing contract for provider JSON errors: callers log
      // result.data/result.errors. A non-JSON body becomes a typed error.
      try {
        return await response.json();
      } catch {
        throw new LinearApiError(
          `Linear API HTTP ${response.status}`,
          response.status,
        );
      }
    }
    return await response.json();
  }
}
