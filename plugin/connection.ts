import {
  AUTHORIZATION_TTL_MS,
  KoreyOAuth,
  KoreyOAuthError,
  OAuthTokenSource,
  oauthClientSchema,
  oauthCredentialsSchema,
  randomOAuthValue,
  type OAuthClient,
  type OAuthCredentials,
} from "./oauth.js";

const CLIENT_KEY = "oauth-client";

interface PendingAuthorization {
  client: OAuthClient;
  verifier: string;
  expiresAt: number;
}

interface ConnectionStorage {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface KoreyConnectionOptions {
  kv: ConnectionStorage;
  callbackUrl(): string;
  readCredentials(): Promise<string | undefined>;
  writeCredentials(value: string | null): Promise<void>;
  oauth?: KoreyOAuth;
  now?: () => number;
}

// Korey ignores the port when matching loopback redirect URIs.
function withoutPort(uri: string): string {
  const url = new URL(uri);
  url.port = "";
  return url.toString();
}

function grantsThreadAccess(scope: string): boolean {
  const granted = new Set(scope.split(/\s+/u));
  return (
    granted.has("threads:write") &&
    (granted.has("threads:read") || granted.has("threads:read:own"))
  );
}

function parseCredentials(value: string | undefined): OAuthCredentials | null {
  const text = value?.trim();
  if (!text) return null;
  try {
    return oauthCredentialsSchema.parse(JSON.parse(text));
  } catch {
    throw new KoreyOAuthError(
      "The saved Korey account connection is invalid. Disconnect under Settings -> Installed plugins -> Korey or run `bb korey logout`, then connect again.",
      "invalid_credentials",
    );
  }
}

/** The OAuth connection between this bb server and a Korey account. */
export class KoreyConnection {
  readonly tokens: OAuthTokenSource;
  private readonly oauth: KoreyOAuth;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingAuthorization>();

  constructor(private readonly options: KoreyConnectionOptions) {
    this.oauth = options.oauth ?? new KoreyOAuth();
    this.now = options.now ?? Date.now;
    this.tokens = new OAuthTokenSource(
      this.oauth,
      {
        load: () => this.saved(),
        save: (credentials) =>
          options.writeCredentials(JSON.stringify(credentials)),
      },
      this.now,
    );
  }

  async start(): Promise<{ authorizationUrl: string; expiresAt: number }> {
    this.prune();
    const client = await this.client();
    const state = randomOAuthValue();
    const verifier = randomOAuthValue();
    const expiresAt = this.now() + AUTHORIZATION_TTL_MS;
    this.pending.set(state, { client, verifier, expiresAt });
    return {
      authorizationUrl: this.oauth.authorizationUrl({
        client,
        state,
        verifier,
      }),
      expiresAt,
    };
  }

  /**
   * Finishes a sign-in from the callback URL Korey redirected to. The URL can
   * come from the callback route or be pasted by the user when the browser
   * could not reach this bb server.
   */
  async complete(redirectUrl: string): Promise<void> {
    let params: URLSearchParams;
    try {
      params = new URL(redirectUrl.trim(), this.options.callbackUrl())
        .searchParams;
    } catch {
      throw new KoreyOAuthError("The Korey sign-in address is not a valid URL");
    }
    this.prune();
    const state = params.get("state");
    const pending = state === null ? undefined : this.pending.get(state);
    if (state === null || pending === undefined) {
      throw new KoreyOAuthError(
        "This Korey sign-in is unknown, expired, or already used. Start again.",
        "invalid_state",
      );
    }
    this.pending.delete(state);
    const error = params.get("error");
    if (error !== null) {
      throw new KoreyOAuthError(
        `Korey sign-in was not completed: ${params.get("error_description") ?? error}`,
        error,
      );
    }
    const code = params.get("code");
    if (!code) {
      throw new KoreyOAuthError("Korey did not return an authorization code");
    }
    const credentials = await this.oauth.exchangeCode({
      client: pending.client,
      code,
      verifier: pending.verifier,
    });
    // Korey's consent page lets the user deselect permissions.
    if (!grantsThreadAccess(credentials.scope)) {
      await this.oauth.revoke(credentials).catch(() => undefined);
      throw new KoreyOAuthError(
        "bb needs permission to read and write your Korey threads. Connect again and keep both permissions selected.",
        "insufficient_scope",
      );
    }
    const previous = await this.saved().catch(() => null);
    await this.options.writeCredentials(JSON.stringify(credentials));
    if (previous !== null && previous.accessToken !== credentials.accessToken) {
      await this.oauth.revoke(previous).catch(() => undefined);
    }
  }

  async disconnect(): Promise<{ wasConnected: boolean; revoked: boolean }> {
    const wasConnected = Boolean(
      (await this.options.readCredentials())?.trim(),
    );
    const credentials = await this.saved().catch(() => null);
    let revoked = false;
    if (credentials !== null) {
      revoked = await this.oauth.revoke(credentials).then(
        () => true,
        () => false,
      );
    }
    await this.options.writeCredentials(null);
    // Korey associates a registration with the organization that approves it,
    // so a later sign-in to another organization needs a new one.
    await this.options.kv.delete(CLIENT_KEY);
    this.pending.clear();
    return { wasConnected, revoked };
  }

  private async saved(): Promise<OAuthCredentials | null> {
    return parseCredentials(await this.options.readCredentials());
  }

  private async client(): Promise<OAuthClient> {
    const redirectUri = this.options.callbackUrl();
    const stored = oauthClientSchema.safeParse(
      await this.options.kv.get(CLIENT_KEY),
    );
    if (
      stored.success &&
      withoutPort(stored.data.redirectUri) === withoutPort(redirectUri)
    ) {
      return { clientId: stored.data.clientId, redirectUri };
    }
    const client = await this.oauth.register(redirectUri);
    await this.options.kv.set(CLIENT_KEY, client);
    return client;
  }

  private prune(): void {
    const now = this.now();
    for (const [state, pending] of this.pending) {
      if (pending.expiresAt <= now) this.pending.delete(state);
    }
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export function callbackPage(
  title: string,
  message: string,
  status: number,
): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body { font: 16px/1.5 system-ui, sans-serif; margin: 0; display: grid; min-height: 100vh; place-items: center; color: #1f2328; background: #f6f8fa; }
main { max-width: 32rem; padding: 2rem; background: #fff; border: 1px solid #d0d7de; border-radius: 12px; }
h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
p { margin: 0; }
@media (prefers-color-scheme: dark) { body { color: #e6edf3; background: #0d1117; } main { background: #161b22; border-color: #30363d; } }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
    },
  });
}
