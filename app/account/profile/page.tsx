import type { Metadata } from "next";
import { AccountFaithful } from "@/components/public/account-faithful";

export const metadata: Metadata = {
  title: "Area cliente - Prenodo",
};

export default function AccountProfilePage() {
  return <AccountFaithful mode="profile" />;
}
