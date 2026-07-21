"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, CheckCircle2, KeyRound, Loader2, Store, UserPlus } from "lucide-react";

type ManageMode = "login" | "register" | "verify" | "forgot-password" | "reset-password";

const modeCopy: Record<ManageMode, { title: string; lead: string }> = {
  login: {
    title: "Accedi al gestionale",
    lead: "Entra con URL attivita, email e password.",
  },
  register: {
    title: "Crea il tuo gestionale",
    lead: "Registra la tua attivita e configura prenotazioni, sedi e operatori.",
  },
  verify: {
    title: "Verifica la tua email",
    lead: "Inserisci il codice ricevuto via email per creare il gestionale.",
  },
  "forgot-password": {
    title: "Recupera password",
    lead: "Inserisci URL attivita ed email per ricevere il link sicuro.",
  },
  "reset-password": {
    title: "Reimposta password",
    lead: "Imposta una nuova password per accedere al gestionale.",
  },
};

export function ManageAccountPage({
  initialMode = "login",
  initialSlug = "",
  initialToken = "",
  initialEmail = "",
  initialSignupId = 0,
}: {
  initialMode?: ManageMode;
  initialSlug?: string;
  initialToken?: string;
  initialEmail?: string;
  initialSignupId?: number;
}) {
  const [mode, setMode] = useState<ManageMode>(initialMode);
  const [slug, setSlug] = useState(initialSlug);
  const [businessName, setBusinessName] = useState("Centro Estetico Elite");
  const [ownerName, setOwnerName] = useState("Elena Rossi");
  const [ownerPhone, setOwnerPhone] = useState("");
  const [email, setEmail] = useState(initialEmail || "");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [resetToken, setResetToken] = useState(initialToken);
  const [resetEmail, setResetEmail] = useState("");
  const [signupId, setSignupId] = useState(initialSignupId);
  const [verificationCode, setVerificationCode] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [message, setMessage] = useState("");
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);

  const copy = modeCopy[mode];
  const normalizedSlug = useMemo(() => normalizeSlug(slug || businessName), [businessName, slug]);

  useEffect(() => {
    let cancelled = false;
    if (mode !== "reset-password" || !resetToken || !normalizedSlug) return;

    async function validateToken() {
      try {
        const response = await fetch(`/api/manage/auth/reset-password?slug=${encodeURIComponent(normalizedSlug)}&token=${encodeURIComponent(resetToken)}`);
        const data = await response.json() as { ok?: boolean; reset?: { email?: string }; error?: string };
        if (cancelled) return;
        if (!response.ok || !data.ok) {
          setResetEmail("");
          setMessage(data.error ?? "Link non valido o scaduto.");
          return;
        }
        setResetEmail(data.reset?.email ?? "");
        setMessage("");
      } catch {
        if (!cancelled) setMessage("Verifica link non disponibile ora.");
      }
    }

    validateToken();
    return () => {
      cancelled = true;
    };
  }, [mode, normalizedSlug, resetToken]);

  async function checkSlug(value = normalizedSlug) {
    setChecking(true);
    try {
      const response = await fetch(`/manage/check-url?slug=${encodeURIComponent(value)}&business_name=${encodeURIComponent(businessName)}`);
      const data = await response.json();
      setAvailable(!!data.available);
      setMessage(data.message ?? "");
    } catch {
      setAvailable(null);
      setMessage("Verifica URL non disponibile ora. Il controllo finale verra eseguito al salvataggio.");
    } finally {
      setChecking(false);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (mode === "login") {
      setSubmitting(true);
      setMessage("");
      try {
        const response = await fetch("/api/manage/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: normalizedSlug, email, password }),
        });
        const data = await response.json() as { ok?: boolean; redirectTo?: string; error?: string };
        if (!response.ok || !data.ok) {
          setMessage(data.error ?? "Accesso non riuscito.");
          return;
        }
        window.location.href = data.redirectTo ?? `/${normalizedSlug}/dashboard`;
      } catch {
        setMessage("Accesso non disponibile ora.");
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (mode === "register") {
      if (password !== passwordConfirm) {
        setMessage("Le password non coincidono.");
        return;
      }

      setSubmitting(true);
      setMessage("");
      try {
        const response = await fetch("/api/manage/signup/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            business_name: businessName,
            slug: normalizedSlug,
            owner_name: ownerName,
            owner_phone: ownerPhone,
            owner_email: email,
            password,
            password_confirm: passwordConfirm,
            terms: termsAccepted ? "1" : "0",
            marketing_opt_in: marketingOptIn ? "1" : "0",
          }),
        });
        const data = await response.json() as {
          ok?: boolean;
          signup_id?: number;
          email?: string;
          slug?: string;
          verification_code?: string;
          message?: string;
          error?: string;
        };
        if (!response.ok || !data.ok) {
          setMessage(data.error ?? "Registrazione non riuscita.");
          return;
        }
        setSignupId(data.signup_id ?? 0);
        setEmail(data.email ?? email);
        setSlug(data.slug ?? normalizedSlug);
        setVerificationCode(data.verification_code ?? "");
        setAvailable(true);
        setMode("verify");
        setMessage(data.message ?? "Codice di verifica inviato via email.");
      } catch {
        setMessage("Registrazione non disponibile ora.");
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (mode === "verify") {
      setSubmitting(true);
      setMessage("");
      try {
        const response = await fetch("/api/manage/signup/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            signup_id: signupId,
            email,
            code: verificationCode,
          }),
        });
        const data = await response.json() as { ok?: boolean; redirectTo?: string; slug?: string; error?: string };
        if (!response.ok || !data.ok) {
          setMessage(data.error ?? "Verifica non riuscita.");
          return;
        }
        window.location.href = data.redirectTo ?? `/${data.slug ?? normalizedSlug}/dashboard`;
      } catch {
        setMessage("Verifica non disponibile ora.");
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (mode === "forgot-password") {
      setSubmitting(true);
      setMessage("");
      try {
        const response = await fetch("/api/manage/auth/forgot-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: normalizedSlug, email }),
        });
        const data = await response.json() as { ok?: boolean; message?: string; error?: string };
        setMessage(data.message ?? data.error ?? "Se i dati sono corretti, riceverai un link per reimpostare la password.");
      } catch {
        setMessage("Reset password non disponibile ora.");
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (mode === "reset-password") {
      if (!resetToken.trim()) {
        setMessage("Token reset mancante.");
        return;
      }
      if (password !== passwordConfirm) {
        setMessage("Le password non coincidono.");
        return;
      }

      setSubmitting(true);
      setMessage("");
      try {
        const response = await fetch("/api/manage/auth/reset-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slug: normalizedSlug,
            token: resetToken,
            password,
            password_confirm: passwordConfirm,
          }),
        });
        const data = await response.json() as { ok?: boolean; message?: string; error?: string };
        if (!response.ok || !data.ok) {
          setMessage(data.error ?? "Reset password non riuscito.");
          return;
        }
        setMode("login");
        setPassword("");
        setPasswordConfirm("");
        setMessage(data.message ?? "Password aggiornata. Ora puoi accedere.");
      } catch {
        setMessage("Reset password non disponibile ora.");
      } finally {
        setSubmitting(false);
      }
    }
  }

  async function resendSignupCode() {
    setSubmitting(true);
    setMessage("");
    try {
      const response = await fetch("/api/manage/signup/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signup_id: signupId, email }),
      });
      const data = await response.json() as {
        ok?: boolean;
        signup_id?: number;
        email?: string;
        slug?: string;
        verification_code?: string;
        message?: string;
        error?: string;
      };
      if (!response.ok || !data.ok) {
        setMessage(data.error ?? "Reinvio codice non riuscito.");
        return;
      }
      setSignupId(data.signup_id ?? signupId);
      setEmail(data.email ?? email);
      setSlug(data.slug ?? slug);
      setVerificationCode(data.verification_code ?? "");
      setMessage(data.message ?? "Nuovo codice inviato via email.");
    } catch {
      setMessage("Reinvio codice non disponibile ora.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#f7f6f2] text-[#191816]">
      <div className="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_minmax(420px,0.9fr)]">
        <section className="flex min-h-screen items-center justify-center px-4 py-8 sm:px-6">
          <div className="w-full max-w-md">
            <Link className="mb-6 inline-flex h-10 items-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-sm font-semibold" href="/attivita">
              <ArrowLeft size={16} aria-hidden />
              Marketplace
            </Link>
            <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
              <Link className="mb-6 flex items-center gap-3" href="/manage/login">
                <span className="flex h-10 w-10 items-center justify-center rounded-md bg-[#191816] text-white">
                  <Store size={18} aria-hidden />
                </span>
                <span className="text-lg font-semibold">Prenodo</span>
              </Link>

              {message ? (
                <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-800">
                  {message}
                </div>
              ) : null}

              <h1 className="text-3xl font-semibold">{copy.title}</h1>
              <p className="mt-2 text-sm leading-6 text-zinc-600">{copy.lead}</p>

              <form className="mt-5 space-y-3" onSubmit={submit}>
                {mode === "register" ? (
                  <>
                    <label className="block">
                      <span className="mb-1 block text-sm font-medium text-zinc-600">Nome attivita</span>
                      <input
                        className="h-11 w-full rounded-md border border-zinc-200 px-3 text-sm outline-none focus:border-zinc-900"
                        value={businessName}
                        onChange={(event) => {
                          setBusinessName(event.target.value);
                          setSlug(normalizeSlug(event.target.value));
                          setAvailable(null);
                        }}
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-sm font-medium text-zinc-600">URL attivita</span>
                      <div className="flex gap-2">
                        <input
                          className="h-11 min-w-0 flex-1 rounded-md border border-zinc-200 px-3 text-sm outline-none focus:border-zinc-900"
                          value={slug}
                          onBlur={() => checkSlug()}
                          onChange={(event) => {
                            setSlug(normalizeSlug(event.target.value));
                            setAvailable(null);
                          }}
                        />
                        <button
                          className="flex h-11 w-11 items-center justify-center rounded-md border border-zinc-200"
                          title="Verifica URL"
                          type="button"
                          onClick={() => checkSlug()}
                        >
                          {checking ? <Loader2 className="animate-spin" size={17} aria-hidden /> : <CheckCircle2 size={17} aria-hidden />}
                        </button>
                      </div>
                      {available !== null ? (
                        <span className={`mt-1 block text-xs font-semibold ${available ? "text-emerald-700" : "text-amber-700"}`}>
                          {available ? "URL disponibile" : "URL non disponibile"}
                        </span>
                      ) : null}
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-sm font-medium text-zinc-600">Nome e cognome</span>
                      <input
                        className="h-11 w-full rounded-md border border-zinc-200 px-3 text-sm outline-none focus:border-zinc-900"
                        value={ownerName}
                        onChange={(event) => setOwnerName(event.target.value)}
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-sm font-medium text-zinc-600">Telefono</span>
                      <input
                        className="h-11 w-full rounded-md border border-zinc-200 px-3 text-sm outline-none focus:border-zinc-900"
                        value={ownerPhone}
                        onChange={(event) => setOwnerPhone(event.target.value)}
                      />
                    </label>
                  </>
                ) : null}

                {mode === "login" || mode === "forgot-password" || mode === "reset-password" ? (
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium text-zinc-600">URL attivita</span>
                    <input
                      className="h-11 w-full rounded-md border border-zinc-200 px-3 text-sm outline-none focus:border-zinc-900"
                      value={slug}
                      onChange={(event) => setSlug(normalizeSlug(event.target.value))}
                      placeholder="centroesteticoelite"
                    />
                  </label>
                ) : null}

                {mode === "reset-password" && !resetToken ? (
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium text-zinc-600">Token reset</span>
                    <input
                      className="h-11 w-full rounded-md border border-zinc-200 px-3 text-sm outline-none focus:border-zinc-900"
                      value={resetToken}
                      onChange={(event) => setResetToken(event.target.value.trim())}
                    />
                  </label>
                ) : null}

                {mode === "reset-password" && resetEmail ? (
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium text-zinc-600">Account</span>
                    <input
                      className="h-11 w-full rounded-md border border-zinc-200 bg-zinc-50 px-3 text-sm text-zinc-600 outline-none"
                      value={resetEmail}
                      disabled
                    />
                  </label>
                ) : null}

                {mode !== "verify" && mode !== "reset-password" ? (
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium text-zinc-600">Email</span>
                    <input
                      className="h-11 w-full rounded-md border border-zinc-200 px-3 text-sm outline-none focus:border-zinc-900"
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                  </label>
                ) : null}

                {mode === "verify" ? (
                  <>
                    <label className="block">
                      <span className="mb-1 block text-sm font-medium text-zinc-600">Email</span>
                      <input
                        className="h-11 w-full rounded-md border border-zinc-200 bg-zinc-50 px-3 text-sm text-zinc-600 outline-none"
                        value={email}
                        disabled
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-sm font-medium text-zinc-600">Codice di verifica</span>
                      <input
                        className="h-11 w-full rounded-md border border-zinc-200 px-3 text-center text-lg font-semibold tracking-[0.3em] outline-none focus:border-zinc-900"
                        inputMode="numeric"
                        maxLength={6}
                        value={verificationCode}
                        onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                      />
                    </label>
                  </>
                ) : null}

                {mode === "login" || mode === "register" || mode === "reset-password" ? (
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium text-zinc-600">
                      {mode === "reset-password" ? "Nuova password" : "Password"}
                    </span>
                    <input
                      className="h-11 w-full rounded-md border border-zinc-200 px-3 text-sm outline-none focus:border-zinc-900"
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      minLength={8}
                    />
                  </label>
                ) : null}

                {mode === "register" || mode === "reset-password" ? (
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium text-zinc-600">
                      {mode === "reset-password" ? "Conferma nuova password" : "Conferma password"}
                    </span>
                    <input
                      className="h-11 w-full rounded-md border border-zinc-200 px-3 text-sm outline-none focus:border-zinc-900"
                      type="password"
                      value={passwordConfirm}
                      onChange={(event) => setPasswordConfirm(event.target.value)}
                      minLength={8}
                    />
                  </label>
                ) : null}

                {mode === "register" ? (
                  <div className="space-y-2 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700">
                    <label className="flex items-start gap-2">
                      <input
                        className="mt-1 h-4 w-4 rounded border-zinc-300"
                        type="checkbox"
                        checked={termsAccepted}
                        onChange={(event) => setTermsAccepted(event.target.checked)}
                      />
                      <span>Accetto termini del servizio e privacy.</span>
                    </label>
                    <label className="flex items-start gap-2">
                      <input
                        className="mt-1 h-4 w-4 rounded border-zinc-300"
                        type="checkbox"
                        checked={marketingOptIn}
                        onChange={(event) => setMarketingOptIn(event.target.checked)}
                      />
                      <span>Voglio ricevere aggiornamenti sul servizio.</span>
                    </label>
                  </div>
                ) : null}

                <button className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-[#191816] px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-70" disabled={submitting}>
                  {submitting ? <Loader2 className="animate-spin" size={17} aria-hidden /> : mode === "register" ? <UserPlus size={17} aria-hidden /> : <KeyRound size={17} aria-hidden />}
                  {mode === "login"
                    ? submitting ? "Accesso..." : "Accedi"
                    : mode === "register"
                      ? "Crea gestionale"
                      : mode === "verify"
                        ? "Verifica e crea gestionale"
                        : mode === "forgot-password"
                          ? "Invia link"
                          : "Salva password"}
                </button>

                {mode === "verify" ? (
                  <button
                    className="inline-flex h-10 w-full items-center justify-center rounded-md border border-zinc-200 bg-white px-4 text-sm font-semibold text-zinc-700 disabled:cursor-not-allowed disabled:opacity-70"
                    disabled={submitting}
                    type="button"
                    onClick={resendSignupCode}
                  >
                    Reinvia codice
                  </button>
                ) : null}
              </form>

              <div className="mt-5 flex flex-wrap gap-2 text-sm font-medium text-zinc-600">
                <button className="hover:text-zinc-950" type="button" onClick={() => setMode("login")}>Login</button>
                <span>|</span>
                <button className="hover:text-zinc-950" type="button" onClick={() => setMode("register")}>Registrati</button>
                <span>|</span>
                <button className="hover:text-zinc-950" type="button" onClick={() => setMode("forgot-password")}>Password dimenticata?</button>
              </div>
            </div>
          </div>
        </section>

        <aside className="hidden min-h-screen bg-[#191816] p-8 text-white lg:flex lg:items-center">
          <div className="w-full rounded-lg border border-white/10 bg-white/5 p-6">
            <div className="flex h-14 w-14 items-center justify-center rounded-md bg-emerald-600 text-xl font-semibold">B</div>
            <h2 className="mt-6 text-4xl font-semibold tracking-normal">Gestisci la tua attivita online</h2>
            <p className="mt-4 max-w-lg leading-7 text-white/75">
              Stessa idea XAMPP: un punto centrale per registrare il gestionale, poi ingresso tenant con agenda, clienti, servizi, marketplace e booking.
            </p>
            <div className="mt-8 grid gap-3">
              {["Sedi e operatori", "Prenotazioni online", "Marketplace pubblico", "Account cliente e preferiti"].map((item) => (
                <div className="rounded-md bg-white/10 p-3 text-sm font-semibold" key={item}>{item}</div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}

function normalizeSlug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]+/g, "")
    .slice(0, 62);
}
