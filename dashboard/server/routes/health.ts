import { Router } from "express";
import { callMcpTool } from "../mcp-client.js";

export const healthRouter = Router();

// GET /api/health — proxies MCP health_check tool
healthRouter.get("/health", async (_req, res) => {
  try {
    const health = await callMcpTool("health_check");
    res.json(health);
  } catch (err) {
    res.status(502).json({ error: `MCP call failed: ${err}` });
  }
});
