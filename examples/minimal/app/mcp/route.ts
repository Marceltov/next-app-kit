import { mcpHandler } from "next-app-kit/next";
import { app } from "@/backend/app";

// MCP over Streamable HTTP, POST only.
export const { POST, GET, DELETE } = mcpHandler(async () => (await app()).mcp);
