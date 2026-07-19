"use client";

import { useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";

// Login del pannello SaaS Admin — redesign identita' Prenodo (2026-07-19, su
// richiesta): split-screen con card bianca + pannello ink navy #141c30 e
// accenti #365a96, come il resto del pannello. La LOGICA e' invariata:
// POST /api/admin/auth/login; con 2FA attiva il server risponde
// needsTotp+challenge e si chiede il codice authenticator (o di backup).
export function AdminLoginFaithful() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
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

  const inputCls = "h-11 w-full rounded-md border border-slate-200 px-3 outline-none transition-colors focus:border-[#365a96]";

  return (
    <main className="min-h-screen bg-[#eef2f6] text-slate-950">
      <div className="flex min-h-screen">
        <section className="flex flex-1 items-center justify-center px-5 py-8">
          <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-7 shadow-sm">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-md bg-[#365a96] font-semibold text-white">P</span>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#365a96]">SaaS Admin</p>
                <h1 className="text-2xl font-semibold">{totpChallenge ? "Verifica in due passaggi" : "Accesso"}</h1>
              </div>
            </div>
            <p className="mt-2 text-sm text-slate-500">
              {totpChallenge
                ? "Inserisci il codice a 6 cifre dell'app authenticator, oppure un codice di backup."
                : "Entra nel pannello di gestione dei tenant Prenodo."}
            </p>

            {error ? (
              <div className="mt-5 rounded-md border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700" role="alert">
                {error}
              </div>
            ) : null}

            <form className="mt-6 space-y-4" onSubmit={onSubmit}>
              {totpChallenge ? (
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-slate-600">Codice authenticator o di backup</span>
                  <input
                    autoFocus
                    autoComplete="one-time-code"
                    className={`${inputCls} text-center text-lg tracking-[0.35em]`}
                    inputMode="numeric"
                    name="totp_code"
                    required
                    type="text"
                    value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value)}
                  />
                </label>
              ) : (
                <>
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium text-slate-600">Email</span>
                    <input className={inputCls} name="email" required type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium text-slate-600">Password</span>
                    <input className={inputCls} name="password" required type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
                  </label>
                </>
              )}

              <button
                className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-[#365a96] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#27436f] disabled:opacity-60"
                disabled={loading}
                type="submit"
              >
                {loading ? <Loader2 className="animate-spin" size={17} aria-hidden /> : <KeyRound size={17} aria-hidden />}
                {loading ? "Accesso…" : totpChallenge ? "Verifica codice" : "Entra"}
              </button>

              {totpChallenge ? (
                <button
                  className="w-full text-center text-sm font-semibold text-slate-500 hover:text-slate-700"
                  type="button"
                  onClick={() => { setTotpChallenge(""); setTotpCode(""); setError(""); }}
                >
                  Torna al login
                </button>
              ) : null}
            </form>
          </div>
        </section>
      </div>
    </main>
  );
}
