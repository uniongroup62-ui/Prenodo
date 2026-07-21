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
};

export default nextConfig;
