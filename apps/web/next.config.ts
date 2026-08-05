import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Standalone output keeps the production Docker image small and avoids
  // shipping the full monorepo node_modules into the runtime layer.
  output: "standalone",
};

export default nextConfig;
