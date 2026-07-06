import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Prenodo | Gestionale prenotazioni e marketplace",
  description:
    "Gestionale per prenotazioni, agenda clienti e marketplace locale per centri estetici.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="it" className="h-full antialiased">
      {/* body a display:block (NON flex): le pagine pubbliche marketplace/
          account usano .wrap/.account-page con margin:auto+max-width, che in
          un flex-column si restringono al contenuto. Il gestionale usa i
          propri wrapper Bootstrap (min-vh-100) e non richiede il flex. */}
      <body className="min-h-full">{children}</body>
    </html>
  );
}
