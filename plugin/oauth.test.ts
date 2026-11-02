import { describe, expect, it, vi } from "vitest";
import { KoreyApiError, KoreyClient } from "./korey-client.js";
import {
  KoreyOAuth,
  KoreyOAuthError,
  OAuthTokenSource,
  pkceChallenge,
  type OAuthCredentials,
} from "./oauth.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function tokenResponse(access: string, refresh: string): Response {
  return jsonResponse({
    access_token: access,
    token_type: "Bearer",
    expires_in: 3600,
    scope: "threads:read threads:write",
    refresh_token: refresh,
  });
}

function identityResponse(): Response {
  return jsonResponse({
    sub: "42",
    name: "bb User",
    email: "user@example.com",
    korey_user_id: 42,
    korey_organization_id: 7,
    korey_organization_slug: "example",
    role: "member",
  });
}

function mockFetch(responses: Response[]) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const response = responses.shift();
    if (response === undefined) throw new Error(`Unexpected ${String(input)}`);
    return response;
  };
  return { calls, fetch };
}

function form(init: RequestInit | undefined): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(String(init?.body)));
}

function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

const client = {
  clientId: "kc_client",
  redirectUri:
    "http://127.0.0.1:38886/api/v1/plugins/korey/http/oauth/callback",
};

function credentials(
  overrides: Partial<OAuthCredentials> = {},
): OAuthCredentials {
  return {
    version: 1,
    clientId: "kc_client",
    accessToken: "kt_oauth_old",
    refreshToken: "kt_refresh_old",
    expiresAt: 1_000_000 + 3_600_000,
    scope: "threads:read threads:write",
    ...overrides,
  };
}

function memoryStore(initial: OAuthCredentials | null) {
  let value = initial;
  const saved: OAuthCredentials[] = [];
  return {
    saved,
    store: {
      load: async () => value,
      save: async (next: OAuthCredentials) => {
        saved.push(next);
        value = next;
      },
    },
  };
}

describe("KoreyOAuth", () => {
  it("derives the RFC 7636 S256 challenge", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("registers a public loopback client", async () => {
    const { calls, fetch } = mockFetch([
      jsonResponse(
        { client_id: "kc_client", client_name: "bb Korey plugin" },
        201,
      ),
    ]);
    await expect(
      new KoreyOAuth({ fetch }).register(client.redirectUri),
    ).resolves.toEqual(client);
    expect(calls[0]?.url).toBe("https://api.korey.ai/oauth/register");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      client_name: "bb Korey plugin",
      redirect_uris: [client.redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "threads:read threads:write",
    });
  });

  it("builds an authorization URL with PKCE and state", () => {
    const url = new URL(
      new KoreyOAuth().authorizationUrl({
        client,
        state: "state-1",
        verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://api.korey.ai/oauth/authorize",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "kc_client",
      redirect_uri: client.redirectUri,
      response_type: "code",
      scope: "threads:read threads:write",
      state: "state-1",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    });
  });

  it("exchanges an authorization code for expiring credentials", async () => {
    const { calls, fetch } = mockFetch([tokenResponse("kt_oauth_1", "kt_r_1")]);
    const oauth = new KoreyOAuth({ fetch, now: () => 1_000 });
    await expect(
      oauth.exchangeCode({ client, code: "code-1", verifier: "verifier-1" }),
    ).resolves.toEqual({
      version: 1,
      clientId: "kc_client",
      accessToken: "kt_oauth_1",
      refreshToken: "kt_r_1",
      expiresAt: 1_000 + 3_600_000,
      scope: "threads:read threads:write",
    });
    expect(calls[0]?.url).toBe("https://api.korey.ai/oauth/token");
    expect(form(calls[0]?.init)).toEqual({
      grant_type: "authorization_code",
      client_id: "kc_client",
      code: "code-1",
      code_verifier: "verifier-1",
      redirect_uri: client.redirectUri,
    });
  });

  it("reports OAuth error codes and descriptions", async () => {
    const { fetch } = mockFetch([
      jsonResponse(
        { error: "invalid_grant", error_description: "code_verifier mismatch" },
        400,
      ),
    ]);
    const failure = await new KoreyOAuth({ fetch })
      .exchangeCode({ client, code: "code-1", verifier: "wrong" })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KoreyOAuthError);
    expect(failure).toMatchObject({
      code: "invalid_grant",
      message:
        "Korey authorization code exchange failed: code_verifier mismatch",
    });
  });

  it("revokes access tokens with Basic client authentication", async () => {
    const { calls, fetch } = mockFetch([new Response(null, { status: 200 })]);
    await new KoreyOAuth({ fetch }).revoke(credentials());
    expect(calls[0]?.url).toBe("https://api.korey.ai/oauth/token/revoke");
    expect(header(calls[0]?.init, "authorization")).toBe(
      `Basic ${Buffer.from("kc_client:").toString("base64")}`,
    );
    expect(form(calls[0]?.init)).toEqual({
      token: "kt_oauth_old",
      token_type_hint: "access_token",
    });
  });
});

