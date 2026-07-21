import { businessNowDateTime } from "@/lib/business-datetime";
import { randomBytes } from "node:crypto";
import { jsonError } from "@/lib/api-utils";
import {
  PRIVACY_EMAIL_REQUIRED_MESSAGE,
  consentModuleSnapshotCreate,
  consentModuleTypeLabel,
  consentModulesAvailableForClient,
  consentRecordCreate,
  consentRecordFind,
  consentRecordReset,
  consentRecordStatusMeta,
  consentRecordUpdatePending,
  consentRecordUpdateSigned,
  consentRecordsForClient,
  consentSendOfficialPdfEmail,
  consentSendSignatureEmail,
  privacySendOfficialPdfEmail,
  privacySendSignatureEmail,
} from "@/lib/consent-records";
import { logActivity } from "@/lib/activity-log";
import { buildClientGdprExport } from "@/lib/client-gdpr-export";
import { currentManageSession } from "@/lib/manage-auth";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import {
  privacyClientDisplayName,
  privacyConsentLabels,
  privacyConsentsFromClient,
  privacyPdfSafeFilename,
  privacySnapshotCreate,
  privacyStatusMeta,
  privacyStatusNormalize,
  type PrivacyConsents,
} from "@/lib/privacy-consent";
import { renderPrivacyPdf } from "@/lib/privacy-pdf";
import { can } from "@/lib/role-permissions";
import { STORAGE_NOT_CONFIGURED_ERROR, putPrivateObject, storagePrivateConfigured } from "@/lib/storage";
import type { RowDataPacket } from "@/lib/tenant-db";
import { tenantDelete, tenantInsert, tenantSelect, tenantTable, tenantUpdate } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// CONSENSI CLIENTE (GDPR + moduli) — port of app/pages/client_consents.php:
//  - GET ?client_id=                     -> stato pagina: box GDPR (stato/consensi/
//    date/URL pubblici), record moduli consenso associati, moduli associabili.
//  - GET ?client_id=&do=gdpr_print       -> PDF privacy dallo snapshot (solo draft).
//  - GET ?client_id=&do=consent_print&record_id= -> PDF modulo (solo draft).
//  - POST multipart _mode=gdpr_action    -> save_consents | send_signature |
//    manual_upload (gdpr_signed_pdf) | send_privacy | reset. Messaggi e guard
//    legacy esatti, incluso il ROLLBACK di token/stato se l'email non parte.
//  - POST _mode=associate_module         -> associa un modulo attivo al cliente.
//  - POST _mode=consent_record_action    -> send_signature | manual_upload
//    (signed_pdf) | remove | send_pdf | reset sul singolo record.
// Perm legacy: client_consents.manage. Documenti firmati su R2 privato
// (customer_documents), link email verso le pagine pubbliche
// /{slug}/gdpr_public e /{slug}/consent_public.

const clean = (v: unknown) => String(v ?? "").trim();

function nowSql(): string {
  // Wall-time ROMA (audit giro 3: era l'orologio del server, UTC su Amplify).
  return businessNowDateTime();
}

function fmtDateTime(value: unknown): string {
  const m = clean(value).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : "";
}

function makePublicToken(): string {
  return randomBytes(32).toString("hex");
}

async function loadClient(slug: string, clientId: number): Promise<RowDataPacket | null> {
  if (clientId <= 0) return null;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "clients", where: "id = ?", params: [clientId], limit: 1 });
  return rows[0] ?? null;
}

async function loadBiz(slug: string): Promise<RowDataPacket> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", orderBy: "id ASC", limit: 1 }).catch(() => [] as RowDataPacket[]);
  return rows[0] ?? ({} as RowDataPacket);
}

// privacy_consents_from_post: checkbox name gdpr_consents[<key>].
function consentsFromForm(form: FormData): PrivacyConsents {
  const read = (key: string) => clean(form.get(`gdpr_consents[${key}]`)) !== "";
  return {
    data_processing: read("data_processing"),
    communications: read("communications"),
    marketing: read("marketing"),
    data_sharing: read("data_sharing"),
  };
}

