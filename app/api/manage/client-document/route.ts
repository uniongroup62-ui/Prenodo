import { randomBytes } from "node:crypto";
import { jsonError } from "@/lib/api-utils";
import { currentManageSession } from "@/lib/manage-auth";
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
import { dbExecute, dbQuery, quoteIdentifier, tenantInsert, tenantSelect, tenantTable } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// DOCUMENTI CLIENTE — port of the clients.php view documents block (~2118-2179):
// upload `doc` (10MB, PDF/PNG/JPG/WEBP, estensione FORZATA dal MIME — mai dal
// filename) + titolo, elenco, download e delete con i guard legacy (il documento
// GDPR ufficiale e i documenti ufficiali dei moduli consenso non si eliminano
// da qui). Storage su Cloudflare R2 PRIVATO: file_path = KEY R2, il download
// passa da questa route (check sessione+tenant) con 302 verso un presigned URL
// a scadenza breve. I path legacy (/uploads/...) non migrati -> messaggio chiaro.

const MAX_BYTES = 10 * 1024 * 1024; // legacy clients.php:2127 (10 MB)
const EXT_BY_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

function isR2Key(path: string): boolean {
  return /^t\d+\//.test(path);
}

// Elenco documenti di un cliente (per la sezione del dettaglio cliente).
async function listDocs(slug: string, clientId: number) {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "customer_documents",
    columns: "id, title, file_path, mime, created_at",
    where: "client_id = ?",
    params: [clientId],
    orderBy: "created_at DESC, id DESC",
    limit: 50,
  }).catch(() => [] as RowDataPacket[]);
  return rows.map((row) => ({
    id: Number(row.id ?? 0),
    title: String(row.title ?? "Documento"),
    mime: String(row.mime ?? ""),
    createdAt: row.created_at ? String(row.created_at).slice(0, 19).replace("T", " ") : "",
    // downloadable solo per le key R2 (i path legacy non sono migrati).
    downloadable: isR2Key(String(row.file_path ?? "").trim()),
  }));
}

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "clients.manage")) return jsonError("Permesso clienti mancante.", 403);

  const url = new URL(request.url);
  const docId = Number.parseInt(String(url.searchParams.get("id") ?? "0"), 10) || 0;
  const clientId = Number.parseInt(String(url.searchParams.get("client_id") ?? "0"), 10) || 0;

  try {
    // Modalità ELENCO (?client_id=): i documenti del cliente per la UI.
    if (docId <= 0 && clientId > 0) {
      return Response.json({ ok: true, docs: await listDocs(tenantSlug, clientId) });
    }
    if (docId <= 0) return jsonError("Documento non valido.", 400);

    // Modalità DOWNLOAD (?id=): 302 verso il presigned URL del bucket privato.
    const rows = await tenantSelect<RowDataPacket>({
      slug: tenantSlug,
      table: "customer_documents",
      columns: "id, file_path",
      where: "id = ?",
      params: [docId],
      limit: 1,
    });
    if (!rows[0]) return jsonError("Documento non trovato.", 404);
    const path = String(rows[0].file_path ?? "").trim();
    if (!isR2Key(path)) return jsonError("Documento legacy non migrato: ricaricalo dalla scheda cliente.", 404);
    const signed = await presignedPrivateGetUrl(path, 300);
    return Response.redirect(signed, 302);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Documento non disponibile.", 400);
  }
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "clients.manage")) return jsonError("Permesso clienti mancante.", 403);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError("Invio non valido (atteso multipart/form-data).", 400);
  }

  const clientId = Number.parseInt(String(form.get("client_id") ?? "0"), 10) || 0;
  if (clientId <= 0) return jsonError("Cliente non valido.", 400);

  try {
    // Cliente tenant-scoped (+ gdpr_document_id per il guard di eliminazione).
    const clientRows = await tenantSelect<RowDataPacket>({
      slug: tenantSlug,
      table: "clients",
      columns: "id, gdpr_document_id",
      where: "id = ?",
      params: [clientId],
      limit: 1,
    }).catch(async () =>
      // installazioni senza la colonna gdpr_document_id
      tenantSelect<RowDataPacket>({ slug: tenantSlug, table: "clients", columns: "id", where: "id = ?", params: [clientId], limit: 1 }),
    );
    if (!clientRows[0]) return jsonError("Cliente non trovato.", 404);
    const gdprDocumentId = Number(clientRows[0].gdpr_document_id ?? 0) || 0;

    // --- ELIMINAZIONE (do=delete_doc del legacy, con i guard ufficiali) ---
    const deleteDocId = Number.parseInt(String(form.get("delete_doc_id") ?? "0"), 10) || 0;
    if (deleteDocId > 0) {
      const docRows = await tenantSelect<RowDataPacket>({
        slug: tenantSlug,
        table: "customer_documents",
        columns: "id, client_id, file_path",
        where: "id = ? AND client_id = ?",
        params: [deleteDocId, clientId],
        limit: 1,
      });
      if (!docRows[0]) return jsonError("Documento non trovato.", 404);
      if (gdprDocumentId > 0 && deleteDocId === gdprDocumentId) {
        return jsonError("Il documento GDPR ufficiale puo essere rimosso solo tramite Reset GDPR.", 400);
      }
      // Documenti ufficiali dei moduli consenso (client_consent_records.document_id).
      try {
        const consents = await tenantTable(tenantSlug, "client_consent_records");
        const protectedRows = await dbQuery<RowDataPacket[]>(
          `SELECT 1 AS x FROM ${quoteIdentifier(consents.name)} WHERE tenant_id = ? AND client_id = ? AND document_id = ? LIMIT 1`,
          [consents.tenantId ?? 0, clientId, deleteDocId],
        );
        if (protectedRows.length > 0) {
          return jsonError("Il documento ufficiale del modulo consenso puo essere rimosso solo tramite Reset modulo.", 400);
        }
      } catch {
        // tabella assente: nessun guard consensi
      }
      const path = String(docRows[0].file_path ?? "").trim();
      if (isR2Key(path)) await deletePrivateObject(path);
      const docs = await tenantTable(tenantSlug, "customer_documents");
      await dbExecute(`DELETE FROM ${quoteIdentifier(docs.name)} WHERE tenant_id = ? AND id = ?`, [docs.tenantId ?? 0, deleteDocId]);
      return Response.json({ ok: true, docs: await listDocs(tenantSlug, clientId) });
    }

    // --- UPLOAD ---
    const file = form.get("doc");
    if (!(file instanceof File) || file.size <= 0) return jsonError("Nessun file caricato.", 400);
    if (file.size > MAX_BYTES) return jsonError("File troppo grande", 400);
    const mime = String(file.type).toLowerCase();
    const ext = EXT_BY_MIME[mime];
    if (!ext) return jsonError("Formato non supportato", 400);
    if (!storagePrivateConfigured()) return jsonError(STORAGE_NOT_CONFIGURED_ERROR, 503);

    const docsTable = await tenantTable(tenantSlug, "customer_documents");
    const tenantId = Number(docsTable.tenantId ?? 0);
    // Come il legacy: nome random esadecimale + estensione dal MIME.
    const key = `t${tenantId}/clients/${clientId}/${randomBytes(10).toString("hex")}.${ext}`;
    const body = new Uint8Array(await file.arrayBuffer());
    await putPrivateObject(key, body, mime);

    const title = String(form.get("title") ?? "").trim().slice(0, 190) || "Documento";
    await tenantInsert(docsTable, {
      client_id: clientId,
      title,
      file_path: key,
      mime,
      created_at: new Date(),
    });

    return Response.json({ ok: true, docs: await listDocs(tenantSlug, clientId) });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore documento cliente.", 400);
  }
}
