import { randomBytes } from "node:crypto";
import {
  privacyClientDisplayName,
  privacyPdfSafeFilename,
  privacySnapshotCreate,
  privacySnapshotDecode,
  privacyStatusMeta,
  privacyStatusNormalize,
  type PrivacySnapshot,
} from "@/lib/privacy-consent";
import { privacyDecodeSignature, renderPrivacyPdf } from "@/lib/privacy-pdf";
import { STORAGE_NOT_CONFIGURED_ERROR, presignedPrivateGetUrl, putPrivateObject, storagePrivateConfigured } from "@/lib/storage";
import type { RowDataPacket } from "@/lib/tenant-db";
import { tenantInsert, tenantSelect, tenantTable, tenantUpdate } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// DOCUMENTO PRIVACY PUBBLICO — port of app/pages/gdpr_public.php (accesso via
// token 64 hex su clients.gdpr_public_token, nessuna autenticazione):
//  - GET ?slug&token                     -> dati per la pagina (stato/badge, nome
//    cliente, filename, richiesta/firma) — solo pending/signed sono pubblici.
//  - GET ?...&format=pdf[&download=1]    -> pending: PDF generato dallo snapshot
//    con la riga "Firma cliente: ____"; signed: il documento UFFICIALE salvato
//    (customer_documents via gdpr_document_id, byte proxyati da R2 privato con
//    gli header inline/attachment del legacy).
//  - POST { slug, token, gdpr_signature_data } -> conferma firma: valida la
//    firma (data URL png/jpeg), genera il PDF firmato con la caption
//    "Firmato elettronicamente il ...", lo salva ('Privacy firmata') e aggiorna
//    clients (gdpr_document_id/status/signed_at/locked_at/snapshot_json).
//    Stringhe messaggio legacy esatte.

const clean = (v: unknown) => String(v ?? "").trim();

function fmtDateTime(value: unknown): string {
  const m = clean(value).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : "";
}

async function loadClientByToken(slug: string, token: string): Promise<RowDataPacket | null> {
  if (!/^[A-Fa-f0-9]{64}$/.test(token)) return null;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "clients", where: "gdpr_public_token = ?", params: [token], limit: 1 });
  return rows[0] ?? null;
}

async function snapshotFor(slug: string, client: RowDataPacket): Promise<PrivacySnapshot> {
  const existing = privacySnapshotDecode(client.gdpr_snapshot_json);
  if (existing && Object.keys(existing).length) {
    existing.filename = privacyPdfSafeFilename(existing.filename || "");
    return existing;
  }
  const bizRows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", orderBy: "id ASC", limit: 1 }).catch(() => [] as RowDataPacket[]);
  return privacySnapshotCreate(slug, client, bizRows[0] ?? ({} as RowDataPacket));
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = clean(url.searchParams.get("slug")).toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const token = clean(url.searchParams.get("token"));
  if (!slug) return Response.json({ ok: false, error: "Attivita non specificata." }, { status: 400 });

  try {
    const client = await loadClientByToken(slug, token);
    if (!client) return Response.json({ ok: false, error: "Link non valido o documento non disponibile." }, { status: 404 });
    const status = privacyStatusNormalize(client.gdpr_status, client);
    if (status !== "pending" && status !== "signed") {
      return Response.json({ ok: false, error: "Link non valido o documento non disponibile." }, { status: 404 });
    }

    const snapshot = await snapshotFor(slug, client);
    const filename = privacyPdfSafeFilename(snapshot.filename || "");

    // --- PDF (inline per l'iframe / attachment col download=1) ---
    if (url.searchParams.get("format") === "pdf") {
      const attachment = url.searchParams.get("download") === "1";
      let bytes: Buffer;
      if (status === "signed" && Number(client.gdpr_document_id ?? 0) > 0) {
        const docRows = await tenantSelect<RowDataPacket>({
          slug,
          table: "customer_documents",
          columns: "id, file_path",
          where: "id = ? AND client_id = ?",
          params: [Number(client.gdpr_document_id), Number(client.id)],
          limit: 1,
        });
        const path = clean(docRows[0]?.file_path);
        if (!/^t\d+\//.test(path)) return new Response("Documento firmato non disponibile", { status: 404 });
        const signed = await presignedPrivateGetUrl(path, 120);
        const upstream = await fetch(signed);
        if (!upstream.ok) return new Response("Documento firmato non disponibile", { status: 404 });
        bytes = Buffer.from(await upstream.arrayBuffer());
      } else if (status === "signed") {
        return new Response("Documento firmato non disponibile", { status: 404 });
      } else {
        bytes = await renderPrivacyPdf(snapshot, { signatureText: "Firma cliente: ______________________________" });
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
    const meta = privacyStatusMeta(status);
    return Response.json({
      ok: true,
      status,
      statusLabel: meta.label,
      statusBadge: meta.badge,
      statusIcon: meta.icon,
      clientName: privacyClientDisplayName(client),
      filename,
      requestedAt: fmtDateTime(client.gdpr_signature_requested_at),
      signedAt: fmtDateTime(client.gdpr_signed_at),
    });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Documento non disponibile." }, { status: 400 });
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
    const client = await loadClientByToken(slug, token);
    if (!client) return Response.json({ ok: false, error: "Link non valido o documento non disponibile." }, { status: 404 });
    const status = privacyStatusNormalize(client.gdpr_status, client);
    if (status !== "pending") {
      return Response.json({ ok: false, error: "Il documento privacy risulta gia confermato." });
    }

    const signatureDataUrl = clean(body.gdpr_signature_data);
    if (!signatureDataUrl) {
      return Response.json({ ok: false, error: "Inserisci la firma nel riquadro prima di confermare." });
    }
    privacyDecodeSignature(signatureDataUrl); // validazione (stringhe errore legacy)
    if (!storagePrivateConfigured()) return Response.json({ ok: false, error: STORAGE_NOT_CONFIGURED_ERROR }, { status: 503 });

    const snapshot = await snapshotFor(slug, client);
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
    });

    // privacy_store_pdf_document su R2 privato: key random, riga customer_documents
    // 'Privacy firmata' con mime application/pdf.
    const clientId = Number(client.id ?? 0);
    const docsTable = await tenantTable(slug, "customer_documents");
    const tenantId = Number(docsTable.tenantId ?? 0);
    const key = `t${tenantId}/clients/${clientId}/${randomBytes(10).toString("hex")}.pdf`;
    await putPrivateObject(key, new Uint8Array(pdfBytes), "application/pdf");
    const docId = await tenantInsert(docsTable, {
      client_id: clientId,
      title: "Privacy firmata",
      file_path: key,
      mime: "application/pdf",
      created_at: now,
    });

    await tenantUpdate({
      slug,
      table: "clients",
      id: clientId,
      values: {
        gdpr_document_id: docId,
        gdpr_status: "signed",
        gdpr_signed_at: signedAtSql,
        gdpr_locked_at: signedAtSql,
        gdpr_snapshot_json: JSON.stringify(snapshot),
      },
    });

    return Response.json({ ok: true, message: "Documento privacy firmato e confermato con successo." });
  } catch (error) {
    const fallback = "Si e verificato un problema tecnico durante il salvataggio del documento. Riprova tra poco.";
    const message = error instanceof Error ? error.message : "";
    // publicErrorMessage: mai esporre errori tecnici interni.
    const isTechnical = /lastInsertId|Call to undefined|Fatal error|Parse error|PDOException|SQLSTATE|stack trace/i.test(message);
    return Response.json({ ok: false, error: !message || isTechnical ? fallback : message });
  }
}
