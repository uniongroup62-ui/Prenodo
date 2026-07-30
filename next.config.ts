import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfkit legge i font AFM da node_modules a runtime: va tenuto esterno al bundle server.
  serverExternalPackages: ["pdfkit"],
  turbopack: {
    root: process.cwd(),
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "images.unsplash.com",
        pathname: "/**",
      },
    ],
  },
  // Header globali (audit GDPR art.32 2026-07-21): le pagine pubbliche hanno
  // token in URL (firma consensi, reset password) e caricano asset da CDN
  // esterna — Referrer-Policy evita di far uscire quei token nel referer;
  // nosniff previene il MIME-sniffing. Niente X-Frame-Options globale: il
  // booking può legittimamente essere incorporato dai siti dei centri (le
  // superfici admin hanno già DENY dal proxy).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
  // SVILUPPO: serve il sito vetrina sotto lo stesso host dell'app, replicando in
  // locale quello che in produzione fa il CDN (vedi docs/domini-routing.md).
  // Senza VETRINA_DEV_ORIGIN non fa nulla: la root resta il redirect a /attivita.
  //
  // Come si usa (due terminali):
  //   1) vetrina:  NEXT_PUBLIC_ASSET_PREFIX=/_vetrina npm run dev -- -p 3001
  //   2) app:      VETRINA_DEV_ORIGIN=http://localhost:3001 npm run dev
  // Poi http://localhost:3000/ mostra la vetrina e /attivita il marketplace.
  //
  // L'asset prefix è necessario perché le due build servono entrambe i propri
  // chunk da /_next/*: senza, la vetrina caricherebbe il JS dell'app.
  async rewrites() {
    const vetrina = String(process.env.VETRINA_DEV_ORIGIN ?? "").trim().replace(/\/+$/, "");
    if (!vetrina) return [];
    return {
      // beforeFiles: intercetta PRIMA delle pagine dell'app, così "/" va alla
      // vetrina invece che al redirect verso /attivita.
      beforeFiles: [
        { source: "/", destination: `${vetrina}/` },
        { source: "/chi-siamo", destination: `${vetrina}/chi-siamo` },
        { source: "/chi-siamo/:path*", destination: `${vetrina}/chi-siamo/:path*` },
        { source: "/features", destination: `${vetrina}/features` },
        { source: "/features/:path*", destination: `${vetrina}/features/:path*` },
        { source: "/pricing", destination: `${vetrina}/pricing` },
        { source: "/settori", destination: `${vetrina}/settori` },
        { source: "/settori/:path*", destination: `${vetrina}/settori/:path*` },
        { source: "/blog", destination: `${vetrina}/blog` },
        { source: "/blog/:path*", destination: `${vetrina}/blog/:path*` },
        { source: "/supporto", destination: `${vetrina}/supporto` },
        // Asset della vetrina: /_vetrina/_next/... -> <vetrina>/_next/...
        { source: "/_vetrina/:path*", destination: `${vetrina}/:path*` },
        // File statici della vetrina (la sua cartella public/): NON sono coperti
        // dall'asset prefix, che vale solo per /_next/*. Vengono serviti dalla
        // RADICE del dominio, quindi senza queste regole l'app li leggerebbe
        // come slug di un tenant e li reindirizzerebbe (immagini rotte).
        // Se si aggiungono file in public/ della vetrina, vanno elencati qui
        // E nelle regole del CDN (vedi docs/domini-routing.md).
        { source: "/images/:path*", destination: `${vetrina}/images/:path*` },
        { source: "/icon.svg", destination: `${vetrina}/icon.svg` },
        { source: "/icon-dark-32x32.png", destination: `${vetrina}/icon-dark-32x32.png` },
        { source: "/icon-light-32x32.png", destination: `${vetrina}/icon-light-32x32.png` },
        { source: "/apple-icon.png", destination: `${vetrina}/apple-icon.png` },
        { source: "/placeholder.svg", destination: `${vetrina}/placeholder.svg` },
        { source: "/placeholder.jpg", destination: `${vetrina}/placeholder.jpg` },
        { source: "/placeholder-logo.svg", destination: `${vetrina}/placeholder-logo.svg` },
        { source: "/placeholder-logo.png", destination: `${vetrina}/placeholder-logo.png` },
        { source: "/placeholder-user.jpg", destination: `${vetrina}/placeholder-user.jpg` },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
