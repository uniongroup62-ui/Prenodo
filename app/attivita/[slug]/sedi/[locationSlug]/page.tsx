import type { Metadata } from "next";
import { MarketplaceDetailFaithful } from "@/components/public/marketplace-detail-faithful";
import { marketplaceJsonLd, marketplaceSeoProfile } from "@/lib/marketplace-seo";

// Scheda SEDE del marketplace (public_marketplace.php $locationSlug:
// /attivita/<slug>/sedi/<citta-nome-id>): il dettaglio attività con la sede
// selezionata (booking link, indirizzo e preferiti puntano a QUELLA sede).

function locationIdFromSlug(locationSlug: string): number {
  const idMatch = /-(\d+)$/.exec(locationSlug ?? "");
  return idMatch ? Number.parseInt(idMatch[1], 10) : 0;
}

function publicBaseUrl(): string {
  return String(process.env.PRENODO_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "") || "http://localhost:3000";
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; locationSlug: string }>;
}): Promise<Metadata> {
  const { slug, locationSlug } = await params;
  // SEO server-side (miglioria 2026-07-18): nome attività + sede reali.
  const profile = await marketplaceSeoProfile(slug);
  if (!profile) {
    return {
      title: slug ? `${slug} | Prenodo` : "Attivita | Prenodo",
      description: "Scheda marketplace e prenotazione online su Prenodo.",
    };
  }
  const locationId = locationIdFromSlug(locationSlug);
  const location = profile.locations.find((loc) => loc.id === locationId);
  const title = location?.name ? `${profile.name} — ${location.name} | Prenodo` : `${profile.name} | Prenodo`;
  const where = [location?.city || profile.city, location?.province || profile.province].filter(Boolean).join(" ");
  return {
    title,
    description: `Prenota online da ${profile.name}${where ? ` a ${where}` : ""}: servizi, orari e disponibilità su Prenodo.`,
  };
}

export default async function AttivitaLocationPage({
  params,
}: {
  params: Promise<{ slug: string; locationSlug: string }>;
}) {
  const { slug, locationSlug } = await params;
  // Il suffisso numerico dello slug sede legacy ('altino-sede1-21') è l'id.
  const locationId = locationIdFromSlug(locationSlug);
  const seo = await marketplaceSeoProfile(slug);
  const seoLocation = seo?.locations.find((loc) => loc.id === locationId);
  return (
    <>
      {seo ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(marketplaceJsonLd(seo, publicBaseUrl(), seoLocation)) }}
        />
      ) : null}
      <MarketplaceDetailFaithful slug={slug} locationId={locationId > 0 ? locationId : undefined} />
    </>
  );
}
