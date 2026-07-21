import type { Metadata } from "next";
import { MarketplaceDetailFaithful } from "@/components/public/marketplace-detail-faithful";
import { jsonLdSerialize, marketplaceJsonLd, marketplaceSeoProfile } from "@/lib/marketplace-seo";

const SEARCH_ALIASES = ["cerca", "risultati"]; // + /attivita/ricerca (route statica)

function publicBaseUrl(): string {
  return String(process.env.PRENODO_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "") || "http://localhost:3000";
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  if (SEARCH_ALIASES.includes(slug)) {
    return { title: "Risultati ricerca attività" };
  }
  // SEO server-side (miglioria 2026-07-18): titolo/description dal profilo
  // REALE dell'attività — i motori li vedono nel primo HTML anche se il corpo
  // della scheda è client-side.
  const profile = await marketplaceSeoProfile(slug);
  if (!profile) {
    return {
      title: slug ? `${slug} | Prenodo` : "Attivita | Prenodo",
      description: "Scheda marketplace e prenotazione online su Prenodo.",
    };
  }
  const where = [profile.city, profile.province].filter(Boolean).join(" ");
  return {
    title: `${profile.name} | Prenodo`,
    description: `Prenota online da ${profile.name}${where ? ` a ${where}` : ""}: servizi, orari e disponibilità su Prenodo.`,
    ...(profile.imageUrl ? { openGraph: { title: profile.name, images: [profile.imageUrl] } } : { openGraph: { title: profile.name } }),
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
  // JSON-LD LocalBusiness nel primo HTML (server component): dati indicizzabili
  // anche senza eseguire il client bundle.
  const seo = await marketplaceSeoProfile(slug);
  return (
    <>
      {seo ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLdSerialize(marketplaceJsonLd(seo, publicBaseUrl())) }}
        />
      ) : null}
      <MarketplaceDetailFaithful slug={slug} />
    </>
  );
}