async function updateClientConsents(slug: string, clientId: number, consents: PrivacyConsents): Promise<void> {
  await tenantUpdate({
    slug,
    table: "clients",
    id: clientId,
    values: {
      gdpr_consent_data_processing: consents.data_processing ? 1 : 0,
      gdpr_consent_communications: consents.communications ? 1 : 0,
      gdpr_consent_marketing: consents.marketing ? 1 : 0,
      gdpr_consent_data_sharing: consents.data_sharing ? 1 : 0,
    },
  });
}

// privacy_store_uploaded_signed_pdf su R2 privato + riga customer_documents.
async function storeUploadedSignedPdf(slug: string, clientId: number, file: unknown, title: string): Promise<number> {
  if (!(file instanceof File) || file.size <= 0) throw new Error("File non valido");
  if (file.size > 10 * 1024 * 1024) throw new Error("File troppo grande");
  const mime = clean(file.type).toLowerCase();
  if (mime !== "application/pdf") throw new Error("Il file deve essere un PDF");
  if (!storagePrivateConfigured()) throw new Error(STORAGE_NOT_CONFIGURED_ERROR);

  const docsTable = await tenantTable(slug, "customer_documents");
  const tenantId = Number(docsTable.tenantId ?? 0);
  const key = `t${tenantId}/clients/${clientId}/${randomBytes(10).toString("hex")}.pdf`;
  await putPrivateObject(key, new Uint8Array(await file.arrayBuffer()), "application/pdf");
  return tenantInsert(docsTable, { client_id: clientId, title, file_path: key, mime: "application/pdf", created_at: new Date() });
}