async function tokenOf(
  source: OAuthTokenSource,
  signal?: AbortSignal,
): Promise<string> {
  const lease = await source.acquire(signal);
  lease.release();
  return lease.token;
}

describe("OAuthTokenSource", () => {
  it("uses the saved access token while it is fresh", async () => {
    const { fetch, calls } = mockFetch([]);
    const { store } = memoryStore(credentials());
    const source = new OAuthTokenSource(
      new KoreyOAuth({ fetch }),
      store,
      () => 1_000_000,
    );
    await expect(tokenOf(source)).resolves.toBe("kt_oauth_old");
    expect(calls).toHaveLength(0);
  });

  it("shares one refresh between concurrent callers and saves the rotated token", async () => {
    const { fetch, calls } = mockFetch([
      tokenResponse("kt_oauth_new", "kt_r2"),
    ]);
    const { store, saved } = memoryStore(
      credentials({ expiresAt: 1_000_000 + 60_000 }),
    );
    const source = new OAuthTokenSource(
      new KoreyOAuth({ fetch, now: () => 1_000_000 }),
      store,
      () => 1_000_000,
    );
    await expect(
      Promise.all([tokenOf(source), tokenOf(source)]),
    ).resolves.toEqual(["kt_oauth_new", "kt_oauth_new"]);
    expect(calls).toHaveLength(1);
    expect(form(calls[0]?.init)).toEqual({
      grant_type: "refresh_token",
      client_id: "kc_client",
      refresh_token: "kt_refresh_old",
    });
    expect(saved).toEqual([
      expect.objectContaining({
        accessToken: "kt_oauth_new",
        refreshToken: "kt_r2",
      }),
    ]);
  });

  it("finishes and saves a refresh after the caller stops waiting", async () => {
    let release: ((response: Response) => void) | undefined;
    const fetch: typeof globalThis.fetch = () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      });
    const { store, saved } = memoryStore(credentials({ expiresAt: 1 }));
    const source = new OAuthTokenSource(new KoreyOAuth({ fetch }), store);
    const controller = new AbortController();
    const waiting = tokenOf(source, controller.signal);
    await vi.waitFor(() => expect(release).not.toBeUndefined());
    controller.abort(new Error("caller gave up"));
    await expect(waiting).rejects.toThrow("caller gave up");
    release?.(tokenResponse("kt_oauth_new", "kt_r2"));
    await vi.waitFor(() => expect(saved).toHaveLength(1));
  });

  it("does not restore a connection removed during a refresh", async () => {
    let release: ((response: Response) => void) | undefined;
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      calls.push(String(input));
      if (String(input).endsWith("/oauth/token/revoke")) {
        return new Response(null, { status: 200 });
      }
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    };
    let value: OAuthCredentials | null = credentials({ expiresAt: 1 });
    const saved: OAuthCredentials[] = [];
    const source = new OAuthTokenSource(new KoreyOAuth({ fetch }), {
      load: async () => value,
      save: async (next) => {
        saved.push(next);
        value = next;
      },
    });
    const waiting = tokenOf(source);
    await vi.waitFor(() => expect(release).toBeDefined());
    value = null;
    release?.(tokenResponse("kt_oauth_new", "kt_r2"));
    await expect(waiting).rejects.toThrow("Korey is not connected");
    expect(saved).toHaveLength(0);
    expect(calls.at(-1)).toBe("https://api.korey.ai/oauth/token/revoke");
  });

  it("refreshes only after requests using the old token finish", async () => {
    const { fetch, calls } = mockFetch([
      tokenResponse("kt_oauth_new", "kt_r2"),
    ]);
    let now = 1_000_000;
    const { store } = memoryStore(
      credentials({ expiresAt: 1_000_000 + 3 * 60_000 }),
    );
    const source = new OAuthTokenSource(
      new KoreyOAuth({ fetch }),
      store,
      () => now,
    );
    const inFlight = await source.acquire();
    expect(inFlight.token).toBe("kt_oauth_old");

    now += 2 * 60_000;
    const later = [tokenOf(source), tokenOf(source)];
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(0);

    inFlight.release();
    await expect(Promise.all(later)).resolves.toEqual([
      "kt_oauth_new",
      "kt_oauth_new",
    ]);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["an expired refresh token", 400, "invalid_grant"],
    ["a deleted client", 401, "invalid_client"],
  ])("asks the user to reconnect after %s", async (_label, status, error) => {
    const { fetch } = mockFetch([jsonResponse({ error }, status)]);
    const { store, saved } = memoryStore(credentials({ expiresAt: 1 }));
    const rejected = vi.fn<() => Promise<void>>(async () => undefined);
    const source = new OAuthTokenSource(new KoreyOAuth({ fetch }), {
      ...store,
      rejected,
    });
    await expect(tokenOf(source)).rejects.toThrow(
      "Korey sign-in expired or was revoked. Reconnect with `bb korey login`",
    );
    expect(rejected).toHaveBeenCalledOnce();
    expect(saved).toHaveLength(0);
  });

  it("keeps the registration after a network failure", async () => {
    const fetch: typeof globalThis.fetch = async () => {
      throw new Error("connection reset");
    };
    const { store } = memoryStore(credentials({ expiresAt: 1 }));
    const rejected = vi.fn<() => Promise<void>>(async () => undefined);
    const source = new OAuthTokenSource(new KoreyOAuth({ fetch }), {
      ...store,
      rejected,
    });
    await expect(tokenOf(source)).rejects.toThrow("connection reset");
    expect(rejected).not.toHaveBeenCalled();
  });
});

