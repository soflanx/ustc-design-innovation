import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  devIndicators: false,
  poweredByHeader: false,
  output: 'standalone',
  // Allow multipart overhead above the 10 MiB course material limit.
  experimental: { serverActions: { bodySizeLimit: '11mb' } },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'X-Frame-Options', value: 'DENY' },
      ],
    }, {
      source: '/courses/:offeringId/resources/:resourceId/preview',
      headers: [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }],
    }];
  },
};

export default nextConfig;
