import type { NextConfig } from "next";

const config: NextConfig = {
  // This directory is the app's root, although the kit's repository around it has a lockfile of its own.
  turbopack: { root: import.meta.dirname },
};

export default config;
