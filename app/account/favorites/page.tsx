import type { Metadata } from "next";
import { AccountFaithful } from "@/components/public/account-faithful";

export const metadata: Metadata = {
  title: "Preferiti - Account cliente",
};

export default function AccountFavoritesPage() {
  return <AccountFaithful mode="favorites" />;
}
