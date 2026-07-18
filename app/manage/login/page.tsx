import type { Metadata } from "next";
import { ManageLoginFaithful } from "@/components/manage-login-faithful";

export const metadata: Metadata = {
  title: "Accedi al gestionale - Prenodo",
};

export default async function ManageLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ slug?: string }>;
}) {
  const { slug } = await searchParams;
  // Multi-tenant-clean: prefill the slug from the URL only. No default to a
  // specific tenant — the field stays empty (its placeholder shows an example).
  return <ManageLoginFaithful initialSlug={slug || ""} />;
}
