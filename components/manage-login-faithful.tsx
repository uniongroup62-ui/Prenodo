"use client";

import { useState } from "react";
import { ManageAuthShell } from "@/components/manage-auth-shell";
import { PasswordEye } from "@/components/public/password-eye";

// Pixel-faithful port of the PHP /manage/login page (app/pages/manage_account.php).
// Submits to the existing JSON auth API instead of the PHP form post.
export function ManageLoginFaithful({ initialSlug }: { initialSlug: string }) {
  const [slug, setSlug] = useState(initialSlug);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/manage/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, email, password }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || "Credenziali non valide.");
        setLoading(false);
        return;
      }
      window.location.href = data.redirectTo || `/${encodeURIComponent(slug)}/dashboard`;
    } catch {
      setError("Servizio non disponibile. Riprova.");
      setLoading(false);
    }
  }

  return (
    <ManageAuthShell>
      <section className="auth-card">
        {error ? <div className="alert">{error}</div> : null}

        <h1>Accedi al gestionale</h1>
        <p className="lead">Entra con URL attivita, email e password.</p>

        <form className="form" method="post" onSubmit={onSubmit}>
          <label>
            URL attivita
            <input
              type="text"
              name="login_slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="centroesteticoelite"
              autoComplete="organization"
              required
            />
          </label>
          <label>
            Email
            <input
              type="email"
              name="login_email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </label>
          <label>
            Password
            <span className="pw-field">
              <input
                type={showPassword ? "text" : "password"}
                name="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
              <button
                type="button"
                className="pw-toggle"
                aria-label={showPassword ? "Nascondi password" : "Mostra password"}
                onClick={() => setShowPassword((v) => !v)}
              >
                <PasswordEye open={showPassword} />
              </button>
            </span>
          </label>
          {/* Come il riferimento: link recupero a destra sotto il campo. */}
          <div className="form-row-after">
            <a href="/manage/forgot-password">Password dimenticata?</a>
          </div>
          <button className="auth-submit" type="submit" disabled={loading}>
            {loading ? "Accesso in corso…" : "Accedi"}
          </button>
          <div className="links">
            Non hai un account?&nbsp;<a href="/manage/register">Registrati</a>
          </div>
        </form>
      </section>
      <div className="auth-footer">
        <span>Copyright &copy; 2026 Prenodo.</span>
      </div>
    </ManageAuthShell>
  );
}
