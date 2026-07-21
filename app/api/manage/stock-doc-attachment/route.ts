import { sniffPdfOrJpeg } from "@/lib/upload-sniff";
import { randomBytes } from "node:crypto";
import { jsonError } from "@/lib/api-utils";
import { currentManageSession } from "@/lib/manage-auth";
import { locationAllowedForSedi, sessionAllowedLocationIds } from "@/lib/manage-locations";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { can } from "@/lib/role-permissions";
import {
  STORAGE_NOT_CONFIGURED_ERROR,
  deletePrivateObject,
  presignedPrivateGetUrl,
  putPrivateObject,
  storagePrivateConfigured,
} from "@/lib/storage";
import type { RowDataPacket } from "@/lib/tenant-db";
import { tenantSelect, tenantTable, tenantUpdate } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ALLEGATO DOCUMENTO MAGAZZINO — port di stock_moves.php $handleUpload
// (102-210) + stock_doc_attachment.php: logica IDENTICA agli allegati costi
// (solo PDF o JPG, max 5 MB, colonne stock_docs.attachment_path/mime/name/
// size), su Cloudflare R2 PRIVATO. Il download passa da questa route che
// verifica sessione + permesso stock_moves.manage e redirige a un presigned
// URL a scadenza breve (il legacy serve via streaming autenticato con
// .htaccess che blocca l'accesso diretto a uploads/tenants/*/stock_docs/).
//
// Divergenza documentata (come i costi): niente compressione server-side
// (GD 2000x2000 per i JPG, Ghostscript /ebook per i PDF nel legacy).

const MAX_BYTES = 5242880; // legacy stock_moves.php (5 MB)
const EXT_BY_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
};

function isR2Key(path: string): boolean {
  return /^t\d+\//.test(path);
}

async function loadStockDoc(slug: string, id: number): Promise<RowDataPacket | null> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "stock_docs",
    columns: "id, attachment_path, attachment_mime, attachment_name, location_id",
    where: "id = ?",
    params: [id],
    limit: 1,
  });
  return rows[0] ?? null;
}

// DOWNLOAD: ?id=<stockDocId> -> 302 verso il presigned URL del bucket privato.
export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "stock_moves.manage")) return jsonError("Permesso Carico / Scarico richiesto.", 403);

  const url = new URL(request.url);
  const id = Number.parseInt(String(url.searchParams.get("id") ?? "0"), 10) || 0;
  if (id <= 0) return jsonError("Documento non valido.", 400);

  try {
    const doc = await loadStockDoc(tenantSlug, id);
    if (!doc) return jsonError("File non trovato", 404);
    // Guardia per-sede: un operatore ristretto non puo' scaricare l'allegato di un documento di altra sede.
    if (!locationAllowedForSedi(Number(doc.location_id ?? 0) || 0, sessionAllowedLocationIds(session))) return jsonError("File non trovato", 404);
    const path = String(doc.attachment_path ?? "").trim();
    if (!path) return jsonError("File non trovato", 404);
    if (!isR2Key(path)) {
      return jsonError("Allegato legacy non migrato: ricarica il file dal movimento.", 404);
    }
    const signed = await presignedPrivateGetUrl(path, 300);
    return Response.redirect(signed, 302);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Allegato non disponibile.", 400);
  }
}

// UPLOAD / RIMOZIONE: multipart {stock_doc_id, attachment | remove_attachment=1}.
export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "stock_moves.manage")) return jsonError("Permesso Carico / Scarico richiesto.", 403);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError("Invio non valido (atteso multipart/form-data).", 400);
  }

  const docId = Number.parseInt(String(form.get("stock_doc_id") ?? form.get("id") ?? "0"), 10) || 0;
  if (docId <= 0) return jsonError("Documento non valido.", 400);

  try {
    const doc = await loadStockDoc(tenantSlug, docId);
    if (!doc) return jsonError("File non trovato", 404);
    // Guardia per-sede: niente upload/rimozione dell'allegato di un documento di altra sede.
    if (!locationAllowedForSedi(Number(doc.location_id ?? 0) || 0, sessionAllowedLocationIds(session))) return jsonError("File non trovato", 404);
    const oldPath = String(doc.attachment_path ?? "").trim();

    // --- RIMOZIONE ---
    if (String(form.get("remove_attachment") ?? "") === "1") {
      if (isR2Key(oldPath)) await deletePrivateObject(oldPath);
      await tenantUpdate({
        slug: tenantSlug,
        table: "stock_docs",
        id: docId,
        values: { attachment_path: null, attachment_mime: null, attachment_name: null, attachment_size: null },
      });
      return Response.json({ ok: true, attachmentName: "" });
    }

    // --- UPLOAD ---
    const file = form.get("attachment");
    if (!(file instanceof File) || file.size <= 0) return jsonError("Nessun file caricato.", 400);
    if (file.size > MAX_BYTES) return jsonError("File troppo grande (max 5 MB)", 400);
    const ext = EXT_BY_MIME[String(file.type).toLowerCase()];
    if (!ext) return jsonError("Formato non supportato (solo PDF o JPG)", 400);
    if (!storagePrivateConfigured()) return jsonError(STORAGE_NOT_CONFIGURED_ERROR, 503);

    const table = await tenantTable(tenantSlug, "stock_docs");
    const tenantId = Number(table.tenantId ?? 0);
    // Key come il legacy: stock_docs/<docId>/<random>.<ext>.
    const key = `t${tenantId}/stock_docs/${docId}/${randomBytes(10).toString("hex")}.${ext}`;
    const body = new Uint8Array(await file.arrayBuffer());
    // MIME AUTORITATIVO dai magic bytes (audit giro 3).
    const sniffed = sniffPdfOrJpeg(body);
    if (!sniffed) return jsonError("Formato non supportato (solo PDF o JPG)", 400);
    await putPrivateObject(key, body, sniffed);

    const attachmentName = String(file.name ?? `documento.${ext}`).trim().slice(0, 190) || `documento.${ext}`;
    await tenantUpdate({
      slug: tenantSlug,
      table: "stock_docs",
      id: docId,
      values: {
        attachment_path: key,
        attachment_mime: String(file.type).toLowerCase(),
        attachment_name: attachmentName,
        attachment_size: file.size,
      },
    });

    if (isR2Key(oldPath) && oldPath !== key) await deletePrivateObject(oldPath);

    return Response.json({ ok: true, attachmentName });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore caricamento allegato.", 400);
  }
}
