import type { Metadata } from "next";
import { AccountResetFaithful } from "@/components/public/account-reset-faithful";

export const metadata: Metadata = {
  title: "Area cliente - Prenodo",
};

export default function AccountResetPage() {
  return <AccountResetFaithful />;
}
