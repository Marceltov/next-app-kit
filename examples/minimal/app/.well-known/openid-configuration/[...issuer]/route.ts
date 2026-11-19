import { wellKnownHandlers } from "next-app-kit/next";
import { auth } from "@/backend/app";

// OpenID discovery of the issuer <base>/api/auth.
export const GET = wellKnownHandlers(auth).openidConfiguration;
