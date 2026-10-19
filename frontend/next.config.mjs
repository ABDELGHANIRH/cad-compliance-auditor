/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  experimental: {
    serverActions: {
      bodySizeLimit: '50mb',
    },
    // Allows larger proxy payloads in serverless/route handlers
    middlewareClientMaxBodySize: '50mb',
  },

  async rewrites() {
    const backend = process.env.BACKEND_ORIGIN ?? 'http://127.0.0.1:8000';
    return [
      { source: '/static/:path*', destination: `${backend}/static/:path*` },
    ];
  },
};

export default nextConfig;