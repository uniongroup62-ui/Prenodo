import type { RowDataPacket } from "@/lib/tenant-db";
import { dbQuery } from "@/lib/tenant-db";

type MarketplaceProfile = {
  slug: string;
  name: string;
  category: string;
  area: string;
  rating: string;
  reviews: number;
  nextSlot: string;
  priceFrom: string;
  image: string;
  services: string[];
  locations: Array<{
    id: number;
    name: string;
    city: string;
    area: string;
    address: string;
    // Categorie attività marketplace della sede (legacy category_text della
    // tenant_directory_locations, es. 'Unghie'): la card lista le mostra al
    // posto delle categorie servizi.
    activityCategories: string[];
    categoryText: string;
  }>;
};

// Neutral marketplace-card defaults used when the DB row has no value for a
// purely-visual field (rating / reviews / hero image / next slot). These are
// generic, tenant-agnostic placeholders — never another tenant's demo data.
const DEFAULT_RATING = "5.0";
const DEFAULT_REVIEWS = 0;
const DEFAULT_NEXT_SLOT = "Disponibilita su richiesta";
const DEFAULT_PRICE_FROM = "Da definire";
const DEFAULT_IMAGE =
  "https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=900&q=80";
const DEFAULT_CATEGORY = "Centro benessere";
const DEFAULT_SERVICES = ["Viso", "Corpo", "Benessere"];

export async function GET() {
  try {
    const value = await marketplaceProfiles();
    return Response.json({ ok: true, sourceMode: "database", ...value });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Marketplace non disponibile." },
      { status: 503 },
    );
  }
}

async function marketplaceProfiles(): Promise<{ profiles: MarketplaceProfile[]; categories: string[] }> {
  const rows = await dbQuery<RowDataPacket[]>(`
    SELECT
      t.id AS tenant_id,
      t.slug,
      COALESCE(NULLIF(MAX(b.name), ''), t.name) AS business_name,
      COALESCE(NULLIF(MAX(b.site_city), ''), NULLIF(MAX(b.quote_city), ''), NULLIF(MIN(l.legal_city), ''), '') AS city,
      COALESCE(NULLIF(MAX(b.site_province), ''), NULLIF(MAX(b.quote_province), ''), '') AS area,
      MIN(l.id) AS first_location_id,
      COALESCE(NULLIF(MIN(l.name), ''), 'Sede principale') AS first_location_name,
      COALESCE(NULLIF(MIN(l.address), ''), NULLIF(MAX(b.site_address), ''), NULLIF(MAX(b.address), ''), '') AS first_address,
      MIN(s.price) AS price_from,
      string_agg(DISTINCT COALESCE(NULLIF(sc.name, ''), NULLIF(s.name, ''))::text, '||' ORDER BY COALESCE(NULLIF(sc.name, ''), NULLIF(s.name, ''))::text ASC) AS service_labels,
      COUNT(DISTINCT l.id) AS location_count,
      COUNT(DISTINCT s.id) AS service_count
    FROM saas_tenants t
    LEFT JOIN businesses b ON b.tenant_id = t.id
    LEFT JOIN locations l ON l.tenant_id = t.id AND COALESCE(l.is_active, 1) = 1 AND COALESCE(l.marketplace_enabled, 1) = 1
    LEFT JOIN services s ON s.tenant_id = t.id AND COALESCE(s.is_active, 1) = 1 AND COALESCE(s.booking_enabled, 1) = 1
    LEFT JOIN service_categories sc ON sc.tenant_id = t.id AND sc.id = s.category_id
    WHERE COALESCE(t.is_active, 1) = 1
      AND t.deleted_at IS NULL
      AND t.status = 'active'
      AND COALESCE(t.marketplace_public_allowed, 1) = 1
    GROUP BY t.id, t.slug, t.name
    HAVING COUNT(DISTINCT l.id) > 0 OR COUNT(DISTINCT s.id) > 0
    ORDER BY business_name ASC, t.id ASC
  `);

  const categories = await marketplaceDbCategories(rows);
  const locationCategories = await marketplaceLocationCategories();
  const profiles = await Promise.all(rows.map((row) => profileFromRow(row, locationCategories)));
  return { profiles, categories };
}

