import type { NextConfig } from "next";

const publicDevOrigin = (() => {
  const value = process.env.PUBLIC_BASE_URL;
  if (!value) return undefined;
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
})();

const nextConfig: NextConfig = {
  // Native SQLite driver must be loaded from node_modules at runtime, never bundled.
  serverExternalPackages: ["better-sqlite3"],
  // The staging app is a separate Next.js application in this repository.
  outputFileTracingExcludes: { "*": ["staging/**", "var/**"] },
  // Permit the public tunnel to connect to the development HMR websocket.
  ...(publicDevOrigin ? { allowedDevOrigins: [publicDevOrigin] } : {}),
};

export default nextConfig;
