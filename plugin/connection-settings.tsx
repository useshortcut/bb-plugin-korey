import { useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import {
  CONNECTION_SIGNAL_CHANNEL,
  type ConnectionView,
  type connectionRpcContract,
} from "./contracts.js";

const buttonClass =
  "rounded-md border border-border px-3 py-1.5 disabled:opacity-50";
const primaryButtonClass =
  "rounded-md bg-primary px-3 py-1.5 font-semibold text-primary-foreground disabled:opacity-50";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeAccount(view: ConnectionView): string {
  if (view.method !== "oauth") return "Your Korey account is not connected.";
  return view.account === null
    ? "Your Korey account is connected."
    : `Connected as ${view.account}.`;
}

function describeToken(view: ConnectionView): string {
  if (view.method === "oauth") {
    return "A personal access token is also saved. bb uses it only while your Korey account is disconnected.";
  }
  return view.account === null
    ? "bb is using the saved personal access token."
    : `bb is using the saved personal access token for ${view.account}.`;
}

export function ConnectionSettings() {
  const rpc = useRpc<typeof connectionRpcContract>();
  // Read the latest client without re-running the status effect if the host
  // returns a new client object on each render.
  const rpcRef = useRef(rpc);
  useEffect(() => {
    rpcRef.current = rpc;
  });
  const navigate = useBbNavigate();
  const [view, setView] = useState<ConnectionView | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [redirectUrl, setRedirectUrl] = useState("");
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  }, []);

  const refresh = useCallback(async (): Promise<ConnectionView | null> => {
    try {
      const next = await rpcRef.current.call("connection.status");
      setView(next);
      return next;
    } catch (failure) {
      setError(message(failure));
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Any settings change publishes this signal. Close the pending sign-in
  // only once the account is connected, for example by the browser callback.
  useRealtime(CONNECTION_SIGNAL_CHANNEL, () => {
    void refresh().then((next) => {
      if (next?.method !== "oauth") return;
      setAuthorizationUrl(null);
      setRedirectUrl("");
    });
  });

  const connect = () =>
    run(async () => {
      const started = await rpc.call("connection.start");
      setAuthorizationUrl(started.authorizationUrl);
      navigate.openUrl(started.authorizationUrl);
    });

  const complete = () =>
    run(async () => {
      setView(await rpc.call("connection.complete", { redirectUrl }));
      setAuthorizationUrl(null);
      setRedirectUrl("");
    });

  const disconnect = () =>
    run(async () => {
      setView(await rpc.call("connection.disconnect"));
    });

  const removeToken = () =>
    run(async () => {
      setView(await rpc.call("connection.removeToken"));
      setConfirmingRemoval(false);
    });

  if (view === null) {
    return (
      <div className="space-y-3 text-sm">
        <p>Checking the Korey connection...</p>
        {error ? <p className="text-destructive">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="space-y-3 text-sm">
      <p>{describeAccount(view)}</p>
      {view.error ? <p className="text-destructive">{view.error}</p> : null}
      {error ? <p className="text-destructive">{error}</p> : null}
      {authorizationUrl !== null ? (
        <div className="space-y-2 rounded-md border border-border p-3">
          <p>
            Approve access in the browser.{" "}
            <a
              className="underline"
              href={authorizationUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open the Korey sign-in page
            </a>{" "}
            if it did not open.
          </p>
          <label className="block space-y-1">
            <span>
              If the browser ends on a page that cannot load, paste that page's
              address:
            </span>
            <input
              className="w-full rounded-md border border-border bg-transparent px-2 py-1"
              value={redirectUrl}
              onChange={(event) => setRedirectUrl(event.target.value)}
              placeholder="http://127.0.0.1:..."
            />
          </label>
          <button
            type="button"
            className={buttonClass}
            disabled={busy || redirectUrl.trim().length === 0}
            onClick={() => void complete()}
          >
            Finish connecting
          </button>
        </div>
      ) : null}
      <div className="flex gap-2">
        {view.method === "oauth" ? (
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => void disconnect()}
          >
            Disconnect
          </button>
        ) : (
          <button
            type="button"
            className={primaryButtonClass}
            disabled={busy}
            onClick={() => void connect()}
          >
            {authorizationUrl === null ? "Connect Korey" : "Start again"}
          </button>
        )}
      </div>
      {view.tokenSaved ? (
        <div className="space-y-2 border-t border-border pt-3">
          <p>{describeToken(view)}</p>
          {confirmingRemoval ? (
            <div className="space-y-2">
              <p>
                Remove the token from bb? It stays valid in Korey until you
                revoke it there.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={buttonClass}
                  disabled={busy}
                  onClick={() => setConfirmingRemoval(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={busy}
                  onClick={() => void removeToken()}
                >
                  Remove token
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() => setConfirmingRemoval(true)}
            >
              Remove personal access token
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
