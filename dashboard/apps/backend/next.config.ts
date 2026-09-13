import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@dashboard/shared"],
  allowedDevOrigins: ["192.168.99.22"],
};

export default nextConfig;
