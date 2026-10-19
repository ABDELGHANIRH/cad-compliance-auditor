/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // The FastAPI backend serves generated GLB files from /static/models. Proxying
  // means the browser always requests them same-origin, so model_url can stay a
  // root-relative path regardless of whether the page is on localhost:3000 or
  // 127.0.0.1:3000 -- two origins that are NOT interchangeable for CORS.
  async rewrites() {
    const backend = process.env.BACKEND_ORIGIN ?? 'http://127.0.0.1:8000';
    return [
      { source: '/static/:path*', destination: `${backend}/static/:path*` },
    ];
  },
};

export default nextConfig;
