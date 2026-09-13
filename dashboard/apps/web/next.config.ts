import type { NextConfig } from "next";

/** Where the API-only backend lives. The browser only ever talks to this app;
 *  /api/* is proxied to the backend so session cookies stay same-origin. */
const BACKEND_URL = process.env.BACKEND_URL || "http://127.0.0.1:3011";

const nextConfig: NextConfig = {
  transpilePackages: ["@dashboard/shared"],
  allowedDevOrigins: ["192.168.99.22"],
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${BACKEND_URL}/api/:path*` }];
  },
};

export default nextConfig;
