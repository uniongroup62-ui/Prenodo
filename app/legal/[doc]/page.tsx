import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

// Pagine legali della piattaforma (audit GDPR 2026-07-21): privacy, cookie,
// termini e note legali. Superficie NUOVA a livello piattaforma (come /login),
// palette marketplace. I testi descrivono il funzionamento REALE del software
// (cookie tecnici, processor AWS/Supabase/Cloudflare/OpenAPI, modello
// titolare/responsabile SaaS); i dati societari del gestore sono segnaposto
// [DA COMPLETARE] che il titolare deve valorizzare prima della pubblicazione.

const CONTACT_PLACEHOLDER = "[DA COMPLETARE: ragione sociale, sede legale, P.IVA ed email di contatto del gestore della piattaforma]";

type LegalDoc = { slug: string; title: string; description: string; body: React.ReactNode };

function PrivacyBody() {
  return (
    <>
      <p className="legal-updated">Ultimo aggiornamento: 21 luglio 2026 — bozza operativa, in attesa di validazione legale.</p>
      <h2>1. Titolare del trattamento</h2>
      <p>
        La piattaforma Prenodo è gestita da {CONTACT_PLACEHOLDER}. Per i dati trattati direttamente dalla piattaforma
        (account cliente del marketplace, registrazione dei professionisti) il gestore agisce come <strong>titolare del
        trattamento</strong>.
      </p>
      <p>
        Per i dati dei clienti finali gestiti da ciascun centro (anagrafiche, appuntamenti, schede tecniche, consensi),
        il <strong>titolare è il centro</strong> presso cui il servizio viene prenotato o erogato; Prenodo agisce come
        <strong> responsabile del trattamento</strong> ai sensi dell&apos;art. 28 GDPR per conto del centro.
      </p>
      <h2>2. Dati trattati e finalità</h2>
      <ul>
        <li>
          <strong>Account cliente marketplace</strong>: nome, cognome, email, telefono, password (conservata in forma
          cifrata irreversibile). Finalità: creazione e gestione dell&apos;account, prenotazioni online, preferiti.
          Base giuridica: esecuzione del contratto (art. 6.1.b).
        </li>
        <li>
          <strong>Prenotazioni</strong>: servizi scelti, data/ora, sede, note facoltative. Finalità: gestione della
          prenotazione e comunicazioni di servizio (conferme, promemoria). Base giuridica: esecuzione del contratto.
        </li>
        <li>
          <strong>Registrazione professionisti</strong>: nome attività, referente, email, telefono, con registrazione di
          data di accettazione dei termini, indirizzo IP e user-agent come prova. Base giuridica: esecuzione del
          contratto e legittimo interesse alla prova dell&apos;accettazione.
        </li>
        <li>
          <strong>Dati gestiti dai centri</strong> (in qualità di titolari): anagrafica cliente, storico appuntamenti e
          acquisti, schede tecniche, documenti e consensi firmati. Possono includere categorie particolari (art. 9,
          es. fotografie o annotazioni estetiche): in tal caso la base giuridica è il consenso esplicito raccolto dal
          centro tramite i moduli di consenso della piattaforma.
        </li>
        <li>
          <strong>Log tecnici</strong>: tentativi di accesso (email, IP, esito) per sicurezza e prevenzione abusi
          (legittimo interesse); log delle attività degli operatori conservati 30 giorni.
        </li>
      </ul>
      <h2>3. Destinatari e responsabili</h2>
      <p>I dati sono trattati tramite i seguenti fornitori (sub-responsabili), vincolati da accordi di trattamento:</p>
      <ul>
        <li><strong>Supabase</strong> (database PostgreSQL, regione UE — eu-west-1);</li>
        <li><strong>Amazon Web Services</strong> (hosting applicativo e invio email transazionali via SES, regione UE);</li>
        <li><strong>Cloudflare R2</strong> (archiviazione file: i documenti riservati risiedono in uno spazio privato accessibile solo tramite link temporanei);</li>
        <li><strong>OpenAPI</strong> (invio SMS di promemoria: riceve numero di telefono e testo del messaggio).</li>
      </ul>
      <h2>4. Conservazione</h2>
      <p>
        I dati dell&apos;account restano per la durata dell&apos;account. I log delle attività degli operatori sono
        conservati 30 giorni; i log di consegna delle comunicazioni 30 giorni; i token di reset password al massimo 7
        giorni dopo l&apos;uso o la scadenza. I dati gestiti dai centri sono conservati secondo le politiche del
        singolo centro titolare.
      </p>
      <h2>5. Diritti dell&apos;interessato</h2>
      <p>
        Puoi esercitare i diritti di accesso, rettifica, cancellazione, limitazione, portabilità e opposizione
        (artt. 15-22 GDPR) scrivendo al contatto indicato al punto 1. Per i dati trattati da un centro, la richiesta va
        rivolta al centro titolare; la piattaforma fornisce ai centri gli strumenti per darvi seguito. Hai inoltre il
        diritto di proporre reclamo al Garante per la protezione dei dati personali (www.garanteprivacy.it).
      </p>
      <h2>6. Natura del conferimento</h2>
      <p>
        Il conferimento dei dati contrassegnati come obbligatori è necessario per erogare il servizio richiesto; in
        mancanza, la prenotazione o la registrazione non possono essere completate. I consensi facoltativi (es.
        comunicazioni promozionali) possono essere revocati in ogni momento senza pregiudicare il servizio.
      </p>
    </>
  );
}

