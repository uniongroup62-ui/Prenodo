import type { Metadata } from "next";
import { AccountFaithful } from "@/components/public/account-faithful";

export const metadata: Metadata = {
  title: "Attività - Account cliente",
};

export default function AccountActivitiesPage() {
  return <AccountFaithful mode="activities" />;
}
