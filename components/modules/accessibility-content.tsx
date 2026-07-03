"use client";

import { useCallback, useEffect, useState } from "react";

// Faithful port of the PHP accessibility page (app/pages/accessibility.php):
// manage login email (verify / change with email code) and change password.
// Fed by the existing DB-backed /api/manage/accessibility route.

const EMAIL_CODE_MAX_ATTEMPTS = 5;

type AccUser = {
  id: number;
  email: string;
  name?: string;
  needsEmailVerification: boolean;
};

type PendingVerification = {
  id: number;
  email: string;
  expiresAt: string;
  createdAt: string;
  attemptCount: number;
  resendWaitSeconds: number;
};

type AccessibilityData = {
  ok: boolean;
  user: AccUser | null;
  pendingEmailVerification: PendingVerification | null;
  password: { minLength: number };
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function fmtDateTime(iso?: string): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function AccessibilityContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();

  const [user, setUser] = useState<AccUser | null>(null);
  const [pending, setPending] = useState<PendingVerification | null>(null);
  const [minLength, setMinLength] = useState(8);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<{ type: "success" | "danger"; text: string } | null>(null);

  // Email change form
  const [newEmail, setNewEmail] = useState("");
  const [currentPasswordEmail, setCurrentPasswordEmail] = useState("");
  // Confirm code form
  const [code, setCode] = useState("");
  // Password form
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/manage/accessibility?slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j: AccessibilityData) => {
        setUser(j.user ?? null);
        setPending(j.pendingEmailVerification ?? null);
        setMinLength(Number(j.password?.minLength ?? 8));
      })
      .catch(() => {
        setUser(null);
        setPending(null);
      })
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`accessibility${suffix}`.replace("&", "?")}`;
  }

  async function postAction(payload: Record<string, unknown>): Promise<void> {
    setFeedback(null);
    try {
      const res = await fetch(`/api/manage/accessibility?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ slug, ...payload }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.ok === false) {
        setFeedback({ type: "danger", text: String(j?.error ?? j?.message ?? "Errore.") });
        return;
      }
      setFeedback({ type: "success", text: String(j?.message ?? "Operazione completata.") });
      // Refresh state (pending verification / verified flag may have changed).
      load();
    } catch {
      setFeedback({ type: "danger", text: "Errore di rete." });
    }
  }

  const currentEmail = user?.email ?? "—";
  const isVerified = user ? !user.needsEmailVerification : false;
  const expLabel = pending ? fmtDateTime(pending.expiresAt) : "";
  const resendWait = pending?.resendWaitSeconds ?? 0;
  const remainingMs = pending
    ? Math.max(0, (Date.parse(pending.expiresAt) || 0) - Date.now())
    : 0;

  return (
    <div className="container-fluid">
      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Impostazioni</div>
          <h1 className="bs-page-title">Accessibilita</h1>
          <div className="bs-page-subtitle">Gestisci email di accesso, verifica e password.</div>
        </div>
      </div>

      {feedback ? (
        <div className={`alert alert-${feedback.type}`} role="alert">
          {feedback.text}
        </div>
      ) : null}

      <div className="row g-3">
        <div className="col-lg-7">
          <div className="card p-4">
            <div className="mt-3">
              <div className="fw-semibold mb-2">Email di accesso</div>
              <div className="small text-muted">
                Email attuale: <strong>{loading ? "—" : currentEmail}</strong>
                {!loading && user ? (
                  isVerified ? (
                    <span className="badge text-bg-success ms-2">Verificata</span>
                  ) : (
                    <span className="badge text-bg-warning text-dark ms-2">Da verificare</span>
                  )
                ) : null}
              </div>

              {!loading && user && !isVerified && !pending ? (
                <div className="alert alert-warning mt-3 mb-0">
                  <div className="fw-semibold">Verifica richiesta</div>
                  <div className="small">Per continuare a usare il gestionale devi verificare la tua email.</div>
                  <form
                    method="post"
                    className="mt-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      postAction({ action: "request_email_verify" });
                    }}
                  >
                    <input type="hidden" name="action" value="request_email_verify" />
                    <button className="btn btn-outline-primary" type="submit">
                      <i className="bi bi-envelope-check me-1" />
                      Invia codice verifica
                    </button>
                  </form>
                </div>
              ) : null}

              <form
                method="post"
                className="mt-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  postAction({
                    action: "request_email_change",
                    new_email: newEmail,
                    current_password_email: currentPasswordEmail,
                  });
                }}
              >
                <input type="hidden" name="action" value="request_email_change" />
                <div className="row g-2 align-items-end">
                  <div className="col-md-5">
                    <label className="form-label">Nuova email</label>
                    <input
                      className="form-control"
                      type="email"
                      name="new_email"
                      placeholder="nome@dominio.it"
                      required
                      value={newEmail}
                      onChange={(e) => setNewEmail(e.target.value)}
                    />
                  </div>
                  <div className="col-md-4">
                    <label className="form-label">Password attuale</label>
                    <input
                      className="form-control"
                      type="password"
                      name="current_password_email"
                      autoComplete="current-password"
                      required
                      value={currentPasswordEmail}
                      onChange={(e) => setCurrentPasswordEmail(e.target.value)}
                    />
                  </div>
                  <div className="col-md-3">
                    <button className="btn btn-outline-primary w-100" type="submit">
                      <i className="bi bi-envelope-check me-1" />
                      Invia codice
                    </button>
                  </div>
                </div>
              </form>

              {pending ? (
                <div
                  id="pendingEmailAlert"
                  className="alert alert-warning mt-3 mb-0"
                  data-remaining-ms={String(remainingMs)}
                >
                  <div className="fw-semibold">Verifica richiesta in corso</div>
                  <div className="small">
                    Email: <strong>{pending.email}</strong> - Scadenza: {expLabel}
                    {pending.attemptCount > 0 ? (
                      <> - Tentativi usati: {pending.attemptCount}/{EMAIL_CODE_MAX_ATTEMPTS}</>
                    ) : null}
                  </div>
                  <form
                    method="post"
                    className="mt-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      postAction({ action: "confirm_email_change", code });
                    }}
                  >
                    <input type="hidden" name="action" value="confirm_email_change" />
                    <div className="row g-2 align-items-end">
                      <div className="col-md-6">
                        <label className="form-label">Codice di conferma</label>
                        <input
                          className="form-control"
                          name="code"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          placeholder="123456"
                          required
                          value={code}
                          onChange={(e) => setCode(e.target.value)}
                        />
                      </div>
                      <div className="col-md-6">
                        <button className="btn btn-primary w-100" type="submit">
                          <i className="bi bi-check2-circle me-1" />
                          Conferma email
                        </button>
                      </div>
                    </div>
                  </form>
                  <div className="small text-warning mt-2 d-none" data-email-code-expired>
                    Il codice e scaduto. Reinvia un nuovo codice.
                  </div>
                  <form
                    method="post"
                    className="mt-2 d-flex flex-wrap align-items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      postAction({ action: "resend_email_code" });
                    }}
                  >
                    <input type="hidden" name="action" value="resend_email_code" />
                    <button
                      className="btn btn-outline-primary btn-sm"
                      type="submit"
                      id="resendEmailCodeBtn"
                      data-wait-seconds={String(resendWait)}
                      data-ready-label="Reinvia codice"
                      disabled={resendWait > 0}
                    >
                      <i className="bi bi-arrow-repeat me-1" />
                      <span data-resend-label>
                        {resendWait > 0 ? `Reinvia tra ${resendWait}s` : "Reinvia codice"}
                      </span>
                    </button>
                    <span className="small text-muted">Usalo se non hai ricevuto l'email o il codice e scaduto.</span>
                  </form>
                </div>
              ) : null}
            </div>

            <hr className="my-4" />

            <div>
              <div className="fw-semibold mb-2">Password</div>
              <form
                method="post"
                onSubmit={(e) => {
                  e.preventDefault();
                  postAction({
                    action: "change_password",
                    current_password: currentPassword,
                    new_password: newPassword,
                    new_password_confirm: newPasswordConfirm,
                  });
                }}
              >
                <input type="hidden" name="action" value="change_password" />

                <div className="row g-3">
                  <div className="col-12">
                    <label className="form-label">Password attuale</label>
                    <input
                      className="form-control"
                      type="password"
                      name="current_password"
                      autoComplete="current-password"
                      required
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                    />
                  </div>
                  <div className="col-md-6">
                    <label className="form-label">Nuova password</label>
                    <input
                      className="form-control"
                      type="password"
                      name="new_password"
                      autoComplete="new-password"
                      required
                      minLength={minLength}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                    />
                    <div className="form-text">Minimo {minLength} caratteri.</div>
                  </div>
                  <div className="col-md-6">
                    <label className="form-label">Conferma nuova password</label>
                    <input
                      className="form-control"
                      type="password"
                      name="new_password_confirm"
                      autoComplete="new-password"
                      required
                      minLength={minLength}
                      value={newPasswordConfirm}
                      onChange={(e) => setNewPasswordConfirm(e.target.value)}
                    />
                  </div>
                </div>

                <div className="mt-4 d-flex gap-2">
                  <button className="btn btn-primary" type="submit">
                    <i className="bi bi-key me-1" />
                    Aggiorna password
                  </button>
                  <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/dashboard`}>
                    Indietro
                  </a>
                </div>
              </form>
            </div>
          </div>
        </div>

        <div className="col-lg-5">
          <div className="card p-4">
            <div className="text-muted small">Note</div>
            <ul className="mb-0 text-muted">
              <li>Quando cambi email, la nuova email viene accettata solo dopo la verifica del codice e la password attuale.</li>
              <li>Il codice scade dopo 15 minuti, ha un limite di tentativi e puo essere reinviato dopo un breve intervallo.</li>
              <li>Per cambiare password e richiesta la password attuale e la conferma della nuova password.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
