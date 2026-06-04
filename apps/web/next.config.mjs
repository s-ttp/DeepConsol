/** @type {import('next').NextConfig} */
const nextConfig = {
  // Note: not using output: "standalone" — it drops _next/static and
  // workspace deps. We run `next start` directly from the web dir instead.
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@deepconsol/shared"],
  async rewrites() {
    // The browser hits Nginx at https://<public>/api/* and Nginx proxies to
    // the API. In dev (npm run dev:web), this rewrite lets the browser hit
    // the Next.js dev server's /api/* and have it forward to the API at 5001.
    if (process.env.NODE_ENV !== "production") {
      return [
        { source: "/api/:path*", destination: "http://127.0.0.1:5001/:path*" },
      ];
    }
    return [];
  },
};
export default nextConfig;
