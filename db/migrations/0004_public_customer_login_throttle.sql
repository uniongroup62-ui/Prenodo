-- 0004 (2026-07-21, audit GDPR art.32): il login password dell'area clienti
-- pubblica non aveva alcun rate limiting (solo i codici OTP erano protetti).
-- Contatori per-account: 10 fallimenti in 15 minuti bloccano temporaneamente.

ALTER TABLE "public_customer_accounts"
  ADD COLUMN IF NOT EXISTS "password_login_attempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "password_login_last_attempt_at" timestamp NULL;