// Categorie attività per SEDE (marketplace_location_activity_categories):
// alimentano la meta della card lista e il 'Categorie:' delle result-card,
// come il category_text legacy della tenant_directory_locations.
async function marketplaceLocationCategories(): Promise<Map<number, string[]>> {
  const rows = await dbQuery<RowDataPacket[]>(`
    SELECT lac.location_id, mac.name
    FROM marketplace_location_activity_categories lac
    JOIN marketplace_activity_categories mac ON mac.id = lac.marketplace_category_id
    WHERE COALESCE(mac.is_active, 1) = 1
    ORDER BY lac.is_primary DESC, lac.sort_order ASC, mac.name ASC
  `).catch(() => [] as RowDataPacket[]);
  const map = new Map<number, string[]>();
  for (const row of rows) {
    const id = Number(row.location_id ?? 0);
    const name = String(row.name ?? "").trim();
    if (id <= 0 || !name) continue;
    const list = map.get(id) ?? [];
    if (!list.includes(name)) list.push(name);
    map.set(id, list);
  }
  return map;
}

async function profileFromRow(row: RowDataPacket, locationCategories: Map<number, string[]> = new Map()): Promise<MarketplaceProfile> {
  const tenantId = Number(row.tenant_id ?? 0);
  const slug = String(row.slug ?? "");
  const locationRows = tenantId > 0
    ? await dbQuery<RowDataPacket[]>(`
      SELECT id, name, address, legal_city, legal_province
      FROM locations
      WHERE tenant_id = ? AND COALESCE(is_active, 1) = 1 AND COALESCE(marketplace_enabled, 1) = 1
      ORDER BY sort_order ASC, name ASC
      LIMIT 6
    `, [tenantId]).catch(() => [] as RowDataPacket[])
    : [];
  const services = splitLabels(row.service_labels).slice(0, 4);
  const city = String(row.city ?? "").trim();
  const area = String(row.area ?? "").trim() || city || "";
  const price = Number(row.price_from ?? 0);

  return {
    slug,
    name: String(row.business_name ?? slug),
    category: services[0] ?? DEFAULT_CATEGORY,
    area,
    rating: DEFAULT_RATING,
    reviews: DEFAULT_REVIEWS,
    nextSlot: DEFAULT_NEXT_SLOT,
    priceFrom: price > 0 ? `Da ${roundMoney(price)} euro` : DEFAULT_PRICE_FROM,
    image: DEFAULT_IMAGE,
    services: services.length ? services : DEFAULT_SERVICES,
    locations: (locationRows.length ? locationRows : [row]).map((location) => {
      const locationId = Number(location.id ?? row.first_location_id ?? 0);
      const activityCategories = locationCategories.get(locationId) ?? [];
      return {
        id: locationId,
        name: String(location.name ?? row.first_location_name ?? "Sede principale"),
        city: String(location.legal_city ?? city),
        area: String(location.legal_province ?? area),
        address: String(location.address ?? row.first_address ?? ""),
        activityCategories,
        categoryText: activityCategories.join(", "),
      };
    }),
  };
}

async function marketplaceDbCategories(rows: RowDataPacket[]): Promise<string[]> {
  const categoryRows = await dbQuery<RowDataPacket[]>(`
    SELECT name
    FROM marketplace_activity_categories
    WHERE COALESCE(is_active, 1) = 1
    ORDER BY sort_order ASC, name ASC
  `).catch(() => [] as RowDataPacket[]);
  const fromTable = categoryRows.map((row) => String(row.name ?? "").trim()).filter(Boolean);
  if (fromTable.length) return fromTable;
  const fromServices = rows.flatMap((row) => splitLabels(row.service_labels));
  return Array.from(new Set(fromServices));
}

function splitLabels(value: unknown): string[] {
  return String(value ?? "")
    .split("||")
    .map((item) => item.trim())
    .filter(Boolean);
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
