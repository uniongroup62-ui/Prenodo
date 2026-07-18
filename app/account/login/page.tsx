import type { Metadata } from "next";
import { AccountLoginFaithful } from "@/components/public/account-login-faithful";

export const metadata: Metadata = {
  title: "Area cliente - Prenodo",
};

export default function AccountLoginPage() {
  return <AccountLoginFaithful />;
}
