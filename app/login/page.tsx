import type { Metadata } from "next";
import Link from "next/link";

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
.login-choice-page{min-height:100vh;background:#f8fafc;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;font-family:inherit;color:#0f172a}
.login-choice-brand{display:flex;align-items:center;gap:12px;margin-bottom:36px;font-size:20px;font-weight:600;color:#0f172a;text-decoration:none}
.login-choice-brand__mark{width:40px;height:40px;border-radius:12px;background:#4e6da6;color:#fff;display:grid;place-items:center;font-weight:600;font-size:18px}
.login-choice-title{font-size:26px;font-weight:700;margin:0 0 6px;text-align:center}
.login-choice-subtitle{font-size:15px;color:#64748b;margin:0 0 32px;text-align:center}
.login-choice-cards{display:flex;flex-direction:column;gap:14px;width:min(520px,100%)}
.login-choice-card{display:flex;align-items:center;justify-content:space-between;gap:16px;background:#fff;border:1px solid #dbe3ef;border-radius:16px;padding:22px 24px;text-decoration:none;color:inherit;transition:box-shadow .15s ease,border-color .15s ease,transform .15s ease}
.login-choice-card:hover{border-color:#4e6da6;box-shadow:0 6px 24px rgba(78,109,166,.14);transform:translateY(-1px)}
.login-choice-card__text{min-width:0}
.login-choice-card__title{display:block;font-size:17px;font-weight:700;color:#0f172a;margin-bottom:2px}
.login-choice-card__desc{display:block;font-size:14px;color:#64748b}
.login-choice-card__arrow{flex:none;width:38px;height:38px;border-radius:999px;border:1px solid #dbe3ef;display:grid;place-items:center;color:#0f172a;font-size:18px;transition:background .15s ease,color .15s ease,border-color .15s ease}
.login-choice-card:hover .login-choice-card__arrow{background:#4e6da6;border-color:#4e6da6;color:#fff}
.login-choice-foot{margin-top:28px;font-size:13px;color:#64748b}
.login-choice-foot a{color:#4e6da6;font-weight:600;text-decoration:none}
.login-choice-foot a:hover{text-decoration:underline}
`;

export default async function LoginChoicePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Propaga il return alla card CLIENTI e al Registrati (il login cliente lo
  // preserva già sui suoi link); solo path relativi, mai URL esterni.
  const query = (await searchParams) ?? {};
  const rawReturn = query.return;
  const ret = String(Array.isArray(rawReturn) ? rawReturn[0] ?? "" : rawReturn ?? "");
  const returnQs = ret.startsWith("/") && !ret.startsWith("//") ? `?return=${encodeURIComponent(ret)}` : "";
  return (
    <div className="login-choice-page">
      <style dangerouslySetInnerHTML={{ __html: STYLE }} />
      <Link className="login-choice-brand" href="/attivita">
        <span className="login-choice-brand__mark">P</span>
        <span>Prenodo</span>
      </Link>
      <h1 className="login-choice-title">Come vuoi accedere?</h1>
      <p className="login-choice-subtitle">Scegli l&apos;area giusta per te.</p>
      <div className="login-choice-cards">
        <Link className="login-choice-card" href={`/account/login${returnQs}`}>
          <span className="login-choice-card__text">
            <span className="login-choice-card__title">Prenodo per i clienti</span>
            <span className="login-choice-card__desc">Prenota saloni e centri estetici vicino a te</span>
          </span>
          <span className="login-choice-card__arrow" aria-hidden="true">&rarr;</span>
        </Link>
        <Link className="login-choice-card" href="/manage/login">
          <span className="login-choice-card__text">
            <span className="login-choice-card__title">Prenodo per i professionisti</span>
            <span className="login-choice-card__desc">Gestisci e fai crescere la tua attivit&agrave;</span>
          </span>
          <span className="login-choice-card__arrow" aria-hidden="true">&rarr;</span>
        </Link>
      </div>
      <p className="login-choice-foot">
        Non hai un account? <Link href={`/account/register${returnQs}`}>Registrati come cliente</Link>
      </p>
    </div>
  );
}
