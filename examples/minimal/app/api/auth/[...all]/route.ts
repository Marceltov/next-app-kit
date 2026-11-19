import { authHandler } from "next-app-kit/next";
import { auth } from "@/backend/app";

// Better Auth: sign-in, sessions, passkeys, and the OAuth server for MCP clients and scripts.
export const { GET, POST } = authHandler(auth);
