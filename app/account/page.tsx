import { redirect } from "next/navigation";

// L'area account centrale parte da Attività (public_account.php: attività /
// preferiti / profilo). Il gate del login rimanda qui i clienti loggati.
export default function AccountRootPage() {
  redirect("/account/activities");
}