describe("KoreyClient with refreshable credentials", () => {
  function credentialsSource(tokens: string[]) {
    let current = tokens.shift()!;
    const replaced: string[] = [];
    return {
      replaced,
      source: {
        acquire: async () => ({ token: current, release: () => undefined }),
        replaceRejectedToken: async (token: string) => {
          replaced.push(token);
          current = tokens.shift() ?? current;
        },
      },
    };
  }

  function failingSource(...errors: Error[]) {
    return {
      acquire: async () => {
        const error = errors.shift();
        if (error) throw error;
        return { token: "fresh", release: () => undefined };
      },
    };
  }

  it("retries a read once with a replacement token after a 401", async () => {
    const { fetch, calls } = mockFetch([
      jsonResponse({ error: "unauthorized" }, 401),
      identityResponse(),
    ]);
    const { source, replaced } = credentialsSource(["expired", "fresh"]);
    const api = new KoreyClient({ token: source, fetch });
    await expect(api.identity()).resolves.toMatchObject({ sub: "42" });
    expect(replaced).toEqual(["expired"]);
    expect(calls.map(({ init }) => header(init, "authorization"))).toEqual([
      "Bearer expired",
      "Bearer fresh",
    ]);
  });

  it("does not retry a read twice", async () => {
    const { fetch, calls } = mockFetch([
      jsonResponse({ error: "unauthorized" }, 401),
      jsonResponse({ error: "unauthorized" }, 401),
    ]);
    const { source } = credentialsSource(["expired", "also-rejected"]);
    const api = new KoreyClient({ token: source, fetch });
    await expect(api.identity()).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(2);
  });

  it("never resends a mutation after a 401 but replaces the token", async () => {
    const { fetch, calls } = mockFetch([
      jsonResponse({ error: "unauthorized" }, 401),
    ]);
    const { source, replaced } = credentialsSource(["expired", "fresh"]);
    const api = new KoreyClient({ token: source, fetch });
    const failure = await api
      .sendMessage("thread-one", "hello")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KoreyApiError);
    expect(failure).toMatchObject({ status: 401, mutationRejected: true });
    expect(calls).toHaveLength(1);
    expect(replaced).toEqual(["expired"]);
  });

  it("reports a write as rejected when no token can be obtained", async () => {
    const { fetch, calls } = mockFetch([]);
    const api = new KoreyClient({
      token: failingSource(
        new KoreyOAuthError("Korey sign-in expired.", "invalid_grant"),
      ),
      fetch,
    });
    const failure = await api
      .sendMessage("thread-one", "hello")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KoreyApiError);
    expect(failure).toMatchObject({
      message: "Korey sign-in expired.",
      mutationRejected: true,
    });
    expect(calls).toHaveLength(0);
  });

  it("keeps refresh network failures retryable and sign-in failures final for reads", async () => {
    const { fetch } = mockFetch([]);
    const transient = await new KoreyClient({
      token: failingSource(new KoreyOAuthError("Could not reach Korey")),
      fetch,
    })
      .identity()
      .catch((error: unknown) => error);
    expect(transient).toBeInstanceOf(KoreyApiError);
    expect(transient).toMatchObject({ mutationRejected: false });

    const final = await new KoreyClient({
      token: failingSource(
        new KoreyOAuthError("Korey sign-in expired.", "invalid_grant"),
      ),
      fetch,
    })
      .identity()
      .catch((error: unknown) => error);
    expect(final).toBeInstanceOf(KoreyOAuthError);
  });

  it("continues waiting for a response after a refresh network failure", async () => {
    const thread = {
      id: "thread-one",
      name: null,
      state: "ready",
      is_private: true,
      archived: false,
      owner: { id: "user-one", name: "bb User" },
      created_at: "2026-08-21T12:00:00.000Z",
      updated_at: "2026-08-21T12:00:00.000Z",
      app_url: "https://app.korey.ai/threads/thread-one",
    };
    const complete = () =>
      jsonResponse({
        status: "complete",
        messages: [
          {
            id: "answer",
            thread_id: "thread-one",
            role: "assistant",
            contents: [{ type: "text", text: "Done" }],
            created_at: "2026-08-21T12:00:00.000Z",
            app_url: "https://app.korey.ai/threads/thread-one/messages/answer",
          },
        ],
      });
    const { fetch } = mockFetch([complete(), jsonResponse(thread), complete()]);
    const api = new KoreyClient({
      token: failingSource(new KoreyOAuthError("Could not reach Korey")),
      fetch,
      pollIntervalMs: 1,
    });
    await expect(
      api.waitForResponse("thread-one", "question"),
    ).resolves.toEqual([expect.objectContaining({ id: "answer" })]);
  });
});