function CookieBody() {
  return (
    <>
      <p className="legal-updated">Ultimo aggiornamento: 21 luglio 2026 — bozza operativa, in attesa di validazione legale.</p>
      <h2>1. Cosa usiamo</h2>
      <p>
        Prenodo utilizza esclusivamente <strong>cookie tecnici</strong>, necessari al funzionamento del servizio. Non
        utilizziamo cookie di profilazione, cookie pubblicitari né strumenti di analisi di terze parti (nessun Google
        Analytics, nessun pixel social). Per questo motivo non è richiesto un banner di consenso: i cookie tecnici non
        necessitano di consenso ai sensi della normativa vigente.
      </p>
      <h2>2. Cookie utilizzati</h2>
      <ul>
        <li><strong>Cookie di sessione area clienti</strong> — mantiene l&apos;accesso al tuo account cliente (durata massima 60 giorni, accessibile solo al server).</li>
        <li><strong>Cookie di sessione gestionale</strong> — mantiene l&apos;accesso degli operatori dei centri (durata 12 ore).</li>
        <li><strong>Archiviazione locale temporanea</strong> (sessionStorage) — usata per mostrare messaggi di esito dopo un&apos;operazione; si cancella alla chiusura della scheda.</li>
      </ul>
      <h2>3. Risorse di terze parti</h2>
      <p>
        Alcune pagine caricano librerie grafiche (Bootstrap) da una rete di distribuzione contenuti (jsDelivr). Il
        fornitore della CDN riceve l&apos;indirizzo IP necessario a consegnare il file, senza installare cookie né
        tracciare la navigazione.
      </p>
      <h2>4. Gestione delle preferenze</h2>
      <p>
        Poiché non usiamo cookie soggetti a consenso, non c&apos;è nulla da configurare. Puoi comunque bloccare o
        eliminare i cookie tecnici dalle impostazioni del tuo browser: in tal caso l&apos;accesso all&apos;account e
        alcune funzioni potrebbero non funzionare.
      </p>
    </>
  );
}

