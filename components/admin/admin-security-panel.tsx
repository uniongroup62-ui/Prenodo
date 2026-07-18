"use client";

import { useCallback, useEffect, useState } from "react";

// Pannello "Sicurezza account" della dashboard SaaS Admin (Fase 1 blindatura
// 2026-07-18): attivazione/disattivazione 2FA TOTP (con codici di backup
// mostrati UNA volta) e lista delle sessioni attive con revoca remota.

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
  sessions: AdminSession[];
};

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
      if (data.ok) setState({ totpEnabled: Boolean(data.totpEnabled), sessions: data.sessions ?? [] });
    } catch {
      /* pannello secondario: nessun blocco della dashboard */
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
    <div className="card-panel" style={{ marginTop: 18 }}>
      <div className="page-head" style={{ marginBottom: 8 }}>
        <div>
          <div className="page-eyebrow">Sicurezza account</div>
          <h2 style={{ margin: 0 }}>2FA e sessioni attive</h2>
        </div>
      </div>

      {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}
      {message ? <div className="alert alert-success" role="alert">{message}</div> : null}

      {/* ---- 2FA ---- */}
      {state.totpEnabled ? (
        <div className="form-grid">
          <div className="span-12"><span className="badge text-bg-success">2FA attiva</span></div>
          <div className="span-4">
            <label className="form-label">Password</label>
            <input className="form-control" type="password" value={disablePassword} onChange={(e) => setDisablePassword(e.target.value)} />
          </div>
          <div className="span-4">
            <label className="form-label">Codice 2FA o backup</label>
            <input className="form-control" value={disableCode} onChange={(e) => setDisableCode(e.target.value)} />
          </div>
          <div className="span-4" style={{ alignSelf: "end" }}>
            <button className="btn btn-outline-danger" type="button" onClick={() => void disableTotp()}>Disattiva 2FA</button>
          </div>
        </div>
      ) : setupSecret ? (
        <div className="form-grid">
          <div className="span-12">
            <p style={{ marginBottom: 6 }}>
              Aggiungi la chiave alla tua app authenticator (Google Authenticator, 1Password, Aegis…):
            </p>
            <code style={{ fontSize: 15, letterSpacing: 1 }}>{setupSecret}</code>
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4, wordBreak: "break-all" }}>{setupUri}</div>
          </div>
          <div className="span-6">
            <label className="form-label">Codice a 6 cifre per confermare</label>
            <input className="form-control" value={setupCode} onChange={(e) => setSetupCode(e.target.value)} />
          </div>
          <div className="span-6" style={{ alignSelf: "end" }}>
            <button className="btn btn-primary" type="button" onClick={() => void confirmSetup()}>Conferma e attiva</button>
          </div>
        </div>
      ) : (
        <div>
          <p style={{ marginBottom: 10 }}>
            La 2FA protegge il pannello anche se la password viene compromessa. Fortemente consigliata per gli owner.
          </p>
          <button className="btn btn-primary" type="button" onClick={() => void startSetup()}>Attiva 2FA</button>
        </div>
      )}

      {backupCodes.length ? (
        <div className="alert alert-warning" style={{ marginTop: 12 }}>
          <strong>Codici di backup (salvali ora):</strong>
          <div style={{ fontFamily: "monospace", marginTop: 6 }}>{backupCodes.join("  ")}</div>
        </div>
      ) : null}

      {/* ---- Sessioni attive ---- */}
      <h3 style={{ marginTop: 18, fontSize: 16 }}>Sessioni attive</h3>
      <div className="table-responsive">
        <table className="table table-sm align-middle">
          <thead>
            <tr>
              <th>Admin</th>
              <th>IP</th>
              <th>Ultimo accesso</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {state.sessions.map((s) => (
              <tr key={s.id}>
                <td>{s.adminEmail}</td>
                <td>{s.ip || "—"}</td>
                <td>{s.lastSeenAt ?? s.createdAt ?? "—"}</td>
                <td className="text-end">
                  <button className="btn btn-sm btn-outline-danger" type="button" onClick={() => void revokeSession(s.id)}>
                    Revoca
                  </button>
                </td>
              </tr>
            ))}
            {state.sessions.length === 0 ? (
              <tr><td colSpan={4}>Nessuna sessione attiva.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
