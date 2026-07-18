import type { Metadata } from "next";

// Selettore d'ingresso "per i clienti / per i professionisti" (pattern Fresha,
// richiesto dall'utente il 2026-07-12). Superficie NUOVA a livello piattaforma:
// i due login esistenti (/account/login e /manage/login) restano invariati —
// questa pagina ci sta solo davanti e instrada l'utente giusto al posto giusto.
// Palette coerente col marketplace (marketplace-topbar tokens).

export const metadata: Metadata = {
  title: "Accedi | Prenodo",
  description: "Scegli come accedere: area clienti per prenotare, gestionale per i professionisti.",
};

const STYLE = `
.login-choice-page{min-height:100vh;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;font-family:inherit;color:#0f172a}
.login-choice-back{position:fixed;left:24px;top:24px;z-index:20;width:42px;height:42px;border:1px solid #dbe3ef;border-radius:50%;background:#fff;color:#0f172a;display:grid;place-items:center;text-decoration:none;font-size:22px;font-weight:600;line-height:1;box-shadow:0 10px 28px rgba(15,23,42,.08);transition:background .18s ease,border-color .18s ease,transform .18s ease}
.login-choice-back:hover{background:#f8fafc;border-color:#cbd5e1;transform:translateX(-2px)}
.login-choice-brand{position:fixed;top:26px;left:88px;z-index:5;display:flex;align-items:center;gap:12px;font-size:20px;font-weight:600;color:#0f172a;text-decoration:none}
.login-choice-brand__mark{width:34px;height:34px;border-radius:10px;background:#0f766e;color:#fff;display:grid;place-items:center;font-weight:600;font-size:16px}
.login-choice-title{font-size:30px;font-weight:700;margin:0 0 10px;text-align:center}
.login-choice-subtitle{font-size:13.5px;color:#64748b;margin:0 0 30px;text-align:center;line-height:1.5}
.login-choice-cards{display:flex;flex-direction:column;gap:14px;width:min(520px,100%)}
.login-choice-card{display:flex;align-items:center;justify-content:space-between;gap:16px;background:#fff;border:1px solid #dbe3ef;border-radius:16px;padding:22px 24px;text-decoration:none;color:inherit;transition:box-shadow .15s ease,border-color .15s ease,transform .15s ease}
.login-choice-card:hover{border-color:#0f766e;box-shadow:0 6px 24px rgba(15,118,110,.14);transform:translateY(-1px)}
.login-choice-card__text{min-width:0}
.login-choice-card__title{display:block;font-size:17px;font-weight:700;color:#0f172a;margin-bottom:2px}
.login-choice-card__desc{display:block;font-size:14px;color:#64748b}
.login-choice-card__arrow{flex:none;width:38px;height:38px;border-radius:999px;border:1px solid #dbe3ef;display:grid;place-items:center;color:#0f172a;font-size:18px;transition:background .15s ease,color .15s ease,border-color .15s ease}
.login-choice-card:hover .login-choice-card__arrow{background:#0f766e;border-color:#0f766e;color:#fff}
`;

export default async function LoginChoicePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Propaga il return alla card CLIENTI (il login cliente lo preserva già sui
  // suoi link); solo path relativi, mai URL esterni.
  const query = (await searchParams) ?? {};
  const rawReturn = query.return;
  const ret = String(Array.isArray(rawReturn) ? rawReturn[0] ?? "" : rawReturn ?? "");
  const returnQs = ret.startsWith("/") && !ret.startsWith("//") ? `?return=${encodeURIComponent(ret)}` : "";
  // NB: navigazioni FULL-PAGE (<a>, non <Link>): le pagine di destinazione
  // caricano i loro CSS via <link> dentro il componente (app.css /
  // public_account.css) e con la client-navigation il DOM viene montato PRIMA
  // che il CSS arrivi -> flash di contenuto non stilizzato (segnalato
  // dall'utente). Col document-load il CSS blocca il paint: niente flash.
  return (
    <div className="login-choice-page">
      <style dangerouslySetInnerHTML={{ __html: STYLE }} />
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a className="login-choice-back" href="/attivita" aria-label="Torna alla home" title="Torna alla home">
        &larr;
      </a>
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a className="login-choice-brand" href="/attivita">
        <span className="login-choice-brand__mark">P</span>
        <span>Prenodo</span>
      </a>
      <h1 className="login-choice-title">Come vuoi accedere?</h1>
      <p className="login-choice-subtitle">Scegli l&apos;area giusta per te.</p>
      <div className="login-choice-cards">
        <a className="login-choice-card" href={`/account/login${returnQs}`}>
          <span className="login-choice-card__text">
            <span className="login-choice-card__title">Prenodo per i clienti</span>
            <span className="login-choice-card__desc">Prenota saloni e centri estetici vicino a te</span>
          </span>
          <span className="login-choice-card__arrow" aria-hidden="true">&rarr;</span>
        </a>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a className="login-choice-card" href="/manage/login">
          <span className="login-choice-card__text">
            <span className="login-choice-card__title">Prenodo per i professionisti</span>
            <span className="login-choice-card__desc">Gestisci e fai crescere la tua attivit&agrave;</span>
          </span>
          <span className="login-choice-card__arrow" aria-hidden="true">&rarr;</span>
        </a>
      </div>
    </div>
  );
}
