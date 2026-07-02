import { randomBytes } from "node:crypto";
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
import { dbExecute, dbQuery, quoteIdentifier, tenantInsert, tenantSelect, tenantTable } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GALLERIA IMMAGINI PRODOTTO — port of the products.php AJAX actions
// (upload_image_ajax / delete_image_ajax / set_main_image, backed by
// products_handle_images_upload + products_images_for_ui): MAX 5 immagini per
// prodotto, max 5MB l'una, la PRIMA (sort_order più basso) è l'immagine
// principale; set_main riordina (0, 10, 20, ...). Storage su Cloudflare R2
// pubblico: product_images.image_path = URL pubblico completo (il legacy
// images_for_ui passa gli http assoluti invariati). Ogni azione risponde con
// la lista immagini aggiornata, come gli endpoint AJAX legacy.
//
// Divergenza documentata: niente compressione/resize server-side
// (process_uploaded_image 2000px nel legacy) — l'immagine è salvata come caricata.

const MAX_TOTAL = 5; // legacy ProductPageHelpers.php:57
const MAX_BYTES = 5 * 1024 * 1024;
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

type ProductImage = { id: number; url: string; sortOrder: number; isMain: boolean };

async function listImages(slug: string, productId: number): Promise<ProductImage[]> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "product_images",
    columns: "id, image_path, sort_order",
    where: "product_id = ?",
    params: [productId],
    orderBy: "sort_order ASC, id ASC",
  }).catch(() => [] as RowDataPacket[]);
  return rows.map((row, index) => ({
    id: Number(row.id ?? 0),
    url: String(row.image_path ?? ""),
    sortOrder: Number(row.sort_order ?? 0),
    isMain: index === 0,
  }));
}

// Riordino legacy set_main_image: la scelta prima, le altre a passi di 10.
async function reorderImages(slug: string, productId: number, order: number[]): Promise<void> {
  const table = await tenantTable(slug, "product_images");
  for (let i = 0; i < order.length; i++) {
    const sort = i === 0 ? 0 : i * 10;
    await dbExecute(
      `UPDATE ${quoteIdentifier(table.name)} SET sort_order = ? WHERE tenant_id = ? AND id = ? AND product_id = ?`,
      [sort, table.tenantId ?? 0, order[i], productId],
    );
  }
}

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "products.manage")) return jsonError("Permesso Magazzino richiesto.", 403);

  const url = new URL(request.url);
  const productId = Number.parseInt(String(url.searchParams.get("product_id") ?? "0"), 10) || 0;
  if (productId <= 0) return jsonError("Prodotto non valido.", 400);
  try {
    return Response.json({ ok: true, images: await listImages(tenantSlug, productId) });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Immagini non disponibili.", 400);
  }
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "products.manage")) return jsonError("Permesso Magazzino richiesto.", 403);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError("Invio non valido (atteso multipart/form-data).", 400);
  }

  const productId = Number.parseInt(String(form.get("product_id") ?? "0"), 10) || 0;
  if (productId <= 0) return jsonError("Prodotto non valido.", 400);

  try {
    // Prodotto tenant-scoped.
    const productRows = await tenantSelect<RowDataPacket>({
      slug: tenantSlug,
      table: "products",
      columns: "id",
      where: "id = ?",
      params: [productId],
      limit: 1,
    });
    if (!productRows[0]) return jsonError("Prodotto non trovato.", 404);

    const imagesTable = await tenantTable(tenantSlug, "product_images");
    const tenantId = Number(imagesTable.tenantId ?? 0);

    // --- SET MAIN (set_main_image): la scelta diventa la prima. ---
    const mainImgId = Number.parseInt(String(form.get("set_main_img_id") ?? "0"), 10) || 0;
    if (mainImgId > 0) {
      const current = await listImages(tenantSlug, productId);
      const ids = current.map((img) => img.id);
      if (!ids.includes(mainImgId)) return jsonError("Immagine non trovata.", 404);
      await reorderImages(tenantSlug, productId, [mainImgId, ...ids.filter((id) => id !== mainImgId)]);
      return Response.json({ ok: true, images: await listImages(tenantSlug, productId) });
    }

    // --- DELETE (delete_image_ajax) + normalizzazione ordinamento. ---
    const deleteImgId = Number.parseInt(String(form.get("delete_img_id") ?? "0"), 10) || 0;
    if (deleteImgId > 0) {
      const rows = await tenantSelect<RowDataPacket>({
        slug: tenantSlug,
        table: "product_images",
        columns: "id, image_path",
        where: "id = ? AND product_id = ?",
        params: [deleteImgId, productId],
        limit: 1,
      });
      if (rows[0]) {
        const key = storageKeyFromPublicUrl(String(rows[0].image_path ?? "").trim());
        if (key) await deletePublicObject(key);
        await dbExecute(
          `DELETE FROM ${quoteIdentifier(imagesTable.name)} WHERE tenant_id = ? AND id = ? AND product_id = ?`,
          [tenantId, deleteImgId, productId],
        );
        const remaining = await listImages(tenantSlug, productId);
        if (remaining.length) await reorderImages(tenantSlug, productId, remaining.map((img) => img.id));
      }
      return Response.json({ ok: true, images: await listImages(tenantSlug, productId) });
    }

    // --- UPLOAD (upload_image_ajax): uno o più file `images`. ---
    const files = form.getAll("images").filter((f): f is File => f instanceof File && f.size > 0);
    if (!files.length) return jsonError("Nessuna immagine caricata.", 400);
    if (!storageConfigured()) return jsonError(STORAGE_NOT_CONFIGURED_ERROR, 503);

    const countRows = await dbQuery<RowDataPacket[]>(
      `SELECT COUNT(*) AS n, COALESCE(MAX(sort_order),0) AS max_sort FROM ${quoteIdentifier(imagesTable.name)} WHERE tenant_id = ? AND product_id = ?`,
      [tenantId, productId],
    ).catch(() => [] as RowDataPacket[]);
    let existing = Number(countRows[0]?.n ?? 0);
    let maxSort = Number(countRows[0]?.max_sort ?? 0);

    const errors: string[] = [];
    let uploaded = 0;
    for (const file of files) {
      if (existing >= MAX_TOTAL) {
        errors.push("Limite massimo: 5 immagini per prodotto.");
        break;
      }
      if (file.size > MAX_BYTES) {
        errors.push("Immagine troppo grande (max 5 MB).");
        continue;
      }
      const ext = EXT_BY_MIME[String(file.type).toLowerCase()];
      if (!ext) {
        errors.push("Formato immagine non supportato (usa JPG, PNG, WEBP o GIF).");
        continue;
      }
      // NB: tenantStorageKey ripulisce l'area dai separatori — il productId va
      // nel filename (t{tenant}/products/{pid}-{random}.{ext}).
      const key = tenantStorageKey(tenantId, "products", `${productId}-${randomBytes(10).toString("hex")}.${ext}`);
      const body = new Uint8Array(await file.arrayBuffer());
      const publicUrl = await putPublicObject(key, body, String(file.type).toLowerCase());
      maxSort += 10;
      await tenantInsert(imagesTable, {
        product_id: productId,
        image_path: publicUrl,
        sort_order: maxSort,
        created_at: new Date(),
      });
      existing++;
      uploaded++;
    }

    return Response.json({ ok: uploaded > 0, uploaded, errors, images: await listImages(tenantSlug, productId) });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore immagini prodotto.", 400);
  }
}
