import "server-only";

// ===================== FILE STORAGE — Cloudflare R2 =====================
// Il legacy salvava i file su disco locale (/uploads, save_local_upload /
// delete_local_upload, Helpers.php). Il Next usa Cloudflare R2 (S3-compatibile,
// decisione di progetto): DUE bucket —
//   - R2_BUCKET_PUBLIC : immagini servite al pubblico (foto staff, categorie/
//     servizi, marketplace), esposte via custom domain R2_PUBLIC_BASE_URL
//     (zero egress, CDN Cloudflare). Nel DB si salva l'URL pubblico COMPLETO:
//     il legacy staff_photo_url passa gli URL http assoluti invariati
//     (Helpers.php:10759), quindi il valore resta compatibile nei due sensi.
//   - R2_BUCKET_PRIVATE: documenti sensibili (allegati costi/magazzino, schede
//     cliente, PDF GDPR/consensi/preventivi), accessibili SOLO con presigned
//     URL a TTL breve generati DOPO i check di sessione+tenant.
// Le chiavi sono SEMPRE namespaced per tenant (t{tenantId}/<area>/...): multi-
// tenant clean, nessun oggetto condiviso tra centri.
//
// Env (Amplify / .env.local):
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
//   R2_BUCKET_PUBLIC, R2_BUCKET_PRIVATE, R2_PUBLIC_BASE_URL
// Con env mancanti storageConfigured() è false e le feature degradano con un
// errore chiaro (pattern emailConfigured), senza rompere il resto dell'app.

import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

type StorageEnv = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBucket: string;
  privateBucket: string;
  publicBaseUrl: string;
  endpoint: string;
};

function storageEnv(): StorageEnv {
  const accountId = String(process.env.R2_ACCOUNT_ID ?? "").trim();
  // Endpoint: R2_ENDPOINT esplicito (necessario per i bucket con GIURISDIZIONE
  // — EU usa https://<account>.eu.r2.cloudflarestorage.com), altrimenti quello
  // standard costruito dall'account id.
  const endpoint =
    String(process.env.R2_ENDPOINT ?? "").trim().replace(/\/+$/, "") ||
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "");
  return {
    accountId,
    accessKeyId: String(process.env.R2_ACCESS_KEY_ID ?? "").trim(),
    secretAccessKey: String(process.env.R2_SECRET_ACCESS_KEY ?? "").trim(),
    publicBucket: String(process.env.R2_BUCKET_PUBLIC ?? "").trim(),
    privateBucket: String(process.env.R2_BUCKET_PRIVATE ?? "").trim(),
    publicBaseUrl: String(process.env.R2_PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, ""),
    endpoint,
  };
}

// True when the PUBLIC side is usable (credentials + public bucket + base URL).
// The private side additionally needs R2_BUCKET_PRIVATE (storagePrivateConfigured).
export function storageConfigured(): boolean {
  const env = storageEnv();
  return Boolean(env.endpoint && env.accessKeyId && env.secretAccessKey && env.publicBucket && env.publicBaseUrl);
}

export function storagePrivateConfigured(): boolean {
  const env = storageEnv();
  return Boolean(env.endpoint && env.accessKeyId && env.secretAccessKey && env.privateBucket);
}

// Il messaggio unico mostrato dalle feature quando lo storage non è pronto.
export const STORAGE_NOT_CONFIGURED_ERROR =
  "Storage file non configurato. Imposta le variabili R2_* (Cloudflare R2) per abilitare i caricamenti.";

let cachedClient: S3Client | null = null;
function r2Client(): S3Client {
  if (cachedClient) return cachedClient;
  const env = storageEnv();
  cachedClient = new S3Client({
    region: "auto",
    endpoint: env.endpoint,
    credentials: { accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
  });
  return cachedClient;
}

// Chiave tenant-namespaced: t{tenantId}/{area}/{filename}. Il filename viene
// ripulito (niente path traversal / caratteri strani).
export function tenantStorageKey(tenantId: number, area: string, filename: string): string {
  const cleanArea = String(area).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "") || "misc";
  const cleanName = String(filename).trim().replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "") || "file";
  return `t${Math.max(0, Math.floor(tenantId))}/${cleanArea}/${cleanName}`;
}

