import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";
import "./globals.css";

// Font della superficie PUBBLICA (marketplace/booking/account): Fraunces per i
// titoli display, Inter per UI/body. Esposti come CSS custom properties sul
// root; il gestionale (Bootstrap) non li usa e resta com'è.
const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-display",
  display: "swap",
});
const inter = Inter({ subsets: ["latin"], variable: "--font-pub", display: "swap" });

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
    <html lang="it" className={`h-full antialiased ${fraunces.variable} ${inter.variable}`}>
      {/* body a display:block (NON flex): le pagine pubbliche marketplace/
          account usano .wrap/.account-page con margin:auto+max-width, che in
          un flex-column si restringono al contenuto. Il gestionale usa i
          propri wrapper Bootstrap (min-vh-100) e non richiede il flex. */}
      <body className="min-h-full">{children}</body>
    </html>
  );
}
