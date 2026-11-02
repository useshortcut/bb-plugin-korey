import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import { KoreyConnection } from "./connection.js";
import { KoreyOAuth, pkceChallenge, type OAuthCredentials } from "./oauth.js";
import koreyPlugin from "./server.js";

const CALLBACK_URL =
  "http://127.0.0.1:38886/api/v1/plugins/korey/http/oauth/callback";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function identity() {
  return {
    sub: "42",
    name: "bb User",
    email: "user@example.com",
    korey_user_id: 42,
    korey_organization_id: 7,
    korey_organization_slug: "example",
    role: "member",
  };
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

// Answers Korey's OAuth and identity endpoints the way production does.
function stubKorey(
  scope = "threads:read threads:write",
  override?: (url: string) => Response | undefined,
) {
  const calls: FetchCall[] = [];
  let issued = 0;
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const overridden = override?.(url);
    if (overridden !== undefined) return overridden;
    if (url === "https://api.korey.ai/oauth/register") {
      return jsonResponse({ client_id: `kc_client_${calls.length}` }, 201);
    }
    if (url === "https://api.korey.ai/oauth/token") {
      issued += 1;
      return jsonResponse({
        access_token: `kt_oauth_${issued}`,
        token_type: "Bearer",
        expires_in: 3600,
        scope,
        refresh_token: `kt_refresh_${issued}`,
      });
    }
    if (url === "https://api.korey.ai/oauth/token/revoke") {
      return new Response(null, { status: 200 });
    }
    if (url === "https://api.korey.ai/api/v1/me") {
      return jsonResponse(identity());
    }
    throw new Error(`Unexpected fetch ${url}`);
  });
  const to = (path: string) =>
    calls.filter(({ url }) => url === `https://api.korey.ai${path}`);
  return { calls, to };
}

function form(init: RequestInit | undefined): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(String(init?.body)));
}

function bearer(call: FetchCall | undefined): string | null {
  return new Headers(call?.init?.headers).get("authorization");
}

const hosts: FakePluginHost[] = [];

async function loadPlugin(
  settings: Record<string, string> = { apiToken: "kt_pat_test" },
): Promise<FakePluginHost> {
  const host = createFakePluginHost({
    pluginId: "korey",
    agentSkillIds: ["korey"],
    settings,
  });
  await koreyPlugin(host.bb);
  hosts.push(host);
  return host;
}

async function startLogin(host: FakePluginHost) {
  const result = await host.harness.runCli(["login", "--json"]);
  expect(result.exitCode).toBe(0);
  const url = new URL(
    (JSON.parse(result.stdout) as { authorizationUrl: string })
      .authorizationUrl,
  );
  return { url, state: url.searchParams.get("state")! };
}

function callback(host: FakePluginHost, query: string): Promise<Response> {
  return host.harness.fetchHttp("GET", `/oauth/callback?${query}`);
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.dispose()));
  vi.unstubAllGlobals();
});

