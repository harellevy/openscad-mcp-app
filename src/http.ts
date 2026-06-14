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
 * Two extra (non-MCP) routes back the viewer's buttons, because a sandboxed iframe
 * can't download a file directly:
 *   POST /repair  {id, quality?}  -> NDJSON progress; sends the model's STL through
 *                                    the VAR2 STL-repair Space and writes the
 *                                    repaired STL to disk.
 *   POST /save    {id, kind}      -> writes the raw STL or PNG to disk; {path}.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { probeEnvironment, toBinaryStl } from "./openscad.js";
import { repairGlb, stlToGlb } from "./repair.js";
import { EXPORT_DIR, createServer, getAsset } from "./server.js";

const PORT = Number(process.env.PORT ?? 3333);
// Publish the base URL so the viewer can fetch /repair and /save, and so the UI
// resource declares it in csp.connectDomains. Must be set before createServer().
process.env.OPENSCAD_MCP_BASE_URL = process.env.OPENSCAD_MCP_BASE_URL ?? `http://localhost:${PORT}`;

const transports = new Map<string, StreamableHTTPServerTransport>();

function readJsonBody(req: IncomingMessage): Promise<any> {
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

async function handleRepair(res: ServerResponse, body: any): Promise<void> {
  const asset = body?.id ? getAsset(String(body.id)) : undefined;
  if (!asset?.stl) {
    res.writeHead(404, { "Content-Type": "application/x-ndjson" })
      .end(JSON.stringify({ type: "error", error: "unknown model id — re-run the render so the viewer has a fresh id" }) + "\n");
    return;
  }
  res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache, no-transform" });
  const write = (e: unknown) => {
    try {
      res.write(JSON.stringify(e) + "\n");
    } catch {
      /* client gone */
    }
  };
  try {
    const glb = stlToGlb(asset.stl);
    write({ type: "progress", stage: "convert", percent: 2, message: `Converted to GLB (${(glb.length / 1024) | 0} KB)` });
    const quality = ["draft", "standard", "high"].includes(body?.quality) ? body.quality : "standard";
    const { stl, stats } = await repairGlb(glb, quality, write);
    await mkdir(EXPORT_DIR, { recursive: true });
    const outPath = path.join(EXPORT_DIR, `${asset.name}.repaired.stl`);
    await writeFile(outPath, stl);
    write({ type: "saved", percent: 100, path: outPath, bytes: stl.length, stats });
  } catch (e) {
    write({ type: "error", error: (e as Error).message });
  }
  res.end();
}

async function handleSave(res: ServerResponse, body: any): Promise<void> {
  const asset = body?.id ? getAsset(String(body.id)) : undefined;
  if (!asset) {
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "unknown model id" }));
    return;
  }
  try {
    await mkdir(EXPORT_DIR, { recursive: true });
    if (body?.kind === "png" && asset.png) {
      const outPath = path.join(EXPORT_DIR, `${asset.name}.png`);
      await writeFile(outPath, asset.png);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ path: outPath, bytes: asset.png.length }));
      return;
    }
    if (asset.stl) {
      const bin = toBinaryStl(asset.stl);
      const outPath = path.join(EXPORT_DIR, `${asset.name}.stl`);
      await writeFile(outPath, bin);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ path: outPath, bytes: bin.length }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "nothing to save for that kind" }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: (e as Error).message }));
  }
}

const http = createHttpServer(async (req, res) => {
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

  if (url.pathname === "/repair" && req.method === "POST") {
    await handleRepair(res, await readJsonBody(req));
    return;
  }
  if (url.pathname === "/save" && req.method === "POST") {
    await handleSave(res, await readJsonBody(req));
    return;
  }
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

    res.writeHead(400, { "Content-Type": "application/json" }).end(rpcError("Missing or unknown mcp-session-id"));
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" }).end(rpcError(`Internal error: ${(err as Error).message}`));
    }
  }
});

const probe = await probeEnvironment();
http.listen(PORT, () => {
  console.error(`openscad-mcp: Streamable HTTP listening on http://localhost:${PORT}/mcp`);
  console.error("Add that URL to Claude Desktop / claude.ai as a custom connector for the inline 3D viewer.");
  console.error(`STL repair Space: ${process.env.STL_REPAIR_URL ?? "https://var2-stl-repair.hf.space"}  |  exports: ${EXPORT_DIR}`);
  console.error(probe.report);
});
