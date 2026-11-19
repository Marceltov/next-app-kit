import { wellKnownHandlers } from "next-app-kit/next";
import { auth } from "@/backend/app";

// RFC 9728 metadata of /api/v1 and /mcp, where their 401s point.
export const GET = wellKnownHandlers(auth).protectedResource;
