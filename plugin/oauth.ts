import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { KoreyCredentials, KoreyTokenLease } from "./korey-client.js";

const DEFAULT_ISSUER = "https://api.korey.ai";
const REQUEST_TIMEOUT_MS = 30_000;
// Refresh early so a request does not start with a token that expires in flight.
const REFRESH_MARGIN_MS = 2 * 60_000;
// Longest a refresh waits for requests still using the old token. Korey
// revokes it when it issues a new one. Requests time out after 30 seconds.
const DRAIN_TIMEOUT_MS = 35_000;

/** Korey discards pending consent requests after 15 minutes. */
export const AUTHORIZATION_TTL_MS = 15 * 60_000;
export const OAUTH_SCOPE = "threads:read threads:write";
export const OAUTH_CALLBACK_PATH = "/oauth/callback";

export const oauthClientSchema = z.strictObject({
  clientId: z.string().min(1),
  redirectUri: z.string().min(1),
});

export const oauthCredentialsSchema = z.strictObject({
  version: z.literal(1),
  clientId: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().int().positive(),
  scope: z.string(),
});

export type OAuthClient = z.infer<typeof oauthClientSchema>;
export type OAuthCredentials = z.infer<typeof oauthCredentialsSchema>;

const registrationResponseSchema = z.object({ client_id: z.string().min(1) });
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().refine((type) => type.toLowerCase() === "bearer"),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1),
  scope: z.string().optional(),
});
const errorResponseSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
  message: z.string().optional(),
});

export class KoreyOAuthError extends Error {
  /** True for failures without an OAuth error code, such as network errors. */
  readonly transient: boolean;

  constructor(
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "KoreyOAuthError";
    this.transient = code === null;
  }
}

