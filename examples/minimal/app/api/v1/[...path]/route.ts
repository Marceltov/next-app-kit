import { restHandler } from "next-app-kit/next";
import { app } from "@/backend/app";

// The REST API: the operations of backend/app.ts, and /api/v1/openapi.json.
export const { GET, POST, PUT, PATCH, DELETE } = restHandler(async () => (await app()).rest);
