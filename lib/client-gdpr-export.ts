import "server-only";

import type { RowDataPacket } from "@/lib/tenant-db";
import { tenantSelect } from "@/lib/tenant-db";
import { businessNowDateTime } from "@/lib/business-datetime";

// Export dati cliente (audit GDPR 2026-07-21): diritto di accesso/portabilità
// (artt. 15 e 20). Raccoglie in un unico JSON leggibile tutti i dati personali
// del cliente trattati dal tenant: anagrafica, consensi, appuntamenti, acquisti,
// pacchetti/prepagati, giftcard, fidelity, documenti (metadati) e schede.
// Esclusioni deliberate: note INTERNE dello staff (blocked_internal_note) e id
// tecnici di terze tabelle — l'export riguarda i dati dell'interessato, non gli
// appunti organizzativi del titolare.

const pick = (row: RowDataPacket | undefined | null, keys: string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (!row) return out;
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") out[key] = row[key];
  }
  return out;
};

async function safeSelect(args: Parameters<typeof tenantSelect>[0]): Promise<RowDataPacket[]> {
  // Tabelle opzionali (schema per-tenant storicizzato): un modulo mai usato può
  // non avere la tabella — l'export non deve fallire per questo.
  return tenantSelect<RowDataPacket>(args).catch(() => [] as RowDataPacket[]);
}

export async function buildClientGdprExport(slug: string, clientId: number): Promise<Record<string, unknown>> {
  const clientRows = await tenantSelect<RowDataPacket>({ slug, table: "clients", where: "id = ?", params: [clientId], limit: 1 });
  const client = clientRows[0];
  if (!client) throw new Error("Cliente non trovato.");

  const [
    appointments,
    sales,
    quotes,
    giftcards,
    packages,
    prepaids,
    cards,
    pointTransactions,
    creditAdjustments,
    consentRecords,
    documents,
    sheetRecords,
  ] = await Promise.all([
    safeSelect({ slug, table: "appointments", columns: "id,public_code,starts_at,ends_at,status,customer_notes,notes,location_id,created_at", where: "client_id = ?", params: [clientId], orderBy: "starts_at DESC" }),
    safeSelect({ slug, table: "sales", columns: "id,sale_date,subtotal,discount,total,status,notes,location_id,created_at", where: "client_id = ?", params: [clientId], orderBy: "sale_date DESC" }),
    safeSelect({ slug, table: "quotes", columns: "id,number,quote_date,total,status,created_at", where: "client_id = ?", params: [clientId], orderBy: "created_at DESC" }),
    safeSelect({ slug, table: "giftcards", columns: "id,code,initial_amount,balance,status,issued_at,expires_at", where: "client_id = ?", params: [clientId], orderBy: "issued_at DESC" }),
    safeSelect({ slug, table: "client_packages", columns: "id,package_name,sessions_total,sessions_remaining,status,purchase_date,expires_at", where: "client_id = ?", params: [clientId], orderBy: "id DESC" }),
    safeSelect({ slug, table: "client_prepaid_services", columns: "id,service_name,purchased_qty,remaining_qty,status,purchase_date,expires_at", where: "client_id = ?", params: [clientId], orderBy: "id DESC" }),
    safeSelect({ slug, table: "cards", columns: "id,code,credit,status,issued_at,expires_at", where: "client_id = ?", params: [clientId], orderBy: "id DESC" }),
    safeSelect({ slug, table: "transactions", columns: "id,kind,delta_points,amount,note,created_at", where: "client_id = ?", params: [clientId], orderBy: "created_at DESC", limit: 500 }),
    safeSelect({ slug, table: "credit_adjustments", columns: "id,direction,amount,delta_amount,note,created_at", where: "client_id = ?", params: [clientId], orderBy: "created_at DESC", limit: 500 }),
    safeSelect({ slug, table: "client_consent_records", columns: "id,module_id,status,created_at,signed_at,locked_at", where: "client_id = ?", params: [clientId], orderBy: "id DESC" }),
    safeSelect({ slug, table: "customer_documents", columns: "id,title,mime,created_at", where: "client_id = ?", params: [clientId], orderBy: "id DESC" }),
    safeSelect({ slug, table: "client_sheet_records", columns: "id,title,session_date,values_json,notes,created_at,updated_at", where: "client_id = ?", params: [clientId], orderBy: "id DESC" }),
  ]);

  return {
    export_type: "gdpr_data_export",
    generated_at: businessNowDateTime(),
    client: pick(client, [
      "id",
      "full_name",
      "first_name",
      "last_name",
      "company_name",
      "vat_number",
      "tax_code",
      "sdi",
      "pec",
      "email",
      "phone",
      "phone_home",
      "phone2",
      "gender",
      "birth_date",
      "birth_place",
      "registration_date",
      "region",
      "province",
      "city",
      "address",
      "cap",
      "job_title",
      "notes",
      "points",
      "credit_balance",
      "fidelity_level",
      "location_id",
      "created_at",
    ]),
    consents: {
      data_processing: Number(client.gdpr_consent_data_processing ?? 0) === 1,
      communications: Number(client.gdpr_consent_communications ?? 0) === 1,
      marketing: Number(client.gdpr_consent_marketing ?? 0) === 1,
      data_sharing: Number(client.gdpr_consent_data_sharing ?? 0) === 1,
      gdpr_status: String(client.gdpr_status ?? "draft"),
      signed_at: client.gdpr_signed_at ?? null,
      consent_records: consentRecords,
    },
    appointments,
    sales,
    quotes,
    giftcards,
    packages,
    prepaid_services: prepaids,
    fidelity: {
      cards,
      point_transactions: pointTransactions,
      credit_adjustments: creditAdjustments,
    },
    documents,
    client_sheets: sheetRecords.map((row) => ({
      ...row,
      values_json: ((): unknown => {
        try {
          return JSON.parse(String(row.values_json ?? "null"));
        } catch {
          return row.values_json ?? null;
        }
      })(),
    })),
  };
}
