import type { MetadataRoute } from "next";

// robots.txt (Fase 2 accesso separato admin, 2026-07-19): il pannello /admin
// non va indicizzato (in aggiunta all'header X-Robots-Tag del proxy).
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin", "/api/"],
      },
    ],
  };
}
