import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let client: Client | null = null;

export async function getMcpClient(): Promise<Client> {
  if (client) return client;

  const serverPath = path.resolve(
    __dirname,
    "..",
    "..",
    "boundary-monitor-mcp",
    "dist",
    "index.js",
  );

  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
    } as Record<string, string>,
  });

  client = new Client({ name: "bim-dashboard", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

export async function callMcpTool(
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const c = await getMcpClient();
  const result = await c.callTool({ name: toolName, arguments: args });
  const text = result.content as Array<{ type: string; text: string }>;
  if (text.length > 0 && text[0].type === "text") {
    return JSON.parse(text[0].text);
  }
  return result;
}
