-- 0005 (2026-07-21, audit Report bug metodi di pagamento): il POS scrive già
-- sales.payment_methods = '{"base":"cash|card|check|transfer"}' ma l'insert è
-- schema-guarded e la colonna non esisteva → il valore veniva scartato e il
-- report classificava i metodi SOLO dalla regex sulle note ("Tipo pagamento").
-- Attivando la colonna il POS la popola e il report legge il metodo in forma
-- STRUTTURATA (con la nota come fallback per le vendite legacy).

ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "payment_methods" text;
