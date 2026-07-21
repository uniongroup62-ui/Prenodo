// Coerenza email 2026-07-18: render-test standalone delle primitive di
// lib/email.ts (bundle esbuild con shim server-only, SES esternalizzato).
// Il bundle è un artefatto (gitignored): se manca viene RICOSTRUITO qui,
// così la batteria non dipende da build manuali.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const bundleUrl = new URL("./email-bundle.mjs", import.meta.url);
if (!existsSync(bundleUrl)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const build = spawnSync("npx", [
    "esbuild", "lib/email.ts", "--bundle", "--format=esm", "--platform=node",
    "--outfile=tests/email-bundle.mjs",
    "--alias:server-only=./tests/server-only-shim.mjs",
    "--external:@aws-sdk/client-sesv2",
  ], { cwd: root, shell: true, encoding: "utf8" });
  if (build.status !== 0) {
    console.error("build email-bundle FALLITA:", build.stdout, build.stderr);
    process.exit(1);
  }
}
const bundle = await import(bundleUrl.href);
const { buildModernEmailTemplate, emailButton, emailCodeBox, EMAIL_ACCENT, htmlToText } = bundle;
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };

// Oggetti puliti (scelta 2026-07-18): brandedSubject NON esiste più —
// il brand vive in fromName/header/footer, mai nell'oggetto.
check("S1 brandedSubject RIMOSSA dall'API", !("brandedSubject" in bundle));

// emailButton
const btn = emailButton('https://x.it/a?b=1&c="2"', 'Apri <ora>');
check("B1 bottone: accent unico + stile canonico", btn.includes(`background:${EMAIL_ACCENT}`) && btn.includes("border-radius:12px") && btn.includes("padding:12px 18px") && btn.includes("font-weight:700"));
check("B2 bottone: href e label ESCAPED", btn.includes("&quot;2&quot;") && btn.includes("Apri &lt;ora&gt;") && !btn.includes("<ora>"));

// emailCodeBox
const box = emailCodeBox("123456");
check("C1 code box: bordo dashed accent + codice", box.includes(`2px dashed ${EMAIL_ACCENT}`) && box.includes("123456") && box.includes("letter-spacing:4px"));

// template completo con logo: header a TABELLA (niente flex per Outlook)
const t1 = buildModernEmailTemplate("Elite — Test", "<p>Ciao Luca,</p><p>corpo</p>", { business_name: "Elite", business_email: "info@elite.it", business_logo_url: "https://cdn/logo.png" });
check("T1 header logo: tabella, NIENTE display:flex", !t1.html.includes("display:flex") && /<table role="presentation" cellpadding="0" cellspacing="0"><tr>/.test(t1.html) && t1.html.includes("cdn/logo.png"));
check("T2 footer: brand + Contatto mailto", t1.html.includes("Contatto:") && t1.html.includes("mailto:info@elite.it"));
check("T3 preheader presente e testo alternativo", t1.html.includes("display:none;max-height:0") && t1.text.includes("Ciao Luca,"));

// template senza logo: solo brand testuale
const t2 = buildModernEmailTemplate("X", "solo testo\n\nsecondo paragrafo", { business_name: "Elite" });
check("T4 no-logo: brand testuale, paragrafi avvolti", t2.html.includes('font-weight:800;font-size:16px;color:#0f172a">Elite</div>') && (t2.html.match(/<p style="margin:0 0 12px 0">/g) || []).length === 2);

// composizione tipo: bottone dentro il template sopravvive intero
const t3 = buildModernEmailTemplate("Preventivo 3/2026", `Ciao Luca,<br><br>${emailButton("https://x.it/q", "Apri preventivo")}`, { business_name: "Elite", business_email: "info@elite.it" });
// NB: 'Apri preventivo' appare ANCHE nel preheader (primi 120 char del testo):
// si conta solo il bottone <a>...</a> renderizzato.
check("T5 bottone <a> reso 1 volta, testo alt senza html", (t3.html.match(/Apri preventivo<\/a>/g) || []).length === 1 && t3.text.includes("Apri preventivo") && !t3.text.includes("<a"));
check("T6 htmlToText: nl2br del template non raddoppia le righe", htmlToText("a<br>\nb").split("\n").filter(Boolean).length === 2);

console.log(`\n==== ${R.filter(Boolean).length} PASS / ${R.filter((x) => !x).length} FAIL ====`);
process.exit(R.every(Boolean) ? 0 : 1);
