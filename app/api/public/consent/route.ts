import { randomBytes } from "node:crypto";
import {
  consentModuleSnapshotCreate,
  consentRecordByToken,
  consentRecordStatusMeta,
  consentRecordUpdateSigned,
  type ConsentRecordRow,
} from "@/lib/consent-records";
import {
  privacyClientDisplayName,
  privacyPdfSafeFilename,
  privacySnapshotDecode,
  type PrivacySnapshot,
} from "@/lib/privacy-consent";
import { privacyDecodeSignature, renderPrivacyPdf } from "@/lib/privacy-pdf";
import { STORAGE_NOT_CONFIGURED_ERROR, presignedPrivateGetUrl, putPrivateObject, storagePrivateConfigured } from "@/lib/storage";
import type { RowDataPacket } from "@/lib/tenant-db";
import { tenantInsert, tenantSelect, tenantTable } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// MODULO CONSENSO PUBBLICO — port of app/pages/consent_public.php (accesso via
// public_token 64 hex su client_consent_records, nessuna autenticazione):
//  - GET ?slug&token                  -> dati pagina (nome modulo, cliente,
//    stato/badge, date) — solo pending/signed sono pubblici.
//  - GET ?...&format=pdf[&download=1] -> pending: PDF dallo snapshot con la riga
//    "Firma cliente: ____" e il footer del modulo (signature_only o
//    gdpr_consents); signed: il documento UFFICIALE (customer_documents via
//    document_id, byte da R2 privato).
//  - POST { slug, token, signature_data } -> conferma firma: genera il PDF con
//    caption "Firmato elettronicamente il ...", salva '<modulo> firmato' e
//    aggiorna il record (consent_module_record_update_signed). Messaggi legacy.

const clean = (v: unknown) => String(v ?? "").trim();

function fmtDateTime(value: unknown): string {
  const m = clean(value).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : "";
}

async function loadClientRow(slug: string, clientId: number): Promise<RowDataPacket | null> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "clients", where: "id = ?", params: [clientId], limit: 1 }).catch(() => []);
  return rows[0] ?? null;
}

async function loadBiz(slug: string): Promise<RowDataPacket> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", orderBy: "id ASC", limit: 1 }).catch(() => [] as RowDataPacket[]);
  return rows[0] ?? ({} as RowDataPacket);
}

