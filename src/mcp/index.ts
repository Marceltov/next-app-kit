// next-app-kit/mcp: the MCP endpoint (route.ts) over the app's tools (tools.ts), and the person's connections, the clients they allowed
// (connections.ts). Moved from noticebox (backend/mcp.ts and backend/admin.ts), the wiring only: an app passes its own tools.
export { clientName, connected, connections, revokeConnection, type Connection, type Outcome } from "./connections.js";
export { mcpRoute, whoFor, type McpContext } from "./route.js";
export { defineTool, refuse, type Guided, type Refused, type Tool, type Who } from "./tools.js";
