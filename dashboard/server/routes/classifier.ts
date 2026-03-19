import { Router } from "express";
import { callMcpTool } from "../mcp-client.js";

export const classifierRouter = Router();

// GET /api/classifier-state — proxies MCP get_classifier_state tool
classifierRouter.get("/classifier-state", async (_req, res) => {
  try {
    const state = await callMcpTool("get_classifier_state");
    res.json(state);
  } catch (err) {
    res.status(502).json({ error: `MCP call failed: ${err}` });
  }
});
