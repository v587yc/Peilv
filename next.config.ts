import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  productionBrowserSourceMaps: false,
  experimental: {
    serverSourceMaps: false,
  },
  outputFileTracingExcludes: {
    '*': [
      './release-artifacts/**',
      './test-results/**',
      './playwright-report/**',
      './blob-report/**',
      './coverage/**',
      './.test-tmp*/**',
      './.claude/**',
      './.trellis/**',
    ],
  },
  // outputFileTracingRoot: path.resolve(__dirname, '../../'),  // Uncomment and add 'import path from "path"' if needed
  /* config options here */
  allowedDevOrigins: ['*.dev.coze.site'],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*',
        pathname: '/**',
      },
    ],
  },
};

export default nextConfig;
