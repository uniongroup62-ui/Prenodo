// Prove the manage-login data path works on Supabase: tenant-scoped user
// lookup + PHP-bcrypt verification. Run via PowerShell (network).
//   SUPA_URL=postgres://... node db/tools/verify-login.mjs
import pg from "pg";
import bcrypt from "bcryptjs";

const c = new pg.Client({ connectionString: process.env.SUPA_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

async function tryLogin(slug, email, password) {
  const t = await c.query("SELECT id FROM saas_tenants WHERE slug=$1 LIMIT 1", [slug]);
  const tenantId = t.rows[0]?.id ?? 0;
  const u = await c.query(
    "SELECT id,email,role,password_hash FROM users WHERE tenant_id=$1 AND LOWER(email)=LOWER($2) LIMIT 1",
    [tenantId, email]
  );
  const row = u.rows[0];
  if (!row) return { ok: false, why: "no user" };
  let hash = String(row.password_hash || "");
  if (hash.startsWith("$2y$")) hash = "$2a$" + hash.slice(4);
  const ok = await bcrypt.compare(password, hash);
  return { ok, tenantId, role: row.role, id: row.id };
}

// Credenziali SOLO da env (audit 21/07: mai committare password in chiaro).
const SLUG = process.env.PRENODO_SHOT_SLUG || "centroesteticoelite";
const EMAIL = process.env.PRENODO_SHOT_EMAIL || "";
const PASSWORD = process.env.PRENODO_SHOT_PASSWORD || "";
if (!EMAIL || !PASSWORD) {
  console.error("Imposta PRENODO_SHOT_EMAIL e PRENODO_SHOT_PASSWORD nell'ambiente.");
  process.exit(1);
}
console.log(`${SLUG} / ${EMAIL} / <env>:`, JSON.stringify(await tryLogin(SLUG, EMAIL, PASSWORD)));
console.log(`${SLUG} / ${EMAIL} / WRONGPASS:`, JSON.stringify(await tryLogin(SLUG, EMAIL, "wrong")));
await c.end();
