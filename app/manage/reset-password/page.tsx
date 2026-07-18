import type { Metadata } from "next";
import { ManageResetPasswordFaithful } from "@/components/manage-reset-password-faithful";

export const metadata: Metadata = {
  title: "Reimposta password - Prenodo",
};

export default async function ManageResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ slug?: string; token?: string }>;
}) {
  const { slug, token } = await searchParams;
  return <ManageResetPasswordFaithful initialSlug={slug || ""} initialToken={token || ""} />;
}
