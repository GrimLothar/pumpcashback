/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    // Suppress pino-pretty warning from WalletConnect
    config.resolve.fallback = { ...config.resolve.fallback, "pino-pretty": false };
    return config;
  },
};

export default nextConfig;