function TermsBody() {
  return (
    <>
      <p className="legal-updated">Ultimo aggiornamento: 21 luglio 2026 — bozza operativa, in attesa di validazione legale.</p>
      <h2>1. Oggetto</h2>
      <p>
        Prenodo è una piattaforma che consente ai clienti di cercare centri di bellezza e prenotare online, e ai
        professionisti di gestire la propria attività (agenda, cassa, clienti). I presenti termini regolano
        l&apos;uso della piattaforma, gestita da {CONTACT_PLACEHOLDER}.
      </p>
      <h2>2. Ruoli</h2>
      <p>
        Il rapporto di prestazione (appuntamento, trattamento, vendita) si instaura <strong>esclusivamente tra il
        cliente e il centro</strong>: Prenodo fornisce lo strumento tecnico di prenotazione e gestione. Prezzi,
        disponibilità, politiche di annullamento e qualità dei servizi sono responsabilità del singolo centro.
      </p>
      <h2>3. Account</h2>
      <p>
        L&apos;account è personale: sei responsabile della custodia delle credenziali e delle attività svolte con esse.
        Dati falsi, uso fraudolento o abusi (incluse prenotazioni fittizie) possono comportare la sospensione
        dell&apos;account.
      </p>
      <h2>4. Prenotazioni e annullamenti</h2>
      <p>
        La prenotazione è una richiesta verso il centro, che può confermarla o gestirla secondo le proprie regole. Gli
        annullamenti sono soggetti alle condizioni mostrate dal centro al momento della prenotazione.
      </p>
      <h2>5. Limitazioni di responsabilità</h2>
      <p>
        La piattaforma è fornita &quot;così com&apos;è&quot;; ci impegniamo a mantenerla disponibile e sicura ma non
        garantiamo l&apos;assenza di interruzioni. Nei limiti di legge, il gestore non risponde dei danni derivanti dal
        rapporto tra cliente e centro né da cause di forza maggiore.
      </p>
      <h2>6. Legge applicabile</h2>
      <p>
        I presenti termini sono regolati dalla legge italiana. Per le controversie con consumatori è competente il foro
        del luogo di residenza del consumatore.
      </p>
    </>
  );
}

function LegalNoticeBody() {
  return (
    <>
      <p className="legal-updated">Ultimo aggiornamento: 21 luglio 2026 — bozza operativa, in attesa di validazione legale.</p>
      <h2>Gestore della piattaforma</h2>
      <p>{CONTACT_PLACEHOLDER}</p>
      <h2>Contenuti dei centri</h2>
      <p>
        Le schede delle attività (descrizioni, listini, fotografie, orari) sono pubblicate dai rispettivi centri, che
        ne garantiscono correttezza e liceità. Per segnalare contenuti inesatti o lesivi, scrivi al contatto indicato
        sopra.
      </p>
      <h2>Proprietà intellettuale</h2>
      <p>
        Il marchio Prenodo, il software e l&apos;interfaccia della piattaforma sono di proprietà del gestore. I marchi e
        i contenuti dei singoli centri restano di proprietà dei rispettivi titolari.
      </p>
      <h2>Documenti collegati</h2>
      <p>
        <Link href="/legal/privacy">Informativa sulla privacy</Link> · <Link href="/legal/cookie">Informativa sui cookie</Link> ·{" "}
        <Link href="/legal/termini">Termini di servizio</Link>
      </p>
    </>
  );
}

const DOCS: Record<string, LegalDoc> = {
  privacy: {
    slug: "privacy",
    title: "Informativa sulla privacy",
    description: "Come Prenodo tratta i dati personali di clienti e professionisti.",
    body: <PrivacyBody />,
  },
  cookie: {
    slug: "cookie",
    title: "Informativa sui cookie",
    description: "I cookie tecnici usati dalla piattaforma Prenodo.",
    body: <CookieBody />,
  },
  termini: {
    slug: "termini",
    title: "Termini di servizio",
    description: "Le condizioni d'uso della piattaforma Prenodo.",
    body: <TermsBody />,
  },
  "note-legali": {
    slug: "note-legali",
    title: "Note legali",
    description: "Informazioni sul gestore della piattaforma Prenodo.",
    body: <LegalNoticeBody />,
  },
};

