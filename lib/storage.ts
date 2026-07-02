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

import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

type StorageEnv = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBucket: string;
  privateBucket: string;
  publicBaseUrl: string;
};

function storageEnv(): StorageEnv {
  return {
    accountId: String(process.env.R2_ACCOUNT_ID ?? "").trim(),
    accessKeyId: String(process.env.R2_ACCESS_KEY_ID ?? "").trim(),
    secretAccessKey: String(process.env.R2_SECRET_ACCESS_KEY ?? "").trim(),
    publicBucket: String(process.env.R2_BUCKET_PUBLIC ?? "").trim(),
    privateBucket: String(process.env.R2_BUCKET_PRIVATE ?? "").trim(),
    publicBaseUrl: String(process.env.R2_PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, ""),
  };
}

// True when the PUBLIC side is usable (credentials + public bucket + base URL).
// The private side additionally needs R2_BUCKET_PRIVATE (storagePrivateConfigured).
export function storageConfigured(): boolean {
  const env = storageEnv();
  return Boolean(env.accountId && env.accessKeyId && env.secretAccessKey && env.publicBucket && env.publicBaseUrl);
}

export function storagePrivateConfigured(): boolean {
  const env = storageEnv();
  return Boolean(env.accountId && env.accessKeyId && env.secretAccessKey && env.privateBucket);
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
    endpoint: `https://${env.accountId}.r2.cloudflarestorage.com`,
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

// Presigned GET sul bucket PRIVATO (default 5 minuti). Il chiamante DEVE aver
// già verificato sessione + tenant + ownership dell'oggetto.
export async function presignedPrivateGetUrl(key: string, ttlSeconds = 300): Promise<string> {
  if (!storagePrivateConfigured()) throw new Error(STORAGE_NOT_CONFIGURED_ERROR);
  const env = storageEnv();
  return getSignedUrl(r2Client(), new GetObjectCommand({ Bucket: env.privateBucket, Key: key }), {
    expiresIn: Math.max(30, Math.min(3600, ttlSeconds)),
  });
}
