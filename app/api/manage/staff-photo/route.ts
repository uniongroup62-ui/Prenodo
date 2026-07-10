import { jsonError } from "@/lib/api-utils";
import { currentManageSession } from "@/lib/manage-auth";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { can } from "@/lib/role-permissions";
import {
  STORAGE_NOT_CONFIGURED_ERROR,
  deletePublicObject,
  putPublicObject,
  storageConfigured,
  storageKeyFromPublicUrl,
  tenantStorageKey,
} from "@/lib/storage";
import type { RowDataPacket } from "@/lib/tenant-db";
import { tenantSelect, tenantTable, tenantUpdate } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// FOTO OPERATORE — port of the staff.php photo upload (operator_photo multipart,
// max 5MB, jpeg/png/webp/gif; staff_action=delete_photo per la rimozione), su
// Cloudflare R2 invece del disco locale. In staff.photo_path si salva l'URL
// PUBBLICO completo: il rendering (calendario, booking, lista staff) usa già
// photoPath cosi com'è, e il legacy staff_photo_url passa gli URL http assoluti
// invariati — compatibile nei due sensi.
//
// Divergenza documentata: il crop/zoom client-side del legacy
// (photo_crop_data + process_uploaded_staff_photo) non è portato — l'immagine
// viene salvata come caricata; il ritaglio circolare resta quello CSS.

const MAX_PHOTO_BYTES = 5242880; // legacy staff.php:747 (5 MB)
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "staff.manage")) return jsonError("Permesso Operatori richiesto.", 403);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError("Invio non valido (atteso multipart/form-data).", 400);
  }

  // Messaggi verbatim del legacy (staff.php 705-728, senza punto finale).
  const staffId = Number.parseInt(String(form.get("staff_id") ?? "0"), 10) || 0;
  if (staffId <= 0) return jsonError("Operatore non valido", 400);

  try {
    // Riga staff tenant-scoped (+ SSO guard: l'operatore tecnico non si tocca).
    const rows = await tenantSelect<RowDataPacket>({
      slug: tenantSlug,
      table: "staff",
      columns: "id, full_name, photo_path",
      where: "id = ?",
      params: [staffId],
      limit: 1,
    });
    const staffRow = rows[0];
    if (!staffRow) return jsonError("Operatore non trovato.", 404);
    if (String(staffRow.full_name ?? "").trim().toUpperCase() === "SSO") {
      return jsonError("Operatore SSO non modificabile", 400);
    }
    const oldPhotoUrl = String(staffRow.photo_path ?? "").trim();

    // --- RIMOZIONE (staff_action=delete_photo) ---
    if (String(form.get("remove_photo") ?? "") === "1") {
      const oldKey = storageKeyFromPublicUrl(oldPhotoUrl);
      if (oldKey) await deletePublicObject(oldKey);
      await tenantUpdate({ slug: tenantSlug, table: "staff", id: staffId, values: { photo_path: null } });
      return Response.json({ ok: true, photoPath: "" });
    }

    // --- UPLOAD ---
    // process_uploaded_staff_photo (Helpers.php 10827): 'Upload immagine non
    // valido' per file assente/corrotto, size e formato con i testi legacy.
    const file = form.get("operator_photo");
    if (!(file instanceof File) || file.size <= 0) return jsonError("Upload immagine non valido", 400);
    if (file.size > MAX_PHOTO_BYTES) return jsonError("Immagine troppo grande (max 5 MB).", 400);
    const ext = EXT_BY_MIME[String(file.type).toLowerCase()];
    if (!ext) return jsonError("Formato non valido: carica JPG, PNG, WEBP o GIF", 400);
    if (!storageConfigured()) return jsonError(STORAGE_NOT_CONFIGURED_ERROR, 503);

    const table = await tenantTable(tenantSlug, "staff");
    const tenantId = Number(table.tenantId ?? 0);
    // Key con timestamp: ogni upload è un oggetto nuovo (cache CDN immutabile),
    // il vecchio viene cancellato dopo la sostituzione.
    const key = tenantStorageKey(tenantId, "staff", `${staffId}-${Date.now()}.${ext}`);
    const body = new Uint8Array(await file.arrayBuffer());
    const publicUrl = await putPublicObject(key, body, String(file.type).toLowerCase());

    await tenantUpdate({ slug: tenantSlug, table: "staff", id: staffId, values: { photo_path: publicUrl } });

    const oldKey = storageKeyFromPublicUrl(oldPhotoUrl);
    if (oldKey && oldKey !== key) await deletePublicObject(oldKey);

    return Response.json({ ok: true, photoPath: publicUrl });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore caricamento foto.", 400);
  }
}
