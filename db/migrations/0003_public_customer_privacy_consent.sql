-- 0003 (2026-07-21, audit GDPR): la registrazione dell'area clienti pubblica
-- raccoglie l'accettazione dell'informativa privacy con prova (timestamp + IP,
-- come gia' fa la registrazione tenant su saas_tenants) e un opt-in marketing
-- facoltativo distinto.

ALTER TABLE "public_customer_accounts"
  ADD COLUMN IF NOT EXISTS "privacy_accepted_at" timestamp NULL,
  ADD COLUMN IF NOT EXISTS "privacy_accept_ip" varchar(64) NULL,
  ADD COLUMN IF NOT EXISTS "marketing_opt_in" smallint NOT NULL DEFAULT 0;
