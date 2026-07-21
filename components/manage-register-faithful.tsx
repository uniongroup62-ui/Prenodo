"use client";

import { useState } from "react";
import { ManageAuthShell } from "@/components/manage-auth-shell";

// Pixel-faithful port of the PHP /manage/register page + email-code verify step
// (app/pages/manage_account.php register/verify flow). Reproduces the original
// markup/classes and submits to the existing JSON signup API routes.

type Step = "register" | "verify";

function normalizeSlug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9_-]+/g, "")
    .slice(0, 62);
}

export function ManageRegisterFaithful({
  initialStep = "register",
  initialSlug = "",
  initialEmail = "",
  initialSignupId = 0,
}: {
  initialStep?: Step;
  initialSlug?: string;
  initialEmail?: string;
  initialSignupId?: number;
}) {
  const [step, setStep] = useState<Step>(initialStep);

  // Register fields.
  const [businessName, setBusinessName] = useState("");
  const [slug, setSlug] = useState(initialSlug);
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState(initialEmail);
  const [ownerPhone, setOwnerPhone] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [terms, setTerms] = useState(false);

  // Verify fields.
  const [signupId, setSignupId] = useState(initialSignupId);
  const [pendingEmail, setPendingEmail] = useState(initialEmail);
  const [verificationCode, setVerificationCode] = useState("");

  // Slug availability hint (.manage-url-status).
  const [urlStatus, setUrlStatus] = useState<{ kind: "available" | "unavailable" | "invalid"; text: string } | null>(null);

  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function checkSlug() {
    const value = normalizeSlug(slug || businessName);
    if (!value) {
      setUrlStatus(null);
      return;
    }
    try {
      const res = await fetch(
        `/manage/check-url?slug=${encodeURIComponent(value)}&business_name=${encodeURIComponent(businessName)}`,
      );
      const data = await res.json() as { available?: boolean; reason?: string; message?: string };
      if (data.available) {
        setUrlStatus({ kind: "available", text: data.message || "URL disponibile." });
      } else {
        setUrlStatus({
          kind: data.reason === "invalid" ? "invalid" : "unavailable",
          text: data.message || "URL non disponibile.",
        });
      }
    } catch {
      setUrlStatus(null);
    }
  }

  async function onRegister(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    if (password !== passwordConfirm) {
      setError("Le password non coincidono.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/manage/signup/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          business_name: businessName,
          slug: normalizeSlug(slug || businessName),
          owner_name: ownerName,
          owner_email: ownerEmail,
          owner_phone: ownerPhone,
          password,
          password_confirm: passwordConfirm,
          terms: terms ? "1" : "0",
        }),
      });
      const data = await res.json() as {
        ok?: boolean;
        signup_id?: number;
        email?: string;
        slug?: string;
        message?: string;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setError(data.error || "Registrazione non riuscita.");
        setSubmitting(false);
        return;
      }
      setSignupId(data.signup_id ?? 0);
      setPendingEmail(data.email ?? ownerEmail);
      setSlug(data.slug ?? slug);
      setVerificationCode("");
      setMessage(data.message ?? "Codice di verifica inviato via email.");
      setStep("verify");
      setSubmitting(false);
    } catch {
      setError("Servizio non disponibile. Riprova.");
      setSubmitting(false);
    }
  }

  async function onVerify(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/manage/signup/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signup_id: signupId,
          email: pendingEmail,
          code: verificationCode,
        }),
      });
      const data = await res.json() as { ok?: boolean; redirectTo?: string; slug?: string; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error || "Verifica non riuscita.");
        setSubmitting(false);
        return;
      }
      window.location.href = data.redirectTo || `/${encodeURIComponent(data.slug ?? slug)}/dashboard`;
    } catch {
      setError("Servizio non disponibile. Riprova.");
      setSubmitting(false);
    }
  }

  async function onResend(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/manage/signup/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signup_id: signupId, email: pendingEmail }),
      });
      const data = await res.json() as {
        ok?: boolean;
        signup_id?: number;
        email?: string;
        slug?: string;
        message?: string;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setError(data.error || "Reinvio codice non riuscito.");
        setSubmitting(false);
        return;
      }
      setSignupId(data.signup_id ?? signupId);
      setPendingEmail(data.email ?? pendingEmail);
      setSlug(data.slug ?? slug);
      setMessage(data.message ?? "Nuovo codice inviato via email.");
      setSubmitting(false);
    } catch {
      setError("Servizio non disponibile. Riprova.");
      setSubmitting(false);
    }
  }

  const title = step === "verify" ? "Verifica la tua email" : "Crea il tuo gestionale";
  const lead =
    step === "verify"
      ? "Inserisci il codice ricevuto via email per creare il gestionale."
      : "Registra la tua attivita e configura prenotazioni, sedi e operatori.";

  return (
    <ManageAuthShell>
      <section className="auth-card">
        {error ? <div className="alert">{error}</div> : null}
        {message ? <div className="alert alert-success">{message}</div> : null}

        <h1>{title}</h1>
        <p className="lead">{lead}</p>

        {step === "register" ? (
          <form className="form" method="post" onSubmit={onRegister}>
            <label>
              Nome attivita
              <input
                type="text"
                name="business_name"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                autoComplete="organization"
                required
              />
            </label>
            <label>
              URL attivita
              <input
                type="text"
                name="slug"
                value={slug}
                onChange={(e) => {
                  setSlug(e.target.value);
                  setUrlStatus(null);
                }}
                onBlur={checkSlug}
                placeholder="centroesteticoelite"
                autoComplete="off"
                required
              />
            </label>
            <div
              className="manage-url-status"
              aria-live="polite"
              data-state={urlStatus?.kind}
              hidden={!urlStatus}
            >
              {urlStatus?.text}
            </div>
            <label>
              Nome e cognome
              <input
                type="text"
                name="owner_name"
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
                autoComplete="name"
                required
              />
            </label>
            <label>
              Email
              <input
                type="email"
                name="owner_email"
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
                autoComplete="email"
                required
              />
            </label>
            <label>
              Telefono <span className="muted-inline">(facoltativo)</span>
              <input
                type="tel"
                name="owner_phone"
                value={ownerPhone}
                onChange={(e) => setOwnerPhone(e.target.value)}
                autoComplete="tel"
              />
            </label>
            <div className="grid-2">
              <label>
                Password
                <input
                  type="password"
                  name="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </label>
              <label>
                Conferma password
                <input
                  type="password"
                  name="password_confirm"
                  value={passwordConfirm}
                  onChange={(e) => setPasswordConfirm(e.target.value)}
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </label>
            </div>
            <label className="manage-check">
              <input
                type="checkbox"
                name="terms"
                value="1"
                checked={terms}
                onChange={(e) => setTerms(e.target.checked)}
                required
              />
              <span>
                Accetto i{" "}
                <a href="/legal/termini" target="_blank" rel="noopener noreferrer">
                  termini di servizio
                </a>{" "}
                e{" "}
                <a href="/legal/privacy" target="_blank" rel="noopener noreferrer">
                  l&apos;informativa privacy
                </a>
                .
              </span>
            </label>
            <button className="auth-submit" type="submit" disabled={submitting}>
              Crea gestionale
            </button>
            <div className="links">
              <a href="/manage/login">Hai gia un gestionale?</a>
            </div>
          </form>
        ) : pendingEmail !== "" ? (
          <>
            <form className="form" method="post" onSubmit={onVerify}>
              <div className="manage-empty">
                <strong>Codice inviato</strong>
                <p>
                  Abbiamo inviato un codice a 6 cifre a <strong>{pendingEmail}</strong>. Il codice resta valido per 15
                  minuti.
                </p>
              </div>
              <label>
                Codice di verifica
                <input
                  className="manage-code-input"
                  type="text"
                  name="verification_code"
                  value={verificationCode}
                  onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  autoComplete="one-time-code"
                  required
                  autoFocus
                />
              </label>
              <button className="auth-submit" type="submit" disabled={submitting}>
                Verifica e crea gestionale
              </button>
            </form>
            <form className="manage-resend" method="post" onSubmit={onResend}>
              <button className="manage-link-button" type="submit" disabled={submitting}>
                Reinvia codice
              </button>
            </form>
            <div className="links links--start">
              <a href="/manage/login">Torna al login</a>
              <span>|</span>
              <a href="/manage/register">Nuova registrazione</a>
            </div>
          </>
        ) : (
          <>
            <div className="manage-empty">
              <strong>Nessuna registrazione in verifica</strong>
              <p>Avvia una nuova registrazione per ricevere il codice email.</p>
            </div>
            <div className="links links--start">
              <a href="/manage/register">Nuova registrazione</a>
            </div>
          </>
        )}
      </section>
    </ManageAuthShell>
  );
}
