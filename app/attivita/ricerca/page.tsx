import type { Metadata } from "next";
import { MarketplaceSearchFaithful } from "@/components/public/marketplace-search-faithful";

// Risultati ricerca marketplace (public_marketplace.php $isSearchResults:
// /attivita/ricerca con filtri GET q/city/category/service).
export const metadata: Metadata = {
  title: "Risultati ricerca attività",
};

export default async function MarketplaceSearchPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = (await searchParams) ?? {};
  const qs = (key: string): string => {
    const raw = query[key];
    return String(Array.isArray(raw) ? raw[0] ?? "" : raw ?? "");
  };
  return (
    <MarketplaceSearchFaithful
      initialQuery={{ q: qs("q"), city: qs("city"), category: qs("category"), service: qs("service") }}
    />
  );
}
