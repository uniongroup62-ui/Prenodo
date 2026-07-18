import "server-only";

import type { RowDataPacket } from "@/lib/tenant-db";
import { dbQuery } from "@/lib/tenant-db";
import { storagePublicUrl } from "@/lib/storage";

// SEO server-side del dettaglio marketplace (miglioria 2026-07-18): titolo,
// description e JSON-LD LocalBusiness generati dal profilo REALE dell'attività
// così i motori vedono i dati nel primo HTML (il corpo della scheda resta
// client-side). Solo tenant pubblicabili nel marketplace, stessi gate della
// directory /api/marketplace.

export type MarketplaceSeoProfile = {
  slug: string;
  name: string;
  city: string;
  province: string;
  address: string;
  phone: string;
  imageUrl: string;
  locations: Array<{ id: number; name: string; city: string; province: string; address: string }>;
};

export async function marketplaceSeoProfile(slugInput: string): Promise<MarketplaceSeoProfile | null> {
  const slug = String(slugInput ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,80}$/.test(slug)) return null;
  const rows = await dbQuery<RowDataPacket[]>(`
    SELECT
      t.id AS tenant_id,
      t.slug,
      COALESCE(NULLIF(MAX(b.name), ''), t.name) AS business_name,
      COALESCE(NULLIF(MAX(b.site_city), ''), NULLIF(MAX(b.quote_city), ''), '') AS city,
      COALESCE(NULLIF(MAX(b.site_province), ''), NULLIF(MAX(b.quote_province), ''), '') AS province,
      COALESCE(NULLIF(MAX(b.site_address), ''), NULLIF(MAX(b.address), ''), '') AS address,
      COALESCE(NULLIF(MAX(b.phone), ''), '') AS phone,
      COALESCE(NULLIF(MAX(b.cover_path), ''), '') AS cover_path
    FROM saas_tenants t
    LEFT JOIN businesses b ON b.tenant_id = t.id
    WHERE t.slug = ?
      AND COALESCE(t.is_active, 1) = 1
      AND t.deleted_at IS NULL
      AND t.status = 'active'
      AND COALESCE(t.marketplace_public_allowed, 1) = 1
    GROUP BY t.id, t.slug, t.name
    LIMIT 1
  `, [slug]).catch(() => [] as RowDataPacket[]);
  const row = rows[0];
  if (!row) return null;
  const tenantId = Number(row.tenant_id ?? 0);
  const locations = tenantId > 0
    ? await dbQuery<RowDataPacket[]>(`
        SELECT id, name, address, legal_city, legal_province
        FROM locations
        WHERE tenant_id = ? AND COALESCE(is_active, 1) = 1 AND COALESCE(marketplace_enabled, 1) = 1
        ORDER BY sort_order ASC, name ASC
        LIMIT 6
      `, [tenantId]).catch(() => [] as RowDataPacket[])
    : [];
  const coverPath = String(row.cover_path ?? "").trim();
  return {
    slug,
    name: String(row.business_name ?? slug),
    city: String(row.city ?? "").trim(),
    province: String(row.province ?? "").trim(),
    address: String(row.address ?? "").trim(),
    phone: String(row.phone ?? "").trim(),
    imageUrl: coverPath ? storagePublicUrl(coverPath) : "",
    locations: locations.map((loc) => ({
      id: Number(loc.id ?? 0),
      name: String(loc.name ?? "").trim(),
      city: String(loc.legal_city ?? "").trim(),
      province: String(loc.legal_province ?? "").trim(),
      address: String(loc.address ?? "").trim(),
    })),
  };
}

// JSON-LD schema.org/LocalBusiness (BeautySalon) per la scheda attività o la
// scheda SEDE (location valorizzata = indirizzo della sede).
export function marketplaceJsonLd(
  profile: MarketplaceSeoProfile,
  baseUrl: string,
  location?: { name: string; city: string; province: string; address: string },
): Record<string, unknown> {
  // Scheda attività senza città/indirizzo a livello business: fallback sulla
  // PRIMA sede marketplace (dati reali comunque pubblici sulla pagina).
  const fallback = !location && !profile.city && !profile.address ? profile.locations[0] : undefined;
  const src = location ?? fallback;
  const city = src?.city || profile.city;
  const address = src?.address || profile.address;
  const province = src?.province || profile.province;
  return {
    "@context": "https://schema.org",
    "@type": "BeautySalon",
    name: location?.name ? `${profile.name} — ${location.name}` : profile.name,
    url: `${baseUrl}/attivita/${encodeURIComponent(profile.slug)}`,
    ...(profile.imageUrl ? { image: profile.imageUrl } : {}),
    ...(profile.phone ? { telephone: profile.phone } : {}),
    ...(address || city
      ? {
          address: {
            "@type": "PostalAddress",
            ...(address ? { streetAddress: address } : {}),
            ...(city ? { addressLocality: city } : {}),
            ...(province ? { addressRegion: province } : {}),
            addressCountry: "IT",
          },
        }
      : {}),
  };
}
