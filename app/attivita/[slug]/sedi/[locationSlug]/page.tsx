import type { Metadata } from "next";
import { MarketplaceDetailFaithful } from "@/components/public/marketplace-detail-faithful";

// Scheda SEDE del marketplace (public_marketplace.php $locationSlug:
// /attivita/<slug>/sedi/<citta-nome-id>): il dettaglio attività con la sede
// selezionata (booking link, indirizzo e preferiti puntano a QUELLA sede).
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; locationSlug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: slug ? `${slug} | Prenodo` : "Attivita | Prenodo",
    description: "Scheda marketplace e prenotazione online su Prenodo.",
  };
}

export default async function AttivitaLocationPage({
  params,
}: {
  params: Promise<{ slug: string; locationSlug: string }>;
}) {
  const { slug, locationSlug } = await params;
  // Il suffisso numerico dello slug sede legacy ('altino-sede1-21') è l'id.
  const idMatch = /-(\d+)$/.exec(locationSlug ?? "");
  const locationId = idMatch ? Number.parseInt(idMatch[1], 10) : 0;
  return <MarketplaceDetailFaithful slug={slug} locationId={locationId > 0 ? locationId : undefined} />;
}
