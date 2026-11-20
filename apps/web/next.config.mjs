/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Allow importing shared workspace packages without a separate build step.
  transpilePackages: ["@socialith/types", "@socialith/publishing", "@socialith/studio"],
  // @socialith/publishing is TypeScript source that imports its own files with ESM '.js' specifiers (like every
  // workspace package here); let webpack resolve those to the .ts files.
  webpack: (config) => {
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    return config;
  },
  // Produces .next/standalone: a minimal, self-contained server.js plus
  // only the node_modules this app actually needs at runtime — what the
  // shared-hosting/cPanel deployment (Setup Node.js App, no Docker)
  // uploads and points its "Application startup file" at. See
  // docs/deployment-guzelhosting-shared.md.
  output: "standalone",
};

export default nextConfig;
