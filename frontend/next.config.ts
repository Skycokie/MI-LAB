import type { NextConfig } from "next";

// Hardcoded Railway fallback — .env may not be available when next.config is evaluated.
// Local dev: set BACKEND_URL=http://127.0.0.1:8000 in frontend/.env.local.
const BACKEND = (
  process.env.BACKEND_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  "https://backend-production-35920.up.railway.app"
).replace(/\/$/, "");

if (process.env.NODE_ENV === "development") {
  console.info(`[next.config] API rewrite → ${BACKEND}`);
}

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    agentUpgrade: "security",
    // Default 30s proxy cut-off turned slow Yahoo scans into "Internal Server Error".
    proxyTimeout: 120_000,
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${BACKEND}/api/:path*`,
      },
    ];
  },
  turbopack: {
    root: __dirname,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
