/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Allow importing shared workspace packages without a separate build step.
  transpilePackages: ["@socialith/types"],
  // Produces .next/standalone: a minimal, self-contained server.js plus
  // only the node_modules this app actually needs at runtime — what the
  // shared-hosting/cPanel deployment (Setup Node.js App, no Docker)
  // uploads and points its "Application startup file" at. See
  // docs/deployment-guzelhosting-shared.md.
  output: "standalone",
};

export default nextConfig;
