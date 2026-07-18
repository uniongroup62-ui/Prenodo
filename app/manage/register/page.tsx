import type { Metadata } from "next";
import { ManageRegisterFaithful } from "@/components/manage-register-faithful";

export const metadata: Metadata = {
  title: "Crea il tuo gestionale - Prenodo",
};

export default function ManageRegisterPage() {
  return <ManageRegisterFaithful initialStep="register" />;
}
