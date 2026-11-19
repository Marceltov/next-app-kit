import { wellKnownHandlers } from "next-app-kit/next";
import { auth } from "@/backend/app";

// RFC 8414 metadata of the issuer <base>/api/auth.
export const GET = wellKnownHandlers(auth).authorizationServer;