function pdfResponse(bytes: Buffer, filename: string, attachment = false): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${attachment ? "attachment" : "inline"}; filename="${filename}"`,
      "Cache-Control": "private, no-store, max-age=0, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function plainError(message: string, status = 400): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

// Stato completo della pagina (la parte render di client_consents.php).
async function pageState(slug: string, client: RowDataPacket) {
  const clientId = Number(client.id ?? 0);
  const gdprStatus = privacyStatusNormalize(client.gdpr_status, client);
  const gdprMeta = privacyStatusMeta(gdprStatus);
  const gdprToken = clean(client.gdpr_public_token);
  const gdprDocId = Number(client.gdpr_document_id ?? 0) || 0;
  const publicBase = `/${encodeURIComponent(slug)}`;

  const records = await consentRecordsForClient(slug, clientId);
  const availableModules = await consentModulesAvailableForClient(slug, clientId);

  const statusOrder: Record<string, number> = { draft: 0, pending: 1, signed: 2 };
  const sorted = [...records].sort((a, b) => {
    const cmp = (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99);
    if (cmp !== 0) return cmp;
    const updA = Date.parse(clean(a.updated_at)) || 0;
    const updB = Date.parse(clean(b.updated_at)) || 0;
    if (updA !== updB) return updB - updA;
    return a.module.name.localeCompare(b.module.name);
  });

  return {
    ok: true,
    client: {
      id: clientId,
      name: privacyClientDisplayName(client),
      phone: clean(client.phone),
      email: clean(client.email),
    },
    gdpr: {
      status: gdprStatus,
      statusLabel: gdprMeta.label,
      statusBadge: gdprMeta.badge,
      statusIcon: gdprMeta.icon,
      locked: gdprStatus !== "draft",
      labels: privacyConsentLabels(),
      consents: privacyConsentsFromClient(client),
      officialDocId: gdprDocId,
      requestedAtLabel: fmtDateTime(client.gdpr_signature_requested_at),
      signedAtLabel: fmtDateTime(client.gdpr_signed_at),
      pendingPreviewUrl: gdprStatus === "pending" && gdprToken ? `${publicBase}/gdpr_public?token=${encodeURIComponent(gdprToken)}` : "",
      publicUrl: gdprStatus === "signed" && gdprToken ? `${publicBase}/gdpr_public?token=${encodeURIComponent(gdprToken)}` : "",
      officialDocUrl:
        gdprStatus === "signed" && gdprDocId > 0 ? `/api/manage/client-document?slug=${encodeURIComponent(slug)}&id=${gdprDocId}` : "",
    },
    records: sorted.map((record) => {
      const token = clean(record.public_token);
      const publicUrl = token ? `${publicBase}/consent_public?token=${encodeURIComponent(token)}` : "";
      const meta = consentRecordStatusMeta(record.status);
      return {
        id: Number(record.id ?? 0),
        moduleId: record.module.id,
        name: record.module.name,
        typeLabel: consentModuleTypeLabel(record.module.type),
        moduleActive: record.module.isActive,
        status: record.status,
        statusLabel: meta.label,
        statusBadge: meta.badge,
        statusIcon: meta.icon,
        documentId: Number(record.document_id ?? 0) || 0,
        createdLabel: fmtDateTime(record.created_at),
        updatedLabel: fmtDateTime(record.updated_at),
        requestedLabel: fmtDateTime(record.signature_requested_at),
        signedLabel: fmtDateTime(record.signed_at),
        pendingUrl: record.status === "pending" ? publicUrl : "",
        officialUrl: record.status === "signed" ? publicUrl : "",
      };
    }),
    availableModules: availableModules.map((m) => ({ id: m.id, name: m.name })),
  };
}

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "client_consents.manage")) return jsonError("Permesso consensi cliente mancante.", 403);

  const url = new URL(request.url);
  const clientId = Number.parseInt(String(url.searchParams.get("client_id") ?? "0"), 10) || 0;
  const doAction = clean(url.searchParams.get("do"));

  try {
    const client = await loadClient(tenantSlug, clientId);
    if (!client) return jsonError("Cliente non trovato.", 404);

    // --- Export dati cliente (do=gdpr_export, audit GDPR 2026-07-21):
    // diritto di accesso/portabilità — JSON completo scaricabile. L'export è
    // una LETTURA di dati personali: viene registrata nel log attività.
    if (doAction === "gdpr_export") {
      const payload = await buildClientGdprExport(tenantSlug, clientId);
      void logActivity(tenantSlug, {
        user: session.user,
        locationId: session.user.currentLocationId,
        module: "clienti",
        action: "export_gdpr",
        entityType: "client",
        entityId: clientId,
        label: `Export dati GDPR cliente "${privacyClientDisplayName(client)}"`,
      });
      const fileName = privacyPdfSafeFilename(`export-dati-cliente-${clientId}`).replace(/\.pdf$/i, "") + ".json";
      return new Response(JSON.stringify(payload, null, 2), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="${fileName}"`,
          "cache-control": "no-store",
        },
      });
    }

    // --- Stampa PDF privacy (do=gdpr_print, solo bozza) ---
    if (doAction === "gdpr_print") {
      const status = privacyStatusNormalize(client.gdpr_status, client);
      if (status !== "draft") {
        return plainError("Non e possibile generare un nuovo PDF privacy quando il GDPR e bloccato.");
      }
      const biz = await loadBiz(tenantSlug);
      const snapshot = await privacySnapshotCreate(tenantSlug, client, biz);
      const bytes = await renderPrivacyPdf(snapshot, { signatureText: "Firma cliente: ______________________________" });
      return pdfResponse(bytes, privacyPdfSafeFilename(snapshot.filename));
    }

    // --- Stampa PDF modulo consenso (do=consent_print, solo bozza) ---
    if (doAction === "consent_print") {
      const recordId = Number.parseInt(String(url.searchParams.get("record_id") ?? "0"), 10) || 0;
      const record = await consentRecordFind(tenantSlug, recordId, clientId);
      if (!record) return plainError("Modulo consenso associato non trovato.", 404);
      if (record.status !== "draft") {
        return plainError("Non e possibile generare un nuovo PDF quando il modulo e bloccato.");
      }
      const biz = await loadBiz(tenantSlug);
      const snapshot = consentModuleSnapshotCreate(record.module, client, biz);
      const bytes = await renderPrivacyPdf(snapshot, {
        signatureText: "Firma cliente: ______________________________",
        footerMode: record.module.footerMode,
        footerTitle: record.module.footerTitle,
      });
      return pdfResponse(bytes, privacyPdfSafeFilename(snapshot.filename));
    }

    return Response.json(await pageState(tenantSlug, client));
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore consensi cliente.", 400);
  }
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "client_consents.manage")) return jsonError("Permesso consensi cliente mancante.", 403);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError("Invio non valido (atteso multipart/form-data).", 400);
  }

  const mode = clean(form.get("_mode"));
  const clientId = Number.parseInt(String(form.get("client_id") ?? "0"), 10) || 0;
  const origin = new URL(request.url).origin;
  const publicBase = `${origin}/${encodeURIComponent(tenantSlug)}`;

  try {
    const client = await loadClient(tenantSlug, clientId);
    if (!client) return jsonError("Cliente non trovato.", 404);
    const biz = await loadBiz(tenantSlug);

    // ------------------------------------------------------------------
    // Associa modulo (POST _mode=associate_module)
    // ------------------------------------------------------------------
    if (mode === "associate_module") {
      const moduleId = Number.parseInt(String(form.get("module_id") ?? "0"), 10) || 0;
      await consentRecordCreate(tenantSlug, clientId, moduleId);
      return Response.json({ ok: true, message: "Modulo consenso associato al cliente." });
    }

    // ------------------------------------------------------------------
    // Azioni record modulo consenso (POST _mode=consent_record_action)
    // ------------------------------------------------------------------
    if (mode === "consent_record_action") {
      const recordId = Number.parseInt(String(form.get("record_id") ?? "0"), 10) || 0;
      const action = clean(form.get("record_action"));
      const record = await consentRecordFind(tenantSlug, recordId, clientId);
      if (!record) return jsonError("Modulo consenso associato non trovato.", 404);

      const draftOnly = ["print", "send_signature", "manual_upload", "remove"];
      if (draftOnly.includes(action) && record.status !== "draft") {
        return jsonError("Il modulo e bloccato. Usa Reset per ricominciare la procedura.");
      }

      if (action === "remove") {
        if (Number(record.document_id ?? 0) > 0) {
          return jsonError("Questo modulo ha un documento ufficiale collegato e non puo essere rimosso dalla scheda cliente.");
        }
        // record già verificato appartenere al cliente (consentRecordFind).
        await tenantDelete({ slug: tenantSlug, table: "client_consent_records", id: recordId });
        return Response.json({ ok: true, message: "Modulo consenso rimosso dalla scheda cliente." });
      }

      if (["print", "send_signature", "manual_upload"].includes(action) && !record.module.isActive) {
        return jsonError("Questo modulo e disattivato nel backend e non puo essere completato. Riattivalo o rimuovilo dalla scheda cliente.");
      }

      if (action === "send_signature") {
        if (!clean(client.email)) return jsonError(PRIVACY_EMAIL_REQUIRED_MESSAGE);
        const snapshot = consentModuleSnapshotCreate(record.module, client, biz);
        const snapshotJson = JSON.stringify(snapshot);
        const token = makePublicToken();
        const requestedAt = nowSql();
        await consentRecordUpdatePending(tenantSlug, recordId, snapshotJson, token, requestedAt);
        const sent = await consentSendSignatureEmail(client, biz, record.module, `${publicBase}/consent_public?token=${encodeURIComponent(token)}`);
        if (!sent) {
          // Rollback legacy: il record torna in bozza pulita.
          await consentRecordReset(tenantSlug, recordId);
          return jsonError("Invio email non riuscito. Verifica la configurazione email e riprova.");
        }
        return Response.json({ ok: true, message: "Richiesta firma elettronica inviata con successo." });
      }

      if (action === "manual_upload") {
        const file = form.get("signed_pdf");
        if (!(file instanceof File) || file.size <= 0) {
          return jsonError("Seleziona il PDF firmato da caricare.");
        }
        const snapshot = consentModuleSnapshotCreate(record.module, client, biz);
        const docId = await storeUploadedSignedPdf(tenantSlug, clientId, file, `${record.module.name} firmato`);
        let token = clean(record.public_token);
        if (!token) token = makePublicToken();
        await consentRecordUpdateSigned(tenantSlug, recordId, docId, JSON.stringify(snapshot), token, nowSql());
        return Response.json({ ok: true, message: "PDF firmato caricato e associato al cliente." });
      }

      if (action === "send_pdf") {
        if (record.status !== "signed" || Number(record.document_id ?? 0) <= 0) {
          return jsonError("Il PDF firmato non e ancora disponibile.");
        }
        const docRows = await tenantSelect<RowDataPacket>({
          slug: tenantSlug,
          table: "customer_documents",
          columns: "id, file_path",
          where: "id = ? AND client_id = ?",
          params: [Number(record.document_id), clientId],
          limit: 1,
        });
        if (!docRows[0] || !/^t\d+\//.test(clean(docRows[0].file_path))) {
          return jsonError("Il PDF firmato non e disponibile su disco. Ricarica il documento o ripeti la firma.");
        }
        if (!clean(client.email)) return jsonError(PRIVACY_EMAIL_REQUIRED_MESSAGE);

        let token = clean(record.public_token);
        if (!token) {
          token = makePublicToken();
          await tenantUpdate({ slug: tenantSlug, table: "client_consent_records", id: recordId, values: { public_token: token, updated_at: new Date() } });
        }
        const sent = await consentSendOfficialPdfEmail(client, biz, record.module, `${publicBase}/consent_public?token=${encodeURIComponent(token)}`);
        if (!sent) return jsonError("Invio email non riuscito. Verifica la configurazione email e riprova.");
        return Response.json({ ok: true, message: "Documento firmato inviato al cliente." });
      }

      if (action === "reset") {
        await consentRecordReset(tenantSlug, recordId);
        return Response.json({ ok: true, message: "Reset modulo completato. Il PDF firmato precedente resta conservato nei documenti cliente." });
      }

      return jsonError("Azione modulo consenso non valida.");
    }

    // ------------------------------------------------------------------
    // Azioni GDPR (POST _mode=gdpr_action)
    // ------------------------------------------------------------------
    if (mode === "gdpr_action") {
      const action = clean(form.get("gdpr_action"));
      const status = privacyStatusNormalize(client.gdpr_status, client);
      const needsDraft = ["save_consents", "print", "send_signature", "manual_upload"].includes(action);

      if (needsDraft && status !== "draft") {
        return jsonError("I dati GDPR sono bloccati. Usa Reset GDPR per ricominciare la procedura.");
      }

      // In bozza ogni azione salva prima i consensi postati (come il form legacy).
      if (needsDraft) {
        const posted = consentsFromForm(form);
        await updateClientConsents(tenantSlug, clientId, posted);
        client.gdpr_consent_data_processing = posted.data_processing ? 1 : 0;
        client.gdpr_consent_communications = posted.communications ? 1 : 0;
        client.gdpr_consent_marketing = posted.marketing ? 1 : 0;
        client.gdpr_consent_data_sharing = posted.data_sharing ? 1 : 0;
      }

      if (action === "save_consents") {
        return Response.json({ ok: true, message: "Consensi GDPR aggiornati." });
      }

      if (action === "send_signature") {
        if (!clean(client.email)) return jsonError(PRIVACY_EMAIL_REQUIRED_MESSAGE);
        const snapshot = await privacySnapshotCreate(tenantSlug, client, biz);
        const token = makePublicToken();
        const requestedAt = nowSql();
        await tenantUpdate({
          slug: tenantSlug,
          table: "clients",
          id: clientId,
          values: {
            gdpr_status: "pending",
            gdpr_snapshot_json: JSON.stringify(snapshot),
            gdpr_public_token: token,
            gdpr_signature_requested_at: requestedAt,
            gdpr_locked_at: requestedAt,
          },
        });
        const sent = await privacySendSignatureEmail(client, biz, `${publicBase}/gdpr_public?token=${encodeURIComponent(token)}`);
        if (!sent) {
          // Rollback legacy su invio fallito.
          await tenantUpdate({
            slug: tenantSlug,
            table: "clients",
            id: clientId,
            values: {
              gdpr_status: "draft",
              gdpr_snapshot_json: null,
              gdpr_public_token: null,
              gdpr_signature_requested_at: null,
              gdpr_locked_at: null,
            },
          });
          return jsonError("Invio email non riuscito. Verifica la configurazione email e riprova.");
        }
        return Response.json({ ok: true, message: "Richiesta firma elettronica inviata con successo." });
      }

      if (action === "manual_upload") {
        const file = form.get("gdpr_signed_pdf");
        if (!(file instanceof File) || file.size <= 0) {
          return jsonError("Seleziona il PDF firmato da caricare.");
        }
        const snapshot = await privacySnapshotCreate(tenantSlug, client, biz);
        const docId = await storeUploadedSignedPdf(tenantSlug, clientId, file, "Privacy firmata");
        let token = clean(client.gdpr_public_token);
        if (!token) token = makePublicToken();
        const signedAt = nowSql();
        await tenantUpdate({
          slug: tenantSlug,
          table: "clients",
          id: clientId,
          values: {
            gdpr_document_id: docId,
            gdpr_status: "signed",
            gdpr_snapshot_json: JSON.stringify(snapshot),
            gdpr_public_token: token,
            gdpr_signed_at: signedAt,
            gdpr_locked_at: signedAt,
          },
        });
        return Response.json({ ok: true, message: "PDF privacy firmato caricato e associato al cliente." });
      }

      if (action === "send_privacy") {
        if (status !== "signed" || Number(client.gdpr_document_id ?? 0) <= 0) {
          return jsonError("Il PDF privacy firmato non e ancora disponibile.");
        }
        const docRows = await tenantSelect<RowDataPacket>({
          slug: tenantSlug,
          table: "customer_documents",
          columns: "id, file_path",
          where: "id = ? AND client_id = ?",
          params: [Number(client.gdpr_document_id), clientId],
          limit: 1,
        });
        if (!docRows[0] || !/^t\d+\//.test(clean(docRows[0].file_path))) {
          return jsonError("Il PDF privacy firmato non e disponibile su disco. Ricarica il documento o ripeti la firma.");
        }
        if (!clean(client.email)) return jsonError(PRIVACY_EMAIL_REQUIRED_MESSAGE);

        let token = clean(client.gdpr_public_token);
        if (!token) {
          token = makePublicToken();
          await tenantUpdate({ slug: tenantSlug, table: "clients", id: clientId, values: { gdpr_public_token: token } });
        }
        const sent = await privacySendOfficialPdfEmail(client, biz, `${publicBase}/gdpr_public?token=${encodeURIComponent(token)}`);
        if (!sent) return jsonError("Invio email non riuscito. Verifica la configurazione email e riprova.");
        return Response.json({ ok: true, message: "Documento privacy inviato al cliente." });
      }

      if (action === "reset") {
        // privacy_reset_client_state: azzera tutto, il documento resta nei
        // documenti cliente.
        await tenantUpdate({
          slug: tenantSlug,
          table: "clients",
          id: clientId,
          values: {
            gdpr_status: "draft",
            gdpr_document_id: null,
            gdpr_snapshot_json: null,
            gdpr_public_token: null,
            gdpr_signature_requested_at: null,
            gdpr_signed_at: null,
            gdpr_locked_at: null,
          },
        });
        return Response.json({ ok: true, message: "Reset GDPR completato. Il PDF firmato precedente resta conservato nei documenti cliente." });
      }

      return jsonError("Azione GDPR non valida.");
    }

    return jsonError("Richiesta non valida.", 400);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore consensi cliente.", 400);
  }
}
