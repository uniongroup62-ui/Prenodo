import { jsonError, parseInteger, parseRequestBody } from "@/lib/api-utils";
import {
  deleteSheetAttachment,
  deleteSheetRecord,
  deleteSheetTemplate,
  listSheetRecordsForClient,
  listSheetTemplates,
  saveSheetRecord,
  saveSheetTemplate,
  sheetAttachmentPresignedUrl,
  type SheetUpload,
} from "@/lib/client-sheets";
import { currentManageSession } from "@/lib/manage-auth";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { can } from "@/lib/role-permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// SCHEDE TECNICHE CLIENTE — port di client_sheets.php + client_sheet_templates.php
// (dispatcher _action: save_template / delete_template / save_record /
// delete_record / delete_attachment) + client_sheet_attachment.php (download
// via presigned R2). Perm: client_sheets.manage come il legacy.

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "client_sheets.manage")) return jsonError("Permesso schede cliente mancante.", 403);

  const url = new URL(request.url);
  try {
    // Download allegato: ?record_id=&client_id=&attachment_id= -> 302 presigned.
    const attachmentId = String(url.searchParams.get("attachment_id") ?? "").trim();
    if (attachmentId) {
      const recordId = parseInteger(url.searchParams.get("record_id"), 0);
      const clientId = parseInteger(url.searchParams.get("client_id"), 0);
      if (recordId <= 0 || clientId <= 0) return jsonError("File non trovato", 404);
      const signed = await sheetAttachmentPresignedUrl(tenantSlug, recordId, clientId, attachmentId);
      return Response.redirect(signed, 302);
    }

    const clientId = parseInteger(url.searchParams.get("client_id"), 0);
    const templates = await listSheetTemplates(tenantSlug);
    const records = clientId > 0 ? await listSheetRecordsForClient(tenantSlug, clientId) : [];
    return Response.json({
      ok: true,
      sourceMode: "database",
      templates,
      records,
      kpis: {
        templates: templates.length,
        activeTemplates: templates.filter((t) => t.isActive).length,
        records: records.length,
        lastRecordDate: records[0]?.sessionDate ?? null,
      },
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore schede cliente.", error instanceof Error && /non trovato/i.test(error.message) ? 404 : 400);
  }
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "client_sheets.manage")) return jsonError("Permesso schede cliente mancante.", 403);

  const contentType = String(request.headers.get("content-type") ?? "");
  let body: Record<string, unknown> = {};
  const uploads: SheetUpload[] = [];

  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      for (const [key, value] of form.entries()) {
        if (value instanceof File) {
          // Campi upload legacy: field_upload_<fieldId> (anche multipli).
          const m = /^field_upload_(.+)$/.exec(key);
          if (m && value.size > 0) {
            uploads.push({ fieldId: m[1], name: value.name, mime: value.type, bytes: new Uint8Array(await value.arrayBuffer()) });
          }
          continue;
        }
        body[key] = String(value);
      }
    } else {
      body = await parseRequestBody(request);
    }

    const action = String(body._action ?? body.action ?? "");

    if (action === "save_template") {
      let fields: Array<Record<string, unknown>> = [];
      try {
        const parsed = JSON.parse(String(body.fields_json ?? "[]"));
        if (Array.isArray(parsed)) fields = parsed as Array<Record<string, unknown>>;
      } catch {
        fields = [];
      }
      let locationIds: number[] = [];
      try {
        const parsed = JSON.parse(String(body.location_ids_json ?? "[]"));
        if (Array.isArray(parsed)) locationIds = parsed.map((v) => Number(v) || 0);
      } catch {
        locationIds = String(body.location_ids ?? "").split(",").map((v) => Number(v.trim()) || 0);
      }
      const id = await saveSheetTemplate(tenantSlug, {
        id: parseInteger(body.template_id ?? body.id, 0) || undefined,
        title: String(body.title ?? ""),
        description: String(body.description ?? ""),
        isActive: ["1", "true", "on", "yes"].includes(String(body.is_active ?? "1").toLowerCase()),
        fields,
        locationIds,
      }, session.user.id ?? null);
      return Response.json({ ok: true, message: "Tab salvato correttamente.", templateId: id, templates: await listSheetTemplates(tenantSlug) });
    }

    if (action === "delete_template") {
      await deleteSheetTemplate(tenantSlug, parseInteger(body.template_id ?? body.id, 0), session.user.id ?? null);
      return Response.json({ ok: true, message: "Tab eliminato.", templates: await listSheetTemplates(tenantSlug) });
    }

    const clientId = parseInteger(body.client_id, 0);

    if (action === "save_record") {
      const templateId = parseInteger(body.template_id, 0);
      if (templateId <= 0) return jsonError("Seleziona prima un tab.", 400);
      let values: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(String(body.values_json ?? "{}"));
        if (parsed && typeof parsed === "object") values = parsed as Record<string, unknown>;
      } catch {
        values = {};
      }
      const recordId = await saveSheetRecord(tenantSlug, {
        clientId,
        templateId,
        recordId: parseInteger(body.record_id, 0) || null,
        locationId: parseInteger(body.location_id, 0),
        input: {
          values,
          session_date: body.session_date,
          next_session_date: body.next_session_date,
          operator_name: body.operator_name,
          title: body.title,
          notes: body.notes,
          remove_attachments_json: body.remove_attachments_json,
        },
        uploads,
        userId: session.user.id ?? null,
      });
      return Response.json({
        ok: true,
        message: "Scheda tecnica salvata correttamente.",
        recordId,
        records: await listSheetRecordsForClient(tenantSlug, clientId),
      });
    }

    if (action === "delete_record") {
      const recordId = parseInteger(body.record_id ?? body.id, 0);
      if (recordId <= 0) return jsonError("Scheda non valida.", 400);
      await deleteSheetRecord(tenantSlug, recordId, clientId);
      return Response.json({ ok: true, message: "Scheda tecnica eliminata.", records: await listSheetRecordsForClient(tenantSlug, clientId) });
    }

    if (action === "delete_attachment") {
      await deleteSheetAttachment(tenantSlug, parseInteger(body.record_id, 0), clientId, String(body.attachment_id ?? ""));
      return Response.json({ ok: true, message: "File eliminato.", records: await listSheetRecordsForClient(tenantSlug, clientId) });
    }

    return jsonError("Operazione non riuscita.", 400);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Operazione non riuscita.", 400);
  }
}
