import { randomBytes } from "node:crypto";
import { jsonError } from "@/lib/api-utils";
import { currentManageSession } from "@/lib/manage-auth";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { getManageLocationContext, resolveManageLocationId } from "@/lib/manage-locations";
import { canAny } from "@/lib/role-permissions";
import {
  STORAGE_NOT_CONFIGURED_ERROR,
  deletePrivateObject,
  presignedPrivateGetUrl,
  putPrivateObject,
  storagePrivateConfigured,
} from "@/lib/storage";
import type { RowDataPacket } from "@/lib/tenant-db";
import { columnExists, tenantSelect, tenantTable, tenantUpdate } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ALLEGATO COSTO — port of the costs.php attachment (solo PDF o JPG, max 5MB,
// colonne costs.attachment_path/mime/name/size), su Cloudflare R2 PRIVATO
// invece del disco locale. In attachment_path si salva la KEY R2 (i documenti
// privati non hanno URL pubblico); il download passa da questa route che
// verifica sessione+tenant e REDIRIGE a un presigned URL a scadenza breve.
// I path legacy (/uploads/...) non migrati rispondono con un messaggio chiaro.
//
// Divergenza documentata: niente compressione server-side (GD per i JPG,
// Ghostscript per i PDF nel legacy) — il file è salvato come caricato.

const WORK_PERMS = ["costs.manage", "costs.items"];
const MAX_BYTES = 5242880; // legacy costs.php:318 (5 MB)
const EXT_BY_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
};

// Una attachment_path è una key R2 quando è tenant-namespaced (t<digits>/...).
function isR2Key(path: string): boolean {
  return /^t\d+\//.test(path);
}

// SNIFFING del MIME reale dai magic bytes (port di app_detect_file_mime del legacy): non ci si
// fida del Content-Type DICHIARATO dal browser (un file rinominato .pdf/.jpg passerebbe). PDF
// inizia con "%PDF" (25 50 44 46); JPEG con FF D8 FF (copre JFIF ed EXIF).
function detectFileMime(bytes: Uint8Array): "application/pdf" | "image/jpeg" | null {
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "application/pdf";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

async function loadCost(slug: string, id: number, locationId = 0): Promise<RowDataPacket | null> {
  // SCOPE SEDE: un costo di un'altra sede non è accessibile (download/upload) — allineato al
  // check app_location_allowed_for_user del legacy cost_attachment.php. NULL-permissiva.
  let where = "id = ?";
  const params: unknown[] = [id];
  if (locationId > 0) {
    const table = await tenantTable(slug, "costs");
    if (await columnExists(table.name, "location_id")) {
      where += " AND (location_id = ? OR location_id IS NULL)";
      params.push(locationId);
    }
  }
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "costs",
    columns: "id, attachment_path, attachment_mime, attachment_name, location_id",
    where,
    params,
    limit: 1,
  });
  return rows[0] ?? null;
}

// DOWNLOAD: ?id= -> 302 verso il presigned URL del bucket privato.
export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!canAny(session.user.perms, WORK_PERMS)) return jsonError("Permesso Costi richiesto.", 403);

  const url = new URL(request.url);
  const id = Number.parseInt(String(url.searchParams.get("id") ?? "0"), 10) || 0;
  if (id <= 0) return jsonError("Costo non valido.", 400);

  try {
    const scopeLocationId = await resolveManageLocationId({ slug: tenantSlug, raw: url.searchParams.get("location_id"), fallbackCurrent: true });
    // FAIL-CLOSED sedi revocate (classe 18/07): senza sede risolta in un tenant
    // con sedi, niente scope-0 tenant-wide sull allegato.
    if (scopeLocationId <= 0 && (await getManageLocationContext(tenantSlug)).allLocations.length > 0) return jsonError("Costo non trovato.", 404);
    const cost = await loadCost(tenantSlug, id, scopeLocationId);
    if (!cost) return jsonError("Costo non trovato.", 404);
    const path = String(cost.attachment_path ?? "").trim();
    if (!path) return jsonError("Nessun allegato per questo costo.", 404);
    if (!isR2Key(path)) {
      return jsonError("Allegato legacy non migrato: ricarica il file dal costo.", 404);
    }
    const signed = await presignedPrivateGetUrl(path, 300);
    return Response.redirect(signed, 302);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Allegato non disponibile.", 400);
  }
}

// UPLOAD / RIMOZIONE: multipart {cost_id, attachment | remove_attachment=1}.
export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!canAny(session.user.perms, WORK_PERMS)) return jsonError("Permesso Costi richiesto.", 403);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError("Invio non valido (atteso multipart/form-data).", 400);
  }

  const costId = Number.parseInt(String(form.get("cost_id") ?? "0"), 10) || 0;
  if (costId <= 0) return jsonError("Costo non valido.", 400);

  try {
    const scopeLocationId = await resolveManageLocationId({ slug: tenantSlug, raw: form.get("location_id") as string | null, fallbackCurrent: true });
    // FAIL-CLOSED sedi revocate (classe 18/07): come il GET.
    if (scopeLocationId <= 0 && (await getManageLocationContext(tenantSlug)).allLocations.length > 0) return jsonError("Costo non trovato.", 404);
    const cost = await loadCost(tenantSlug, costId, scopeLocationId);
    if (!cost) return jsonError("Costo non trovato.", 404);
    const oldPath = String(cost.attachment_path ?? "").trim();

    // --- RIMOZIONE ---
    if (String(form.get("remove_attachment") ?? "") === "1") {
      if (isR2Key(oldPath)) await deletePrivateObject(oldPath);
      await tenantUpdate({
        slug: tenantSlug,
        table: "costs",
        id: costId,
        values: { attachment_path: null, attachment_mime: null, attachment_name: null, attachment_size: null },
      });
      return Response.json({ ok: true, attachmentName: "" });
    }

    // --- UPLOAD ---
    const file = form.get("attachment");
    if (!(file instanceof File) || file.size <= 0) return jsonError("Nessun file caricato.", 400);
    if (file.size > MAX_BYTES) return jsonError("File troppo grande (max 5 MB)", 400);

    const body = new Uint8Array(await file.arrayBuffer());
    // Tipo AUTORITATIVO dal contenuto reale (magic bytes), non dal Content-Type dichiarato: un file
    // rinominato (o con tipo browser errato) che non e' davvero PDF/JPG viene rifiutato come nel legacy.
    const detectedMime = detectFileMime(body);
    const ext = detectedMime ? EXT_BY_MIME[detectedMime] : undefined;
    if (!detectedMime || !ext) return jsonError("Formato non supportato (solo PDF o JPG)", 400);
    if (!storagePrivateConfigured()) return jsonError(STORAGE_NOT_CONFIGURED_ERROR, 503);

    const table = await tenantTable(tenantSlug, "costs");
    const tenantId = Number(table.tenantId ?? 0);
    // Key come il legacy: costs/<id>/<random>.<ext> (base random esadecimale).
    const key = `t${tenantId}/costs/${costId}/${randomBytes(10).toString("hex")}.${ext}`;
    await putPrivateObject(key, body, detectedMime);

    const attachmentName = String(file.name ?? `documento.${ext}`).trim().slice(0, 190) || `documento.${ext}`;
    await tenantUpdate({
      slug: tenantSlug,
      table: "costs",
      id: costId,
      values: {
        attachment_path: key,
        attachment_mime: detectedMime,
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