const STYLE = `
.legal-page{min-height:100vh;background:#fff;color:#0f172a;display:flex;flex-direction:column}
.legal-topbar{border-bottom:1px solid #e6ebf3;background:#fff}
.legal-topbar__inner{max-width:960px;margin:0 auto;padding:16px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px}
.legal-brand{display:flex;align-items:center;gap:12px;font-size:19px;font-weight:600;color:#0f172a;text-decoration:none}
.legal-brand__mark{width:34px;height:34px;border-radius:10px;background:#365a96;color:#fff;display:grid;place-items:center;font-weight:600;font-size:16px}
.legal-back{font-size:14px;font-weight:600;color:#365a96;text-decoration:none}
.legal-back:hover{text-decoration:underline}
.legal-main{flex:1;max-width:960px;width:100%;margin:0 auto;padding:34px 24px 60px}
.legal-nav{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:26px}
.legal-nav a{border:1px solid #dbe3ef;border-radius:999px;padding:7px 15px;font-size:13.5px;font-weight:600;color:#0f172a;text-decoration:none}
.legal-nav a:hover{border-color:#365a96;color:#365a96}
.legal-nav a.is-active{background:#365a96;border-color:#365a96;color:#fff}
.legal-main h1{font-size:30px;font-weight:700;margin:0 0 6px}
.legal-desc{color:#64748b;font-size:15px;margin:0 0 26px}
.legal-body{font-size:15px;line-height:1.65;color:#1f2937}
.legal-body h2{font-size:18px;font-weight:700;margin:26px 0 8px;color:#0f172a}
.legal-body p{margin:0 0 12px}
.legal-body ul{margin:0 0 12px;padding-left:22px}
.legal-body li{margin-bottom:6px}
.legal-body a{color:#365a96}
.legal-updated{color:#64748b;font-size:13px}
.legal-footer{border-top:1px solid #e6ebf3;background:#f8fafc}
.legal-footer__inner{max-width:960px;margin:0 auto;padding:18px 24px;display:flex;flex-wrap:wrap;gap:14px;justify-content:space-between;color:#64748b;font-size:13px}
.legal-footer__inner a{color:#64748b;text-decoration:none;margin-right:12px}
.legal-footer__inner a:hover{color:#365a96}
`;

export function generateStaticParams() {
  return Object.keys(DOCS).map((doc) => ({ doc }));
}

export async function generateMetadata({ params }: { params: Promise<{ doc: string }> }): Promise<Metadata> {
  const { doc } = await params;
  const entry = DOCS[doc];
  if (!entry) return { title: "Documento non trovato | Prenodo" };
  return { title: `${entry.title} | Prenodo`, description: entry.description };
}

export default async function LegalDocPage({ params }: { params: Promise<{ doc: string }> }) {
  const { doc } = await params;
  const entry = DOCS[doc];
  if (!entry) notFound();

  return (
    <div className="legal-page">
      <style dangerouslySetInnerHTML={{ __html: STYLE }} />
      <header className="legal-topbar">
        <div className="legal-topbar__inner">
          <Link className="legal-brand" href="/attivita">
            <span className="legal-brand__mark">P</span>
            Prenodo
          </Link>
          <Link className="legal-back" href="/attivita">
            Torna al marketplace
          </Link>
        </div>
      </header>
      <main className="legal-main">
        <nav className="legal-nav" aria-label="Documenti legali">
          {Object.values(DOCS).map((d) => (
            <Link key={d.slug} className={d.slug === entry.slug ? "is-active" : undefined} href={`/legal/${d.slug}`}>
              {d.title}
            </Link>
          ))}
        </nav>
        <h1>{entry.title}</h1>
        <p className="legal-desc">{entry.description}</p>
        <div className="legal-body">{entry.body}</div>
      </main>
      <footer className="legal-footer">
        <div className="legal-footer__inner">
          <span>&copy; {new Date().getFullYear()} Prenodo</span>
          <span>
            <Link href="/legal/privacy">Privacy</Link>
            <Link href="/legal/cookie">Cookie</Link>
            <Link href="/legal/termini">Termini</Link>
            <Link href="/legal/note-legali">Note legali</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