export function randomOAuthValue(): string {
  return randomBytes(32).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Korey's OAuth endpoints, as advertised by its authorization server metadata. */
export class KoreyOAuth {
  private readonly issuer: string;

  constructor(
    private readonly options: {
      issuer?: string;
      fetch?: typeof globalThis.fetch;
      now?: () => number;
    } = {},
  ) {
    this.issuer = (options.issuer ?? DEFAULT_ISSUER).replace(/\/+$/u, "");
  }

  async register(redirectUri: string): Promise<OAuthClient> {
    const body = await this.post(
      "/oauth/register",
      "client registration",
      201,
      {
        "content-type": "application/json",
      },
      JSON.stringify({
        client_name: "bb Korey plugin",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: OAUTH_SCOPE,
      }),
    );
    const parsed = registrationResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new KoreyOAuthError(
        "Korey returned an invalid client registration",
      );
    }
    return { clientId: parsed.data.client_id, redirectUri };
  }

  authorizationUrl(input: {
    client: OAuthClient;
    state: string;
    verifier: string;
  }): string {
    const url = new URL(`${this.issuer}/oauth/authorize`);
    url.search = new URLSearchParams({
      client_id: input.client.clientId,
      redirect_uri: input.client.redirectUri,
      response_type: "code",
      scope: OAUTH_SCOPE,
      state: input.state,
      code_challenge: pkceChallenge(input.verifier),
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  }

  exchangeCode(input: {
    client: OAuthClient;
    code: string;
    verifier: string;
  }): Promise<OAuthCredentials> {
    return this.token(input.client.clientId, "authorization code exchange", {
      grant_type: "authorization_code",
      client_id: input.client.clientId,
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.client.redirectUri,
    });
  }

  refresh(credentials: OAuthCredentials): Promise<OAuthCredentials> {
    return this.token(credentials.clientId, "token refresh", {
      grant_type: "refresh_token",
      client_id: credentials.clientId,
      refresh_token: credentials.refreshToken,
    });
  }

  /** Revokes the access token. Korey identifies the client with Basic authentication. */
  async revoke(credentials: OAuthCredentials): Promise<void> {
    await this.post(
      "/oauth/token/revoke",
      "token revocation",
      200,
      {
        authorization: `Basic ${Buffer.from(`${credentials.clientId}:`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      new URLSearchParams({
        token: credentials.accessToken,
        token_type_hint: "access_token",
      }).toString(),
    );
  }

  private async token(
    clientId: string,
    context: string,
    form: Record<string, string>,
  ): Promise<OAuthCredentials> {
    const body = await this.post(
      "/oauth/token",
      context,
      200,
      { "content-type": "application/x-www-form-urlencoded" },
      new URLSearchParams(form).toString(),
    );
    const parsed = tokenResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new KoreyOAuthError(
        `Korey returned an invalid ${context} response`,
      );
    }
    const now = this.options.now?.() ?? Date.now();
    return {
      version: 1,
      clientId,
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token,
      expiresAt: now + parsed.data.expires_in * 1_000,
      scope: parsed.data.scope ?? OAUTH_SCOPE,
    };
  }

  private async post(
    path: string,
    context: string,
    expectedStatus: number,
    headers: Record<string, string>,
    body: string,
  ): Promise<unknown> {
    let response: Response;
    let text: string;
    try {
      const fetchImpl = this.options.fetch ?? globalThis.fetch;
      response = await fetchImpl(`${this.issuer}${path}`, {
        method: "POST",
        redirect: "manual",
        headers: { accept: "application/json", ...headers },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      text = await response.text();
    } catch (error) {
      throw new KoreyOAuthError(
        `Could not reach Korey for ${context}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let json: unknown = null;
    try {
      json = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      // Non-JSON error bodies are reported by status below.
    }
    if (response.status !== expectedStatus) {
      const error = errorResponseSchema.safeParse(json);
      const detail = error.success
        ? (error.data.error_description ??
          error.data.message ??
          error.data.error)
        : `HTTP ${response.status}`;
      throw new KoreyOAuthError(
        `Korey ${context} failed: ${detail}`,
        error.success ? error.data.error : null,
      );
    }
    return json;
  }
}

export interface OAuthCredentialStore {
  load(): Promise<OAuthCredentials | null>;
  save(credentials: OAuthCredentials): Promise<void>;
  /** Called when Korey no longer accepts the saved sign-in. */
  rejected?(): Promise<void>;
}

// Korey returns these when the refresh token or its client is no longer valid,
// for example after the sign-in expired or the client was deleted.
const REJECTED_SIGN_IN_CODES = new Set([
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
]);

function untilAborted<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

/** Supplies OAuth access tokens to KoreyClient and refreshes them when needed. */
export class OAuthTokenSource implements KoreyCredentials {
  private refreshing: Promise<OAuthCredentials> | null = null;
  private readonly inUse = new Map<string, number>();
  private readonly drainWaiters = new Map<string, Array<() => void>>();

  constructor(
    private readonly oauth: KoreyOAuth,
    private readonly store: OAuthCredentialStore,
    private readonly now: () => number = Date.now,
  ) {}

  async acquire(signal?: AbortSignal): Promise<KoreyTokenLease> {
    if (this.refreshing === null) {
      const current = await this.current();
      if (this.refreshing === null) {
        if (current.expiresAt - this.now() > REFRESH_MARGIN_MS) {
          return this.lease(current.accessToken);
        }
        void this.refresh(current.accessToken);
      }
    }
    // Wait for a pending refresh rather than use a token it will revoke.
    const next = await untilAborted(this.refreshing!, signal);
    return this.lease(next.accessToken);
  }

  async replaceRejectedToken(
    token: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await untilAborted(this.refresh(token), signal);
  }

  private async current(): Promise<OAuthCredentials> {
    const credentials = await this.store.load();
    if (credentials === null) {
      throw new KoreyOAuthError("Korey is not connected", "not_connected");
    }
    return credentials;
  }

  private lease(token: string): KoreyTokenLease {
    this.inUse.set(token, (this.inUse.get(token) ?? 0) + 1);
    let released = false;
    return {
      token,
      release: () => {
        if (released) return;
        released = true;
        const remaining = (this.inUse.get(token) ?? 1) - 1;
        if (remaining > 0) {
          this.inUse.set(token, remaining);
          return;
        }
        this.inUse.delete(token);
        for (const resolve of this.drainWaiters.get(token) ?? []) resolve();
        this.drainWaiters.delete(token);
      },
    };
  }

  private drained(token: string): Promise<void> {
    if (!this.inUse.has(token)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, DRAIN_TIMEOUT_MS);
      timer.unref?.();
      const waiters = this.drainWaiters.get(token) ?? [];
      waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.drainWaiters.set(token, waiters);
    });
  }

  // Korey refresh tokens are single-use, so concurrent callers share one
  // refresh. Callers can stop waiting, but the refresh itself is not
  // cancelled: abandoning it after Korey rotates the token would lose the
  // replacement.
  private refresh(staleAccessToken: string): Promise<OAuthCredentials> {
    this.refreshing ??= (async () => {
      try {
        const latest = await this.current();
        if (latest.accessToken !== staleAccessToken) return latest;
        // Korey revokes the old access token as soon as it issues a new one,
        // so let requests that already use it finish first.
        await this.drained(staleAccessToken);
        let next: OAuthCredentials;
        try {
          next = await this.oauth.refresh(latest);
        } catch (error) {
          if (
            error instanceof KoreyOAuthError &&
            error.code !== null &&
            REJECTED_SIGN_IN_CODES.has(error.code)
          ) {
            await this.store.rejected?.().catch(() => undefined);
            throw new KoreyOAuthError(
              "Korey sign-in expired or was revoked. Reconnect with `bb korey login` or under Settings -> Installed plugins -> Korey.",
              error.code,
            );
          }
          throw error;
        }
        // Do not resurrect a connection the user removed or replaced while
        // this refresh was in flight.
        const saved = await this.store.load().catch(() => null);
        if (saved?.refreshToken !== latest.refreshToken) {
          await this.oauth.revoke(next).catch(() => undefined);
          if (saved === null) {
            throw new KoreyOAuthError(
              "Korey is not connected",
              "not_connected",
            );
          }
          return saved;
        }
        await this.store.save(next);
        return next;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }
}
