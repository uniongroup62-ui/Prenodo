import type { Metadata } from "next";
import { ManageForgotPasswordFaithful } from "@/components/manage-forgot-password-faithful";

export const metadata: Metadata = {
  title: "Recupera password - Prenodo",
};

export default async function ManageForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ slug?: string }>;
}) {
  const { slug } = await searchParams;
  return <ManageForgotPasswordFaithful initialSlug={slug || ""} />;
}
