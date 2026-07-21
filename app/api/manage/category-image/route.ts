import { sniffImageMime } from "@/lib/upload-sniff";
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

// IMMAGINE CATEGORIA SERVIZI — port of the services.php tab=categories image
// upload (input image_file, max 5MB, salvata in service_categories.image_url;
// delete_image/remove_image per la rimozione), su Cloudflare R2 invece del
// disco locale. In image_url si salva l'URL PUBBLICO completo: il wizard
// pubblico legacy passa gli URL http assoluti invariati (booking.php 13097),
// quindi il valore resta compatibile nei due sensi. Consumatori: card
// categoria dello step 2 del booking + marketplace.
//
// Divergenza documentata: il legacy comprime/ridimensiona lato server
// (process_uploaded_image, max 1600px) — qui l'immagine è salvata come
// caricata (niente pipeline di resize; la CDN serve l'originale).

const MAX_IMAGE_BYTES = 5242880; // legacy services.php:3628 (5 MB)
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
  if (!can(session.user.perms, "service_categories.manage")) return jsonError("Permesso Categorie servizi richiesto.", 403);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError("Invio non valido (atteso multipart/form-data).", 400);
  }

  const categoryId = Number.parseInt(String(form.get("category_id") ?? "0"), 10) || 0;
  if (categoryId <= 0) return jsonError("Categoria non valida.", 400);

  try {
    const rows = await tenantSelect<RowDataPacket>({
      slug: tenantSlug,
      table: "service_categories",
      columns: "id, image_url",
      where: "id = ?",
      params: [categoryId],
      limit: 1,
    });
    if (!rows[0]) return jsonError("Categoria non trovata.", 404);
    const oldImageUrl = String(rows[0].image_url ?? "").trim();

    // --- RIMOZIONE (delete_image/remove_image del legacy) ---
    if (String(form.get("remove_image") ?? "") === "1") {
      const oldKey = storageKeyFromPublicUrl(oldImageUrl);
      if (oldKey) await deletePublicObject(oldKey);
      await tenantUpdate({ slug: tenantSlug, table: "service_categories", id: categoryId, values: { image_url: null } });
      return Response.json({ ok: true, imageUrl: "" });
    }

    // --- UPLOAD ---
    const file = form.get("image_file");
    if (!(file instanceof File) || file.size <= 0) return jsonError("Nessuna immagine caricata.", 400);
    if (file.size > MAX_IMAGE_BYTES) return jsonError("Immagine troppo grande (max 5 MB).", 400);
    const ext = EXT_BY_MIME[String(file.type).toLowerCase()];
    if (!ext) return jsonError("Formato immagine non supportato (usa JPG, PNG, WEBP o GIF).", 400);
    if (!storageConfigured()) return jsonError(STORAGE_NOT_CONFIGURED_ERROR, 503);

    const table = await tenantTable(tenantSlug, "service_categories");
    const tenantId = Number(table.tenantId ?? 0);
    const key = tenantStorageKey(tenantId, "categories", `${categoryId}-${Date.now()}.${ext}`);
    const body = new Uint8Array(await file.arrayBuffer());
    // MIME AUTORITATIVO dai magic bytes (audit giro 3): bucket PUBBLICO.
    const sniffed = sniffImageMime(body);
    if (!sniffed) return jsonError("Formato immagine non supportato (usa JPG, PNG, WEBP o GIF).", 400);
    const publicUrl = await putPublicObject(key, body, sniffed);

    await tenantUpdate({ slug: tenantSlug, table: "service_categories", id: categoryId, values: { image_url: publicUrl } });

    const oldKey = storageKeyFromPublicUrl(oldImageUrl);
    if (oldKey && oldKey !== key) await deletePublicObject(oldKey);

    return Response.json({ ok: true, imageUrl: publicUrl });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore caricamento immagine.", 400);
  }
}
