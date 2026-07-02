import type { Metadata } from "next";
import { PublicAccountPage } from "@/components/public-account-page";

export const metadata: Metadata = {
  title: "I miei pacchetti | Prenodo",
};

// Area cliente — I miei pacchetti (port of booking.php mode=my_packages).
export default function AccountPackagesPage() {
  return <PublicAccountPage initialMode="packages" />;
}
