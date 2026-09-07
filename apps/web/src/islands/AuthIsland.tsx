import { useEffect, useState } from "preact/hooks";
import { fetchSession, logout, type SessionState } from "../lib/client/api";

/**
 * Authentication status island. Personalized state arrives through a
 * client-side session request — the surrounding page stays static.
 */
export default function AuthIsland() {
  const [session, setSession] = useState<SessionState | null>(null);

  useEffect(() => {
    void fetchSession().then(setSession);
  }, []);

  if (session === null) {
    return (
      <p class="auth-status hint" aria-live="polite">
        Checking sign-in…
      </p>
    );
  }

  if (!session.authenticated) {
    return (
      <p class="auth-status">
        <a href="/api/auth/github/start" class="button">
          Sign in with GitHub
        </a>
        <span class="hint"> only for optional AI ideas.</span>
      </p>
    );
  }

  return (
    <p class="auth-status">
      <span aria-label="Signed in as">Signed in as</span>{" "}
      <strong>{session.user?.login ?? "GitHub user"}</strong>{" "}
      <button
        type="button"
        class="secondary"
        onClick={async () => {
          if (await logout()) setSession({ authenticated: false });
        }}
      >
        Log out
      </button>
    </p>
  );
}
