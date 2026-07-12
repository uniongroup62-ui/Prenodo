// Restyle moderno delle pagine auth (scelta utente 2026-07-12): SOLO PELLE —
// override CSS scoped su .account-page--auth. Due pezzi componibili:
// - FORM: card/input/bottone/toggle/link (riusabile ovunque, anche col
//   pannello visual del gestionale intatto);
// - LAYOUT cliente: card centrata stile Fresha (aside promozionale e search
//   topbar nascosti). Logica/markup di form invariati.
export const MODERN_AUTH_FORM_STYLE = `
.account-page--auth .auth-brand{display:flex;align-items:center;gap:12px;font-size:20px;font-weight:600;color:#0f172a;text-decoration:none}
.account-page--auth .auth-brand .brand-mark{width:40px;height:40px;border-radius:12px;background:#4e6da6;color:#fff;display:grid;place-items:center;font-weight:600;font-size:18px}
.account-page--auth .auth-card{width:100%;background:#fff;border:1px solid #e2e8f0;border-radius:18px;box-shadow:0 10px 34px rgba(15,23,42,.06);padding:34px 32px 30px}
.account-page--auth .auth-card .eyebrow{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#4e6da6;margin:0 0 8px}
.account-page--auth .auth-card h1{font-size:24px;font-weight:700;color:#0f172a;margin:0 0 6px}
.account-page--auth .auth-card .lead{font-size:14px;color:#64748b;margin:0 0 22px;line-height:1.5}
.account-page--auth .auth-card .form label{display:flex;flex-direction:column;gap:7px;font-size:13px;font-weight:600;color:#334155;margin-bottom:16px}
.account-page--auth .auth-card .form input[type="email"],.account-page--auth .auth-card .form input[type="password"],.account-page--auth .auth-card .form input[type="text"],.account-page--auth .auth-card .form input[type="tel"]{height:50px;border:1px solid #dbe3ef;border-radius:12px;padding:0 16px;font-size:15px;color:#0f172a;background:#fff;transition:border-color .15s ease,box-shadow .15s ease;width:100%}
.account-page--auth .auth-card .form input:focus{outline:none;border-color:#4e6da6;box-shadow:0 0 0 4px rgba(78,109,166,.14)}
.account-page--auth .auth-card .form .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.account-page--auth .auth-card .pw-field{position:relative;display:flex;align-items:center}
.account-page--auth .auth-card .pw-field input{padding-right:48px}
.account-page--auth .auth-card .pw-toggle{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:38px;height:38px;border:0;border-radius:10px;background:transparent;color:#64748b;display:grid;place-items:center;cursor:pointer;font-size:17px}
.account-page--auth .auth-card .pw-toggle:hover{background:#eef4ff;color:#365287}
.account-page--auth .auth-card .auth-submit{width:100%;height:48px;border:0;border-radius:12px;background:#4e6da6;color:#fff;font-size:15px;font-weight:700;cursor:pointer;margin-top:6px;transition:background .15s ease,box-shadow .15s ease}
.account-page--auth .auth-card .auth-submit:hover:not(:disabled){background:#365287;box-shadow:0 8px 22px rgba(78,109,166,.28)}
.account-page--auth .auth-card .auth-submit:disabled{opacity:.65;cursor:default}
.account-page--auth .auth-card .links{display:flex;justify-content:center;gap:12px;margin-top:20px;font-size:14px}
.account-page--auth .auth-card .links a{color:#4e6da6;font-weight:600;text-decoration:none}
.account-page--auth .auth-card .links a:hover{text-decoration:underline}
.account-page--auth .auth-card .links span{color:#cbd5e1}
.account-page--auth .auth-card .alert{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:12px;padding:12px 14px;font-size:14px;margin-bottom:16px}
`;

// LAYOUT cliente: card centrata stile Fresha, aside promozionale e search
// della topbar nascosti (solo pagine account cliente).
export const MODERN_AUTH_LAYOUT_STYLE = `
.account-page--auth{background:#f8fafc;min-height:100vh}
.account-page--auth .marketplace-topbar-search{display:none}
.account-page--auth .visual-card{display:none}
.account-page--auth .account-main--auth-flow{display:flex;justify-content:center;align-items:flex-start;padding:48px 24px 64px;max-width:none}
.account-page--auth .auth-stack{width:min(440px,100%);margin:0;display:flex;flex-direction:column;align-items:center;gap:26px}
`;

export const MODERN_AUTH_STYLE = MODERN_AUTH_LAYOUT_STYLE + MODERN_AUTH_FORM_STYLE;

// Variante GESTIONALE (iterata su feedback utente): pannello visual mantenuto
// col gradiente ricco; il form NON sta in una box — campi direttamente sul
// bianco con titolo centrato (riferimento: screen "Sellora" fornito), brand
// in alto a sinistra accanto alla freccia back.
export const MODERN_MANAGE_AUTH_STYLE = MODERN_AUTH_FORM_STYLE + `
.manage-page.account-page--auth{background:#fff}
.manage-page .account-main--auth-flow{align-items:center;min-height:100vh}
.manage-page .auth-stack{gap:0;justify-content:center}
.manage-page .auth-brand{position:fixed;top:26px;left:88px;z-index:5}
.manage-page .auth-brand .brand-mark{width:34px;height:34px;border-radius:10px;font-size:16px}
.manage-page .auth-card{background:transparent;border:0;box-shadow:none;padding:0;width:min(380px,100%)}
.manage-page .auth-card h1{text-align:center;font-size:28px;margin-bottom:8px}
.manage-page .auth-card .lead{text-align:center;margin-bottom:28px}
.manage-page .visual-card.manage-visual{background:linear-gradient(160deg,#4e6da6 0%,#365287 55%,#243a63 100%);border-radius:22px;box-shadow:0 18px 44px rgba(36,58,99,.28)}
.manage-page .visual-card .tenant-badge{background:rgba(255,255,255,.16);border-radius:12px}
.manage-page .visual-card .visual-actions a{border-radius:10px}
`;