// URL pubblico di un oggetto del bucket pubblico (custom domain / r2.dev).
export function storagePublicUrl(key: string): string {
  const env = storageEnv();
  if (!env.publicBaseUrl) return "";
  return `${env.publicBaseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

// Se l'URL appartiene al dominio pubblico R2, restituisce la KEY; altrimenti null.
// Usato per cancellare il vecchio file quando se ne carica uno nuovo.
export function storageKeyFromPublicUrl(url: string): string | null {
  const env = storageEnv();
  const clean = String(url ?? "").trim();
  if (!env.publicBaseUrl || !clean.startsWith(`${env.publicBaseUrl}/`)) return null;
  const rest = clean.slice(env.publicBaseUrl.length + 1);
  try {
    return rest.split("/").map(decodeURIComponent).join("/");
  } catch {
    return null;
  }
}

export async function putPublicObject(key: string, body: Uint8Array, contentType: string): Promise<string> {
  if (!storageConfigured()) throw new Error(STORAGE_NOT_CONFIGURED_ERROR);
  const env = storageEnv();
  await r2Client().send(
    new PutObjectCommand({
      Bucket: env.publicBucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      // Le immagini pubbliche sono immutabili (la key cambia a ogni upload):
      // cache lunga lato CDN/browser.
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
  return storagePublicUrl(key);
}

export async function putPrivateObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
  if (!storagePrivateConfigured()) throw new Error(STORAGE_NOT_CONFIGURED_ERROR);
  const env = storageEnv();
  await r2Client().send(
    new PutObjectCommand({ Bucket: env.privateBucket, Key: key, Body: body, ContentType: contentType }),
  );
}

export async function deletePublicObject(key: string): Promise<void> {
  if (!storageConfigured()) return;
  const env = storageEnv();
  await r2Client()
    .send(new DeleteObjectCommand({ Bucket: env.publicBucket, Key: key }))
    .catch(() => undefined); // best-effort: un delete fallito non blocca mai il flusso
}

export async function deletePrivateObject(key: string): Promise<void> {
  if (!storagePrivateConfigured()) return;
  const env = storageEnv();
  await r2Client()
    .send(new DeleteObjectCommand({ Bucket: env.privateBucket, Key: key }))
    .catch(() => undefined);
}

// Cancellazione per-PREFISSO (audit GDPR 2026-07-21): usata dal hard-delete
// tenant per rimuovere TUTTI gli oggetti `t{tenantId}/…` da entrambi i bucket.
// Best-effort e paginata; restituisce il numero di oggetti rimossi. Il prefisso
// deve essere non-vuoto e tenant-namespaced (guardia anti-svuotamento bucket).
export async function deleteObjectsByPrefix(prefix: string, scope: "public" | "private"): Promise<number> {
  const cleanPrefix = String(prefix ?? "").trim();
  if (!/^t\d+\//.test(cleanPrefix)) return 0;
  const configured = scope === "public" ? storageConfigured() : storagePrivateConfigured();
  if (!configured) return 0;
  const env = storageEnv();
  const bucket = scope === "public" ? env.publicBucket : env.privateBucket;
  let removed = 0;
  let continuationToken: string | undefined;
  try {
    do {
      const page = await r2Client().send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: cleanPrefix, ContinuationToken: continuationToken }),
      );
      for (const obj of page.Contents ?? []) {
        if (!obj.Key) continue;
        await r2Client()
          .send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }))
          .then(() => {
            removed += 1;
          })
          .catch(() => undefined);
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
  } catch {
    // best-effort: la pulizia storage non deve mai bloccare la cancellazione
  }
  return removed;
}

// GET diretto server-side dal bucket PRIVATO (Fase restore 2026-07-19): usato
// dal ripristino backup, dove il payload va LETTO dal server, non scaricato
// dal browser. Il chiamante DEVE aver già verificato sessione admin.
export async function getPrivateObject(key: string): Promise<Buffer> {
  if (!storagePrivateConfigured()) throw new Error(STORAGE_NOT_CONFIGURED_ERROR);
  const env = storageEnv();
  const result = await r2Client().send(new GetObjectCommand({ Bucket: env.privateBucket, Key: key }));
  const bytes = await result.Body?.transformToByteArray();
  if (!bytes) throw new Error("Oggetto backup vuoto o non leggibile.");
  return Buffer.from(bytes);
}

// Presigned GET sul bucket PRIVATO (default 5 minuti). Il chiamante DEVE aver
// già verificato sessione + tenant + ownership dell'oggetto.
export async function presignedPrivateGetUrl(key: string, ttlSeconds = 300): Promise<string> {
  if (!storagePrivateConfigured()) throw new Error(STORAGE_NOT_CONFIGURED_ERROR);
  const env = storageEnv();
  return getSignedUrl(r2Client(), new GetObjectCommand({ Bucket: env.privateBucket, Key: key }), {
    expiresIn: Math.max(30, Math.min(3600, ttlSeconds)),
  });
}
