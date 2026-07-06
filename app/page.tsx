import type { Metadata } from "next";
import { MarketplaceListFaithful } from "@/components/public/marketplace-list-faithful";

export const metadata: Metadata = {
  title: "Cerca attività",
  description: "Marketplace pubblico per cercare centri estetici e prenotare online.",
};

// The home page IS the (migrated) public marketplace — same as /attivita.
export default function Home() {
  return <MarketplaceListFaithful />;
}
