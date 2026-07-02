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
};

export default nextConfig;
