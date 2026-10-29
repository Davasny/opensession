import { afterEach, expect, test } from "bun:test";
import { linearGraphql, LinearApiError } from "./graphql";

const originalFetch = globalThis.fetch;
const QUERY = "{ organization { id } }";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, { status, headers });
}

test("retries a rate-limited request and succeeds", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) return jsonResponse({}, 429, { "retry-after": "0" });
    return jsonResponse({ data: { ok: true } });
  }) as unknown as typeof fetch;

  expect(await linearGraphql("token", QUERY)).toEqual({ data: { ok: true } });
  expect(calls).toBe(2);
});

test("retries 5xx up to the attempt budget and then returns the error body", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return jsonResponse(
      { errors: [{ message: "upstream unavailable" }] },
      503,
      { "retry-after": "0" },
    );
  }) as unknown as typeof fetch;

  expect(await linearGraphql("token", QUERY)).toEqual({
    errors: [{ message: "upstream unavailable" }],
  });
  expect(calls).toBe(3);
});

test("rotates a rejected token once and replays the request", async () => {
  let calls = 0;
  const seenTokens: string[] = [];
  const refreshAccessToken = async (accessToken: string) => {
    seenTokens.push(accessToken);
    return "fresh-token";
  };

  globalThis.fetch = (async (_input: unknown, init: any) => {
    calls++;
    const auth = new Headers(init.headers).get("authorization");
    if (calls === 1) {
      expect(auth).toBe("Bearer stale-token");
      return jsonResponse({}, 401);
    }
    expect(auth).toBe("Bearer fresh-token");
    return jsonResponse({ data: { ok: true } });
  }) as unknown as typeof fetch;

  expect(
    await linearGraphql("stale-token", QUERY, {}, refreshAccessToken),
  ).toEqual({ data: { ok: true } });
  expect(calls).toBe(2);
  expect(seenTokens).toEqual(["stale-token"]);
});

test("a 401 without a refresh path rejects without looping", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return jsonResponse({}, 401);
  }) as unknown as typeof fetch;

  const failure = linearGraphql("token", QUERY);
  await expect(failure).rejects.toBeInstanceOf(LinearApiError);
  await expect(failure).rejects.toMatchObject({ status: 401 });
  expect(calls).toBe(1);
});

test("a non-JSON provider failure becomes a typed status error", async () => {
  globalThis.fetch = (async () =>
    new Response("<html>bad gateway</html>", {
      status: 502,
      headers: { "retry-after": "0" },
    })) as unknown as typeof fetch;

  await expect(linearGraphql("token", QUERY)).rejects.toMatchObject({
    name: "LinearApiError",
    status: 502,
  });
});

test("a network failure is not retried (a mutation may have landed)", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("socket hang up");
  }) as unknown as typeof fetch;

  await expect(linearGraphql("token", QUERY)).rejects.toThrow("socket hang up");
  expect(calls).toBe(1);
});
