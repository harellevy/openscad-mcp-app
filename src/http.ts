#!/usr/bin/env node
/**
 * Streamable HTTP entry point. MCP App iframes frequently do NOT render over the
 * stdio transport in Claude Desktop (modelcontextprotocol/ext-apps#671,
 * anthropics/claude-ai-mcp#165) — the inline-UI path is exercised over Streamable
 * HTTP, which is how remote MCP servers (and connectors) run. Run this, then add
 *   http://localhost:<PORT>/mcp
 * to Claude Desktop / claude.ai as a custom connector to get the inline 3D viewer.
 *
 *   PORT=3333 node dist/http.js      (or: npm run start:http)
 *
 * Stateful sessions (faithful to a normal remote MCP server): the client sends
 * `initialize`, gets an `mcp-session-id`, and reuses it for subsequent requests.
 */
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { probeEnvironment } from "./openscad.js";
import { createServer } from "./server.js";

const PORT = Number(process.env.PORT ?? 3333);
const transports = new Map<string, StreamableHTTPServerTransport>();

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      if (!data) return resolve(undefined);
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", () => resolve(undefined));
  });
}

function rpcError(message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

const http = createHttpServer(async (req, res) => {
  // Permissive CORS so a connector/browser host can reach a localhost server.
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, mcp-protocol-version, last-event-id");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname !== "/mcp") {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found. MCP endpoint is /mcp");
    return;
  }

  const sessionId = req.headers["mcp-session-id"];
  let transport = typeof sessionId === "string" ? transports.get(sessionId) : undefined;

  try {
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      if (!transport) {
        if (!isInitializeRequest(body)) {
          res.writeHead(400, { "Content-Type": "application/json" })
            .end(rpcError("No valid session; the first request must be initialize"));
          return;
        }
        const created = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
        created.onclose = () => {
          if (created.sessionId) transports.delete(created.sessionId);
        };
        await createServer().connect(created);
        await created.handleRequest(req, res, body);
        if (created.sessionId) transports.set(created.sessionId, created);
        return;
      }
      await transport.handleRequest(req, res, body);
      return;
    }

    if ((req.method === "GET" || req.method === "DELETE") && transport) {
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(400, { "Content-Type": "application/json" })
      .end(rpcError("Missing or unknown mcp-session-id"));
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" })
        .end(rpcError(`Internal error: ${(err as Error).message}`));
    }
  }
});

const probe = await probeEnvironment();
http.listen(PORT, () => {
  console.error(`openscad-mcp: Streamable HTTP listening on http://localhost:${PORT}/mcp`);
  console.error("Add that URL to Claude Desktop / claude.ai as a custom connector for the inline 3D viewer.");
  console.error(probe.report);
});
