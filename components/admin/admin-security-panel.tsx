"use client";

import { useCallback, useEffect, useState } from "react";

// Pannello "Sicurezza account" del SaaS Admin (Fase 1 blindatura 2026-07-18,
// ristilizzato Tailwind per la SPA in Fase 3): attivazione/disattivazione 2FA
// TOTP (con codici di backup mostrati UNA volta) e sessioni attive con revoca.

type AdminSession = {
  id: number;
  adminEmail: string;
  ip: string;
  userAgent: string;
  createdAt: string | null;
  lastSeenAt: string | null;
};

type SecurityState = {
  totpEnabled: boolean;
  totpPolicyRequired: boolean;
  isOwner: boolean;
  sessions: AdminSession[];
};

const inputCls = "h-10 w-full rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-[#365a96]";
const btnPrimary = "inline-flex h-10 items-center justify-center rounded-md bg-[#365a96] px-4 text-sm font-semibold text-white disabled:opacity-60";
const btnDanger = "inline-flex h-9 items-center justify-center rounded-md border border-red-200 px-3 text-sm font-semibold text-red-700 hover:bg-red-50";

export function AdminSecurityPanel() {
  const [state, setState] = useState<SecurityState | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [setupSecret, setSetupSecret] = useState("");
  const [setupUri, setSetupUri] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [disablePassword, setDisablePassword] = useState("");
  const [disableCode, setDisableCode] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/security");
      const data = await res.json();
      if (data.ok) setState({ totpEnabled: Boolean(data.totpEnabled), totpPolicyRequired: Boolean(data.totpPolicyRequired), isOwner: Boolean(data.isOwner), sessions: data.sessions ?? [] });
    } catch {
      /* pannello secondario: nessun blocco */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    setError("");
    setMessage("");
    try {
      const res = await fetch("/api/admin/security", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(String(data.error ?? "Operazione non riuscita."));
        return null;
      }
      return data as Record<string, unknown>;
    } catch {
      setError("Servizio non disponibile.");
      return null;
    }
  }

  async function startSetup() {
    const data = await post({ action: "totp_start" });
    if (!data) return;
    setSetupSecret(String(data.secret ?? ""));
    setSetupUri(String(data.uri ?? ""));
    setBackupCodes([]);
  }

  async function confirmSetup() {
    const data = await post({ action: "totp_confirm", code: setupCode });
    if (!data) return;
    setBackupCodes((data.backupCodes as string[]) ?? []);
    setSetupSecret("");
    setSetupUri("");
    setSetupCode("");
    setMessage("2FA attivata. Salva i codici di backup: non verranno più mostrati.");
    void load();
  }

  async function disableTotp() {
    const data = await post({ action: "totp_disable", password: disablePassword, code: disableCode });
    if (!data) return;
    setDisablePassword("");
    setDisableCode("");
    setBackupCodes([]);
    setMessage("2FA disattivata.");
    void load();
  }

  async function revokeSession(id: number) {
    const data = await post({ action: "session_revoke", id });
    if (!data) return;
    setMessage("Sessione revocata.");
    void load();
  }

  if (!state) return null;

  return (
    <div className="grid gap-4">
      {error ? <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</div> : null}
      {message ? <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">{message}</div> : null}

      {/* Policy piattaforma (solo owner): 2FA obbligatoria per tutti gli
          admin — chi non la ha viene bloccato sul pannello finche' non la
          configura (rifiniture 19/07). */}
      {state.isOwner ? (
        <section className="rounded-md border border-slate-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Policy: 2FA obbligatoria</h2>
              <p className="mt-1 text-sm text-slate-500">Con la policy attiva, ogni admin senza 2FA deve configurarla prima di usare il pannello.</p>
            </div>
            <button
              className={state.totpPolicyRequired ? btnDanger : btnPrimary}
              type="button"
              onClick={async () => {
                const data = await post({ action: "totp_policy_set", value: state.totpPolicyRequired ? "0" : "1" });
                if (data) { setMessage(state.totpPolicyRequired ? "Policy 2FA disattivata." : "Policy 2FA attivata."); void load(); }
              }}
            >
              {state.totpPolicyRequired ? "Disattiva policy" : "Attiva policy"}
            </button>
          </div>
        </section>
      ) : null}

      {/* ---- 2FA ---- */}
      <section className="rounded-md border border-slate-200 bg-white p-5">
        <h2 className="text-lg font-semibold">Autenticazione a due fattori (TOTP)</h2>
        {state.totpEnabled ? (
          <div className="mt-4 grid gap-3">
            <span className="w-fit rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">2FA attiva</span>
            <div className="grid gap-3 md:grid-cols-3">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-600">Password</span>
                <input className={inputCls} type="password" value={disablePassword} onChange={(e) => setDisablePassword(e.target.value)} />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-600">Codice 2FA o backup</span>
                <input className={inputCls} value={disableCode} onChange={(e) => setDisableCode(e.target.value)} />
              </label>
              <div className="self-end">
                <button className={btnDanger} type="button" onClick={() => void disableTotp()}>Disattiva 2FA</button>
              </div>
            </div>
          </div>
        ) : setupSecret ? (
          <div className="mt-4 grid gap-3">
            <p className="text-sm text-slate-600">
              Aggiungi la chiave alla tua app authenticator (Google Authenticator, 1Password, Aegis…):
            </p>
            <code className="w-fit rounded-md bg-slate-100 px-3 py-2 text-base tracking-widest">{setupSecret}</code>
            <p className="break-all text-xs text-slate-400">{setupUri}</p>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-600">Codice a 6 cifre per confermare</span>
                <input className={inputCls} value={setupCode} onChange={(e) => setSetupCode(e.target.value)} />
              </label>
              <div className="self-end">
                <button className={btnPrimary} type="button" onClick={() => void confirmSetup()}>Conferma e attiva</button>
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-4">
            <p className="mb-3 text-sm text-slate-600">
              La 2FA protegge il pannello anche se la password viene compromessa. Fortemente consigliata per gli owner.
            </p>
            <button className={btnPrimary} type="button" onClick={() => void startSetup()}>Attiva 2FA</button>
          </div>
        )}

        {backupCodes.length ? (
          <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
            <strong>Codici di backup (salvali ora):</strong>
            <div className="mt-2 font-mono">{backupCodes.join("  ")}</div>
          </div>
        ) : null}
      </section>

      {/* ---- Sessioni attive ---- */}
      <section className="rounded-md border border-slate-200 bg-white p-5">
        <h2 className="text-lg font-semibold">Sessioni attive</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-3">Admin</th>
                <th className="py-2 pr-3">IP</th>
                <th className="py-2 pr-3">Ultimo accesso</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {state.sessions.map((s) => (
                <tr className="border-b border-slate-100" key={s.id}>
                  <td className="py-2 pr-3">{s.adminEmail}</td>
                  <td className="py-2 pr-3">{s.ip || "—"}</td>
                  <td className="py-2 pr-3">{s.lastSeenAt ?? s.createdAt ?? "—"}</td>
                  <td className="py-2 text-right">
                    <button className={btnDanger} type="button" onClick={() => void revokeSession(s.id)}>
                      Revoca
                    </button>
                  </td>
                </tr>
              ))}
              {state.sessions.length === 0 ? (
                <tr><td className="py-3 text-slate-500" colSpan={4}>Nessuna sessione attiva.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
