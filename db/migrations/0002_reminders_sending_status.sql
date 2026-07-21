-- 0002 (2026-07-21): il claim anti double-send del cron reminders marca le
-- righe 'sending' prima dell'invio (recovery 15 min su updated_at). Le CHECK
-- ereditate dall'enum MySQL legacy ammettevano solo pending/sent/failed:
-- senza questo rilassamento il claim viola la constraint (23514) e il cron
-- salta l'intero tenant in silenzio (trovato dalla revisione avversaria 21/07).

ALTER TABLE "reminders" DROP CONSTRAINT IF EXISTS "reminders_status_check";
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_status_check"
  CHECK (status IN ('pending', 'sending', 'sent', 'failed'));

ALTER TABLE "card_reminders" DROP CONSTRAINT IF EXISTS "card_reminders_status_check";
ALTER TABLE "card_reminders" ADD CONSTRAINT "card_reminders_status_check"
  CHECK (status IN ('pending', 'sending', 'sent', 'failed'));
