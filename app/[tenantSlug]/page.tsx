import { redirect } from "next/navigation";

export default async function TenantEntryPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantSlug: string }>;
  searchParams: Promise<{ support_token?: string }>;
}) {
  const { tenantSlug } = await params;
  const { support_token: supportToken } = await searchParams;
  if (supportToken) {
    // Il consumo (cookie di sessione manage) avviene nel Route Handler:
    // impostare cookie durante il render di un Server Component è vietato.
    redirect(`/api/manage/support-access?slug=${encodeURIComponent(tenantSlug)}&token=${encodeURIComponent(supportToken)}`);
  }
  redirect(`/manage/login?slug=${encodeURIComponent(tenantSlug)}`);
}
