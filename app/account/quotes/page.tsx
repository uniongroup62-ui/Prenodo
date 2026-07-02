import type { Metadata } from "next";
import { PublicAccountPage } from "@/components/public-account-page";

export const metadata: Metadata = {
  title: "I miei preventivi | Prenodo",
};

// Area cliente — I miei preventivi (port of booking.php mode=my_quotes +
// quote_decision).
export default function AccountQuotesPage() {
  return <PublicAccountPage initialMode="quotes" />;
}
