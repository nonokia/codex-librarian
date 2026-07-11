/** @type {import('next').NextConfig} */
const nextConfig = {
  // the store layer lives in the parent package's dist/ — allow importing it
  experimental: { externalDir: true },
};

export default nextConfig;