async function snapshotFor(slug: string, record: ConsentRecordRow, client: RowDataPacket): Promise<PrivacySnapshot> {
  const existing = privacySnapshotDecode(record.snapshot_json);
  if (existing && Object.keys(existing).length) {
    existing.filename = privacyPdfSafeFilename(existing.filename || "");
    return existing;
  }
  return consentModuleSnapshotCreate(record.module, client, await loadBiz(slug));
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = clean(url.searchParams.get("slug")).toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const token = clean(url.searchParams.get("token"));
  if (!slug) return Response.json({ ok: false, error: "Attivita non specificata." }, { status: 400 });

  try {
    const record = await consentRecordByToken(slug, token);
    if (!record || (record.status !== "pending" && record.status !== "signed")) {
      return Response.json({ ok: false, error: "Link non valido o documento non disponibile." }, { status: 404 });
    }
    const client = await loadClientRow(slug, Number(record.client_id ?? 0));
    if (!client) return Response.json({ ok: false, error: "Link non valido o documento non disponibile." }, { status: 404 });

    const snapshot = await snapshotFor(slug, record, client);
    const filename = privacyPdfSafeFilename(snapshot.filename || "");

    // --- PDF (inline per l'iframe / attachment con download=1) ---
    if (url.searchParams.get("format") === "pdf") {
      const attachment = url.searchParams.get("download") === "1";
      let bytes: Buffer;
      if (record.status === "signed" && Number(record.document_id ?? 0) > 0) {
        const docRows = await tenantSelect<RowDataPacket>({
          slug,
          table: "customer_documents",
          columns: "id, file_path",
          where: "id = ? AND client_id = ?",
          params: [Number(record.document_id), Number(record.client_id)],
          limit: 1,
        });
        const path = clean(docRows[0]?.file_path);
        if (!/^t\d+\//.test(path)) return new Response("Documento firmato non disponibile", { status: 404 });
        const signed = await presignedPrivateGetUrl(path, 120);
        const upstream = await fetch(signed);
        if (!upstream.ok) return new Response("Documento firmato non disponibile", { status: 404 });
        bytes = Buffer.from(await upstream.arrayBuffer());
      } else if (record.status === "signed") {
        return new Response("Documento firmato non disponibile", { status: 404 });
      } else {
        bytes = await renderPrivacyPdf(snapshot, {
          signatureText: "Firma cliente: ______________________________",
          footerMode: record.module.footerMode,
          footerTitle: record.module.footerTitle,
        });
      }
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

    // --- Dati pagina ---
    const meta = consentRecordStatusMeta(record.status);
    return Response.json({
      ok: true,
      status: record.status,
      statusLabel: meta.label,
      statusBadge: meta.badge,
      statusIcon: meta.icon,
      moduleName: record.module.name,
      clientName: privacyClientDisplayName(client),
      filename,
      requestedAt: fmtDateTime(record.signature_requested_at),
      signedAt: fmtDateTime(record.signed_at),
    });
  } catch (error) {
    // Mai esporre errori tecnici interni (driver pg, rete) al pubblico: solo i
    // messaggi verbatim di dominio passano; il tecnico va nei log server.
    const message = error instanceof Error ? error.message : "";
    const isTechnical = !message || /relation|column|syntax|SQLSTATE|ECONN|ETIMEDOUT|ENOTFOUND|timeout|SSL|pool|connect/i.test(message);
    if (isTechnical) console.error("[public/consent GET]", message || error);
    return Response.json({ ok: false, error: isTechnical ? "Documento non disponibile." : message }, { status: 400 });
  }
}

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "Invio non valido." }, { status: 400 });
  }
  const slug = clean(body.slug).toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const token = clean(body.token);

  try {
    const record = await consentRecordByToken(slug, token);
    if (!record || (record.status !== "pending" && record.status !== "signed")) {
      return Response.json({ ok: false, error: "Link non valido o documento non disponibile." }, { status: 404 });
    }
    if (record.status !== "pending") {
      // Legacy (consent_public.php 100): redirect con ?msg= — flash VERDE
      // informativo, non un errore. Il client ricarica e mostra lo stato firmato.
      return Response.json({ ok: true, alreadyConfirmed: true, message: "Il documento risulta gia confermato." });
    }
    const client = await loadClientRow(slug, Number(record.client_id ?? 0));
    if (!client) return Response.json({ ok: false, error: "Link non valido o documento non disponibile." }, { status: 404 });

    const signatureDataUrl = clean(body.signature_data);
    if (!signatureDataUrl) {
      return Response.json({ ok: false, error: "Inserisci la firma nel riquadro prima di confermare." });
    }
    privacyDecodeSignature(signatureDataUrl); // validazione (stringhe errore legacy)
    if (!storagePrivateConfigured()) return Response.json({ ok: false, error: STORAGE_NOT_CONFIGURED_ERROR }, { status: 503 });

    const snapshot = await snapshotFor(slug, record, client);
    const filename = privacyPdfSafeFilename(snapshot.filename || "");
    snapshot.filename = filename;

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const signedAtSql = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const signedLabel = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const signedDate = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;

    const pdfBytes = await renderPrivacyPdf(snapshot, {
      dateDisplay: signedDate,
      signatureDataUrl,
      signatureCaption: `Firmato elettronicamente il ${signedLabel}`,
      footerMode: record.module.footerMode,
      footerTitle: record.module.footerTitle,
    });

    // privacy_store_pdf_document su R2 privato + riga '<modulo> firmato'.
    const clientId = Number(record.client_id ?? 0);
    const docsTable = await tenantTable(slug, "customer_documents");
    const tenantId = Number(docsTable.tenantId ?? 0);
    const key = `t${tenantId}/clients/${clientId}/${randomBytes(10).toString("hex")}.pdf`;
    await putPrivateObject(key, new Uint8Array(pdfBytes), "application/pdf");
    const docId = await tenantInsert(docsTable, {
      client_id: clientId,
      title: `${record.module.name} firmato`,
      file_path: key,
      mime: "application/pdf",
      created_at: now,
    });

    await consentRecordUpdateSigned(slug, Number(record.id), docId, JSON.stringify(snapshot), token, signedAtSql);

    return Response.json({ ok: true, message: "Documento firmato e confermato con successo." });
  } catch (error) {
    const fallback = "Si e verificato un problema tecnico durante il salvataggio del documento. Riprova tra poco.";
    const message = error instanceof Error ? error.message : "";
    // publicErrorMessage: mai esporre errori tecnici interni.
    const isTechnical = /lastInsertId|Call to undefined|Fatal error|Parse error|PDOException|SQLSTATE|stack trace/i.test(message);
    return Response.json({ ok: false, error: !message || isTechnical ? fallback : message });
  }
}
