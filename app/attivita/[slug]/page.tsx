import type { Metadata } from "next";
import { MarketplaceDetailFaithful } from "@/components/public/marketplace-detail-faithful";

const SEARCH_ALIASES = ["cerca", "risultati"]; // + /attivita/ricerca (route statica)

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  if (SEARCH_ALIASES.includes(slug)) {
    return { title: "Risultati ricerca attività" };
  }
  // The real business name is loaded client-side by the faithful component from
  // /api/booking?action=context. Metadata stays tenant-agnostic (slug-based) so
  // we never depend on demo data nor default to a specific center here.
  return {
    title: slug ? `${slug} | Prenodo` : "Attivita | Prenodo",
    description: "Scheda marketplace e prenotazione online su Prenodo.",
  };
}

export default async function AttivitaDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  // Alias legacy della pagina risultati (public_marketplace.php 30:
  // ricerca|cerca|risultati).
  if (SEARCH_ALIASES.includes(slug)) {
    const query = (await searchParams) ?? {};
    const qs = (key: string): string => {
      const raw = query[key];
      return String(Array.isArray(raw) ? raw[0] ?? "" : raw ?? "");
    };
    const { MarketplaceSearchFaithful } = await import("@/components/public/marketplace-search-faithful");
    return (
      <MarketplaceSearchFaithful
        initialQuery={{ q: qs("q"), city: qs("city"), category: qs("category"), service: qs("service") }}
      />
    );
  }
  return <MarketplaceDetailFaithful slug={slug} />;
}
