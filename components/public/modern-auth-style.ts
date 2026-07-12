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

// Variante CLIENTI "photo split" (iterata su feedback utente, riferimento
// screen "Nucleus" + richiesta di coerenza col gestionale): form a SINISTRA
// sul bianco con freccia+brand in alto a sinistra come nel login
// professionisti; pannello FOTO LARGO a destra con la citazione in basso.
// Stessa pelle form del gestionale (label sopra i campi, input compatti,
// 'Password dimenticata?' a destra, bottone squadrato), riga finale 'Non hai
// un account? Registrati'.
export const MODERN_CUSTOMER_PHOTO_AUTH_STYLE = MODERN_AUTH_FORM_STYLE + `
.account-page--auth{background:#fff;min-height:100vh}
.account-page--auth .marketplace-topbar{display:none}
.account-page--auth .visual-card{display:none}
.account-page--auth .auth-photo-panel{position:fixed;inset:0 0 0 auto;width:min(680px,44vw);background:#243a63 url('https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=1400&q=80') center/cover no-repeat;display:flex;flex-direction:column;justify-content:flex-end;padding:26px 30px 32px;z-index:1}
.account-page--auth .auth-photo-panel::before{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(15,23,42,.42) 0%,rgba(15,23,42,.05) 40%,rgba(15,23,42,.62) 100%)}
.account-page--auth .auth-photo-quote{position:relative;color:#fff;max-width:520px}
.account-page--auth .auth-photo-quote p{font-size:22px;font-weight:700;line-height:1.35;margin:0 0 10px}
.account-page--auth .auth-photo-quote small{display:block;font-size:13px;font-weight:600;opacity:.92}
.account-page--auth .auth-photo-quote small + small{font-weight:400;opacity:.75}
.account-page--auth .account-main--auth-flow{display:flex;justify-content:center;align-items:center;min-height:100vh;padding:48px 24px;margin-right:min(680px,44vw);max-width:none;box-sizing:border-box}
.account-page--auth .auth-stack{width:min(400px,100%);margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0;min-height:0}
.account-page--auth .auth-stack > .auth-brand{position:fixed;top:26px;left:88px;z-index:5}
.account-page--auth .auth-stack > .auth-brand .brand-mark{width:34px;height:34px;border-radius:10px;font-size:16px}
.account-page--auth .auth-card{width:100%;background:transparent;border:0;box-shadow:none;padding:0}
.account-page--auth .auth-card .eyebrow{display:none}
.account-page--auth .auth-card h1{text-align:center;font-size:30px;margin-bottom:10px}
.account-page--auth .auth-card .lead{text-align:center;margin-bottom:30px;font-size:13.5px}
.account-page--auth .auth-card .form label{font-size:12px;margin-bottom:14px;gap:6px}
.account-page--auth .auth-card .form input[type="email"],.account-page--auth .auth-card .form input[type="password"],.account-page--auth .auth-card .form input[type="text"],.account-page--auth .auth-card .form input[type="tel"]{height:42px;border-radius:8px;border-color:#e2e8f0;font-size:14px;padding:0 12px}
.account-page--auth .auth-card .pw-field input{padding-right:44px}
.account-page--auth .auth-card .pw-toggle{width:34px;height:34px;font-size:15px}
.account-page--auth .auth-card .form-row-after{display:flex;justify-content:flex-end;margin:-6px 0 16px}
.account-page--auth .auth-card .form-row-after a{font-size:13px;font-weight:600;color:#4e6da6;text-decoration:none}
.account-page--auth .auth-card .form-row-after a:hover{text-decoration:underline}
.account-page--auth .auth-card .auth-submit{height:44px;border-radius:10px;font-size:14.5px;margin-top:0}
.account-page--auth .auth-card .links{margin-top:22px;font-size:13.5px;color:#64748b;gap:6px}
.account-page--auth .auth-card .links a{font-weight:700}
.account-page--auth .auth-card .links span{display:none}
@media (max-width:900px){.account-page--auth .auth-photo-panel{display:none}.account-page--auth .account-main--auth-flow{margin-right:0}}
`;

// Variante GESTIONALE (iterata su feedback utente, riferimento screen
// "Sellora"): form SENZA box, centrato verticalmente sulla metà bianca —
// titolo grande centrato, input compatti, 'Password dimenticata?' a destra
// sotto il campo, riga finale 'Non hai un account? Registrati', copyright in
// basso; brand in alto a sinistra; pannello destro col gradiente ricco.
export const MODERN_MANAGE_AUTH_STYLE = MODERN_AUTH_FORM_STYLE + `
.manage-page.account-page--auth{background:#fff}
.manage-page .account-main--auth-flow{align-items:stretch;min-height:100vh;padding-top:0;padding-bottom:0}
.manage-page .auth-stack{gap:0;justify-content:center;align-self:stretch;min-height:100vh;display:flex;flex-direction:column}
.manage-page .auth-brand{position:fixed;top:26px;left:88px;z-index:5}
.manage-page .auth-brand .brand-mark{width:34px;height:34px;border-radius:10px;font-size:16px}
.manage-page .auth-card{background:transparent;border:0;box-shadow:none;padding:0;width:min(360px,100%);margin:0 auto}
.manage-page .auth-card h1{text-align:center;font-size:30px;margin-bottom:10px}
.manage-page .auth-card .lead{text-align:center;margin-bottom:30px;font-size:13.5px}
.manage-page .auth-card .form label{font-size:12px;margin-bottom:14px;gap:6px}
.manage-page .auth-card .form input[type="email"],.manage-page .auth-card .form input[type="password"],.manage-page .auth-card .form input[type="text"]{height:42px;border-radius:8px;border-color:#e2e8f0;font-size:14px;padding:0 12px}
.manage-page .auth-card .pw-field input{padding-right:44px}
.manage-page .auth-card .pw-toggle{width:34px;height:34px;font-size:15px}
.manage-page .auth-card .form-row-after{display:flex;justify-content:flex-end;margin:-6px 0 16px}
.manage-page .auth-card .form-row-after a{font-size:13px;font-weight:600;color:#4e6da6;text-decoration:none}
.manage-page .auth-card .form-row-after a:hover{text-decoration:underline}
.manage-page .auth-card .auth-submit{height:44px;border-radius:10px;font-size:14.5px;margin-top:0}
.manage-page .auth-card .links{margin-top:22px;font-size:13.5px;color:#64748b}
.manage-page .auth-card .links span{display:none}
.manage-page .auth-footer{position:fixed;left:0;bottom:0;width:50%;display:flex;justify-content:space-between;padding:16px 28px;font-size:12px;color:#94a3b8;pointer-events:none}
@media (max-width:900px){.manage-page .auth-footer{width:100%}}
.manage-page .visual-card.manage-visual{background:linear-gradient(160deg,#4e6da6 0%,#365287 55%,#243a63 100%);border-radius:22px;box-shadow:0 18px 44px rgba(36,58,99,.28)}
.manage-page .visual-card .tenant-badge{background:rgba(255,255,255,.16);border-radius:12px}
.manage-page .visual-card .visual-actions a{border-radius:10px}
`;
