"use client";

import { useState } from "react";

// Pixel-faithful port of the legacy PHP /admin/login page.
// Markup mirrors the captured admin login HTML verbatim (admin-shell > admin-header
// + admin-main > page-head + card-panel > form.form-grid) using the original
// Bootstrap 5.3.3 + assets/admin.css classes.
//
// The legacy `_csrf` / `_form` hidden inputs are dropped: the form is wired to the
// JSON admin login API (POST /api/admin/auth/login) instead of the PHP form post.
export function AdminLoginFaithful() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // Step 2FA (Fase 1 blindatura): password valida + TOTP attivo -> challenge
  // firmata e richiesta del codice authenticator (o di backup).
  const [totpChallenge, setTotpChallenge] = useState("");
  const [totpCode, setTotpCode] = useState("");

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const payload = totpChallenge
        ? { mode: "totp", challenge: totpChallenge, code: totpCode }
        : { email, password };
      const res = await fetch("/api/admin/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || "Credenziali non valide.");
        setLoading(false);
        return;
      }
      if (data.needsTotp && data.challenge) {
        setTotpChallenge(String(data.challenge));
        setTotpCode("");
        setLoading(false);
        return;
      }
      window.location.href = data.redirectTo || "/admin";
    } catch {
      setError("Servizio non disponibile. Riprova.");
      setLoading(false);
    }
  }

  return (
    <>
      {/* Legacy admin pages load Bootstrap 5.3.3 + assets/admin.css. */}
      <link
        href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css"
        rel="stylesheet"
      />
      <link href="/admin/assets/admin.css" rel="stylesheet" />

      <div className="admin-shell">
        <header className="admin-header">
          <div>
            <a className="admin-brand" href="./">
              SaaS Admin
            </a>
            <div className="admin-subtitle">Gestione tenant, accessi e diagnostica.</div>
          </div>
        </header>

        <main className="admin-main">
          <div className="page-head">
            <div>
              <div className="page-eyebrow">Accesso</div>
              <h1>SaaS Admin</h1>
              <p>Entra nel pannello di gestione dei tenant.</p>
            </div>
          </div>
          <div className="card-panel" style={{ maxWidth: 620 }}>
            {error ? (
              <div className="alert alert-danger" role="alert">
                {error}
              </div>
            ) : null}
            <form method="post" className="form-grid" onSubmit={onSubmit}>
              {totpChallenge ? (
                <div className="span-12">
                  <label className="form-label">Codice a 6 cifre (app authenticator) o codice di backup</label>
                  <input
                    className="form-control"
                    name="totp_code"
                    type="text"
                    autoComplete="one-time-code"
                    autoFocus
                    value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value)}
                    required
                  />
                </div>
              ) : (
                <>
                  <div className="span-6">
                    <label className="form-label">Email</label>
                    <input
                      className="form-control"
                      name="email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                    />
                  </div>
                  <div className="span-6">
                    <label className="form-label">Password</label>
                    <input
                      className="form-control"
                      name="password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                  </div>
                </>
              )}
              <div className="span-12">
                <button className="btn btn-primary" type="submit" disabled={loading}>
                  {loading ? "Accesso…" : totpChallenge ? "Verifica codice" : "Entra"}
                </button>
              </div>
            </form>
          </div>
        </main>
      </div>
    </>
  );
}
