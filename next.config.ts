import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native SQLite driver must be loaded from node_modules at runtime, never bundled.
  serverExternalPackages: ["better-sqlite3"],
  // The staging app is a separate Next.js application in this repository.
  outputFileTracingExcludes: { "*": ["staging/**", "var/**"] },
};

export default nextConfig;
