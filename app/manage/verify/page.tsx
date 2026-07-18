import type { Metadata } from "next";
import { ManageRegisterFaithful } from "@/components/manage-register-faithful";

export const metadata: Metadata = {
  title: "Verifica la tua email - Prenodo",
};

export default async function ManageVerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ slug?: string; email?: string; signup_id?: string }>;
}) {
  const { slug, email, signup_id: signupId } = await searchParams;
  return (
    <ManageRegisterFaithful
      initialStep="verify"
      initialSlug={slug || ""}
      initialEmail={email || ""}
      initialSignupId={Number.parseInt(signupId || "", 10) || 0}
    />
  );
}
