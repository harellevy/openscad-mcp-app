#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { probeEnvironment } from "./openscad.js";
import { createServer } from "./server.js";

const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);

// stdout is the MCP channel — log to stderr only. Probe at startup so a missing
// binary shows up in the client's MCP logs instead of as a per-call mystery.
const probe = await probeEnvironment();
console.error(`openscad-mcp: server ready on stdio\n${probe.report}`);
if (!probe.ok) {
  console.error(
    "openscad-mcp: WARNING — environment not fully usable (see above). " +
      "Tools will return this diagnosis until OpenSCAD is reachable.",
  );
}
