import type { Metadata } from "next";
import { PublicAccountPage } from "@/components/public-account-page";

export const metadata: Metadata = {
  title: "Le mie prenotazioni | Prenodo",
};

// Area cliente — Le mie prenotazioni (port of the legacy booking.php customer
// area: mode=my_appointments + cancel_appointment + ics).
export default function AccountAppointmentsPage() {
  return <PublicAccountPage initialMode="appointments" />;
}