describe("Korey OAuth connection", () => {
  it("connects through the browser callback and prefers OAuth over the token", async () => {
    const korey = stubKorey();
    const host = await loadPlugin();
    const { url, state } = await startLogin(host);

    expect(korey.to("/oauth/register")).toHaveLength(1);
    expect(
      JSON.parse(String(korey.to("/oauth/register")[0]?.init?.body)),
    ).toMatchObject({ redirect_uris: [CALLBACK_URL] });
    expect(url.searchParams.get("redirect_uri")).toBe(CALLBACK_URL);

    const page = await callback(host, `code=code-1&state=${state}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toContain(
      "bb is connected to Korey as bb User in example.",
    );
    const exchange = form(korey.to("/oauth/token")[0]?.init);
    expect(exchange).toMatchObject({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: CALLBACK_URL,
    });
    expect(pkceChallenge(exchange.code_verifier!)).toBe(
      url.searchParams.get("code_challenge"),
    );
    expect(host.harness.realtimeSignals).toEqual([
      expect.objectContaining({ channel: "connection" }),
    ]);

    await expect(host.harness.runCli(["status"])).resolves.toMatchObject({
      exitCode: 0,
      stdout: "Authenticated as bb User in example with OAuth.",
    });
    expect(bearer(korey.to("/api/v1/me").at(-1))).toBe("Bearer kt_oauth_1");
  });

  it("rejects unknown, replayed, and denied callbacks", async () => {
    const korey = stubKorey();
    const host = await loadPlugin();

    const unknown = await callback(host, "code=code-1&state=forged");
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain("unknown, expired, or already used");

    const { state } = await startLogin(host);
    expect((await callback(host, `code=code-1&state=${state}`)).status).toBe(
      200,
    );
    const replay = await callback(host, `code=code-1&state=${state}`);
    expect(replay.status).toBe(400);

    const denied = await startLogin(host);
    const page = await callback(
      host,
      `error=access_denied&error_description=User+denied+access&state=${denied.state}`,
    );
    expect(page.status).toBe(400);
    expect(await page.text()).toContain(
      "Korey sign-in was not completed: User denied access",
    );
    expect(korey.to("/oauth/token")).toHaveLength(1);
  });

  it("escapes Korey-supplied text on the callback page", async () => {
    stubKorey();
    const host = await loadPlugin();
    const { state } = await startLogin(host);
    const page = await callback(
      host,
      `error=x&error_description=${encodeURIComponent("<script>alert(1)</script>")}&state=${state}`,
    );
    const html = await page.text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("completes a sign-in from a pasted redirect address", async () => {
    stubKorey();
    const host = await loadPlugin({});
    const { state } = await startLogin(host);
    await expect(
      host.harness.runCli([
        "login",
        `${CALLBACK_URL}?code=code-1&state=${state}`,
      ]),
    ).resolves.toMatchObject({
      exitCode: 0,
      // The plugin loaded without credentials, so bb shows a setup notice.
      stdout:
        "Connected to Korey as bb User in example. Run `bb plugin reload korey` to clear the setup notice.",
    });
  });

  it("rejects a sign-in without permission to read and write threads", async () => {
    const korey = stubKorey("threads:read");
    const host = await loadPlugin();
    const { state } = await startLogin(host);
    const page = await callback(host, `code=code-1&state=${state}`);
    expect(page.status).toBe(400);
    expect(await page.text()).toContain(
      "bb needs permission to read and write your Korey threads.",
    );
    expect(form(korey.to("/oauth/token/revoke")[0]?.init)).toMatchObject({
      token: "kt_oauth_1",
    });
    await expect(host.harness.runCli(["status"])).resolves.toMatchObject({
      stdout:
        "Authenticated as bb User in example with a personal access token.",
    });
  });

  it("keeps the client registration when only the loopback port changes", async () => {
    const korey = stubKorey();
    const values = new Map<string, unknown>();
    let callbackUrl = CALLBACK_URL;
    const connection = new KoreyConnection({
      kv: {
        get: async <T>(key: string) => values.get(key) as T | undefined,
        set: async (key, value) => void values.set(key, value),
        delete: async (key) => void values.delete(key),
      },
      callbackUrl: () => callbackUrl,
      readCredentials: async () => undefined,
      writeCredentials: async () => undefined,
      oauth: new KoreyOAuth(),
    });
    await connection.start();
    callbackUrl = CALLBACK_URL.replace(":38886", ":41234");
    const { authorizationUrl } = await connection.start();
    expect(korey.to("/oauth/register")).toHaveLength(1);
    expect(new URL(authorizationUrl).searchParams.get("redirect_uri")).toBe(
      callbackUrl,
    );
  });

  it("reuses the registration of an unfinished sign-in", async () => {
    const korey = stubKorey();
    const host = await loadPlugin();
    const first = await startLogin(host);
    const second = await startLogin(host);
    expect(korey.to("/oauth/register")).toHaveLength(1);
    expect(second.url.searchParams.get("client_id")).toBe(
      first.url.searchParams.get("client_id"),
    );
    expect(second.state).not.toBe(first.state);
  });

  it("reuses the registration while a saved connection uses it", async () => {
    const korey = stubKorey();
    const host = await loadPlugin();
    const { state } = await startLogin(host);
    await callback(host, `code=code-1&state=${state}`);
    const again = await startLogin(host);
    expect(korey.to("/oauth/register")).toHaveLength(1);
    expect(again.url.searchParams.get("client_id")).toBe("kc_client_1");
  });

  it("registers a new client when no saved connection uses the stored one", async () => {
    const korey = stubKorey();
    const host = await loadPlugin();
    const { state } = await startLogin(host);
    await callback(host, `code=code-1&state=${state}`);
    await host.harness.behavior.setSettings({ oauthCredentials: null });
    await startLogin(host);
    expect(korey.to("/oauth/register")).toHaveLength(2);
  });

  it("registers a new client after Korey rejects the saved sign-in", async () => {
    let clientDeleted = false;
    const korey = stubKorey(undefined, (url) => {
      if (!clientDeleted) return undefined;
      if (url === "https://api.korey.ai/api/v1/me") {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      if (url === "https://api.korey.ai/oauth/token") {
        return jsonResponse({ error: "invalid_client" }, 401);
      }
      return undefined;
    });
    const host = await loadPlugin({});
    const { state } = await startLogin(host);
    await callback(host, `code=code-1&state=${state}`);

    clientDeleted = true;
    const status = await host.harness.runCli(["status"]);
    expect(status.exitCode).toBe(1);
    expect(status.stderr).toContain("Korey sign-in expired or was revoked");

    clientDeleted = false;
    const again = await startLogin(host);
    expect(korey.to("/oauth/register")).toHaveLength(2);
    expect(again.url.searchParams.get("client_id")).not.toBe("kc_client_1");
  });

  it("refreshes an expiring token and keeps the rotation after a reload", async () => {
    const korey = stubKorey();
    const saved: OAuthCredentials = {
      version: 1,
      clientId: "kc_saved",
      accessToken: "kt_oauth_expiring",
      refreshToken: "kt_refresh_saved",
      expiresAt: Date.now() + 30_000,
      scope: "threads:read threads:write",
    };
    const host = await loadPlugin({ oauthCredentials: JSON.stringify(saved) });
    expect(host.harness.needsConfigurationMessages).toEqual([]);

    expect((await host.harness.runCli(["status"])).exitCode).toBe(0);
    expect(form(korey.to("/oauth/token")[0]?.init)).toEqual({
      grant_type: "refresh_token",
      client_id: "kc_saved",
      refresh_token: "kt_refresh_saved",
    });
    expect(bearer(korey.to("/api/v1/me")[0])).toBe("Bearer kt_oauth_1");

    const reloaded = await host.harness.lifecycle.reload(koreyPlugin);
    hosts.push(reloaded);
    expect((await reloaded.harness.runCli(["status"])).exitCode).toBe(0);
    expect(korey.to("/oauth/token")).toHaveLength(1);
    expect(bearer(korey.to("/api/v1/me")[1])).toBe("Bearer kt_oauth_1");
  });

  it("logs out by revoking the access token and falling back to the token", async () => {
    const korey = stubKorey();
    const host = await loadPlugin();
    const { state } = await startLogin(host);
    await callback(host, `code=code-1&state=${state}`);

    await expect(host.harness.runCli(["logout"])).resolves.toMatchObject({
      exitCode: 0,
      stdout:
        "Disconnected your Korey account. The personal access token setting is used from now on.",
    });
    const revoke = korey.to("/oauth/token/revoke")[0];
    expect(new Headers(revoke?.init?.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("kc_client_1:").toString("base64")}`,
    );
    expect(form(revoke?.init)).toMatchObject({ token: "kt_oauth_1" });

    await expect(host.harness.runCli(["status"])).resolves.toMatchObject({
      stdout:
        "Authenticated as bb User in example with a personal access token.",
    });
    await startLogin(host);
    expect(korey.to("/oauth/register")).toHaveLength(2);
  });

  it("drives the settings connection flow over RPC", async () => {
    stubKorey();
    const host = await loadPlugin({});
    const disconnected = {
      method: "none",
      account: null,
      error: null,
      tokenSaved: false,
    };
    await expect(host.harness.callRpc("connection.status")).resolves.toEqual(
      disconnected,
    );
    const { authorizationUrl } = (await host.harness.callRpc(
      "connection.start",
    )) as { authorizationUrl: string };
    const state = new URL(authorizationUrl).searchParams.get("state");
    await expect(
      host.harness.callRpc("connection.complete", {
        redirectUrl: `${CALLBACK_URL}?code=code-1&state=${state}`,
      }),
    ).resolves.toEqual({
      method: "oauth",
      account: "bb User in example",
      error: null,
      tokenSaved: false,
    });
    await expect(
      host.harness.callRpc("connection.disconnect"),
    ).resolves.toEqual(disconnected);
  });

  it("removes the saved personal access token", async () => {
    const korey = stubKorey();
    const host = await loadPlugin();
    await expect(host.harness.callRpc("connection.status")).resolves.toEqual({
      method: "token",
      account: "bb User in example",
      error: null,
      tokenSaved: true,
    });
    await expect(
      host.harness.callRpc("connection.removeToken"),
    ).resolves.toEqual({
      method: "none",
      account: null,
      error: null,
      tokenSaved: false,
    });
    expect(host.harness.realtimeSignals).toEqual([
      expect.objectContaining({ channel: "connection" }),
    ]);
    const calls = korey.calls.length;
    const status = await host.harness.runCli(["status"]);
    expect(status.exitCode).toBe(1);
    expect(status.stderr).toContain("Korey is not configured");
    expect(korey.calls).toHaveLength(calls);
  });

  it("disconnects an unreadable saved connection", async () => {
    const korey = stubKorey();
    const host = await loadPlugin({
      apiToken: "kt_pat_test",
      oauthCredentials: "not json",
    });
    await expect(
      host.harness.callRpc("connection.disconnect"),
    ).resolves.toMatchObject({ method: "token", tokenSaved: true });
    expect(korey.to("/oauth/token/revoke")).toHaveLength(0);
  });

  it("reports an unreadable saved connection with recovery steps", async () => {
    stubKorey();
    const host = await loadPlugin({ oauthCredentials: "not json" });
    const result = await host.harness.runCli(["status"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "The saved Korey account connection is invalid",
    );
  });
});
