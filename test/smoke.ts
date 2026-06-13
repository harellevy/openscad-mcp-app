/**
 * End-to-end smoke test: spawns the built server over stdio with a real MCP
 * client and exercises all three tools against the real OpenSCAD binary.
 * Run with: npm test
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEMO = `// demo bracket
size = 20;
difference() {
  cube([size, size, 8], center = true);
  cylinder(d = 8, h = 20, center = true, $fn = 48);
}
`;

const BROKEN = "cube([10, 10, 10);"; // unbalanced bracket -> parse error

const RENDER_DIR = "/tmp/smoke-renders";

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

function textOf(result: any): string {
  return (result.content as any[])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...process.env, OPENSCAD_MCP_EXPORT_DIR: "/tmp/smoke-exports" },
  });
  const client = new Client({ name: "smoke-test", version: "0.0.0" });
  await client.connect(transport);

  // A second server instance whose export dir can never be created (its parent
  // is a file → ENOTDIR even as root), to prove export survives an unwritable dir.
  const roTransport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...process.env, OPENSCAD_MCP_EXPORT_DIR: "/etc/hostname/exports" },
  });
  const roClient = new Client({ name: "smoke-test-ro", version: "0.0.0" });
  await roClient.connect(roTransport);

  // Tool discovery
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  assert(
    JSON.stringify(names) ===
      JSON.stringify(["check_model", "diagnose", "export_model", "render_model", "view_model"]),
    `unexpected tool list: ${names.join(", ")}`,
  );
  console.log("PASS tool discovery:", names.join(", "));

  // MCP Apps wiring (SEP-1865): the UI resource, the tool->resource link, and
  // the mesh payload the host forwards to the iframe.
  const VIEWER_URI = "ui://openscad/viewer";
  const VIEWER_MIME = "text/html;profile=mcp-app";

  const resources: any = await client.listResources();
  const viewer = (resources.resources as any[]).find((r) => r.uri === VIEWER_URI);
  assert(viewer, `resource ${VIEWER_URI} not listed`);
  assert(viewer.mimeType === VIEWER_MIME, `viewer mimeType is ${viewer.mimeType}, expected ${VIEWER_MIME}`);
  const read: any = await client.readResource({ uri: VIEWER_URI });
  const html = read.contents[0].text as string;
  assert(/webgl/i.test(html) && /tool-result/.test(html), "viewer HTML missing WebGL renderer / handshake markers");
  assert(!/https?:\/\//.test(html.replace(/ui\/\/[^"'\s]*/g, "")), "viewer HTML must not load any external (http) resources");
  console.log("PASS MCP Apps resource:", VIEWER_URI, `(${VIEWER_MIME}, ${html.length} bytes)`);

  const viewTool = tools.tools.find((t) => t.name === "view_model");
  assert((viewTool as any)?._meta?.ui?.resourceUri === VIEWER_URI, "view_model is not linked to the UI resource via _meta.ui.resourceUri");
  console.log("PASS view_model linked to UI resource via _meta.ui.resourceUri");

  const viewed: any = await client.callTool({
    name: "view_model",
    arguments: { code: DEMO, name: "smoke-cube", width: 400, height: 300 },
  });
  assert(!viewed.isError, `view_model should succeed, got: ${textOf(viewed)}`);
  assert((viewed.content as any[]).some((c) => c.type === "image"), "view_model should include a PNG fallback image");
  const payload = viewed.structuredContent;
  assert(payload?.stlBase64 && payload?.pngBase64, "view_model structuredContent missing stl/png payload");
  assert((viewed as any)._meta?.ui?.resourceUri === VIEWER_URI, "view_model result _meta.ui.resourceUri missing");
  const stlBytes = Buffer.from(payload.stlBase64, "base64");
  assert(stlBytes.length > 84, "decoded STL too small to be valid");
  assert(Buffer.from(payload.pngBase64, "base64").subarray(1, 4).toString() === "PNG", "png payload is not a PNG");
  console.log("PASS view_model 3D payload:", `${stlBytes.length}-byte STL + PNG in _meta`);

  // 0. diagnose reports a ready environment here
  const diag: any = await client.callTool({ name: "diagnose", arguments: {} });
  assert(!diag.isError, `diagnose should not error, got: ${textOf(diag)}`);
  assert(/READY/.test(textOf(diag)), `diagnose should report READY, got: ${textOf(diag)}`);
  assert(/OpenSCAD: \//.test(textOf(diag)), "diagnose should report the resolved binary path");
  console.log("PASS diagnose:", textOf(diag).split("\n").slice(0, 2).join(" | "));

  // 1. check_model flags broken code
  const bad: any = await client.callTool({ name: "check_model", arguments: { code: BROKEN } });
  assert(bad.isError === true, "broken code should set isError");
  assert(/ERROR/i.test(textOf(bad)), "error text should contain ERROR");
  console.log("PASS check_model (broken):", textOf(bad).split("\n")[1] ?? textOf(bad));

  // 2. check_model passes valid code
  const ok: any = await client.callTool({ name: "check_model", arguments: { code: DEMO } });
  assert(!ok.isError, `valid code should pass, got: ${textOf(ok)}`);
  console.log("PASS check_model (valid):", textOf(ok).split("\n")[0]);

  // 3. render_model returns inline images for multiple views
  const render: any = await client.callTool({
    name: "render_model",
    arguments: { code: DEMO, views: ["diagonal", "top"], width: 640, height: 480 },
  });
  assert(!render.isError, `render should succeed, got: ${textOf(render)}`);
  const images = (render.content as any[]).filter((c) => c.type === "image");
  assert(images.length === 2, `expected 2 images, got ${images.length}`);
  await mkdir(RENDER_DIR, { recursive: true });
  for (const [i, img] of images.entries()) {
    assert(img.mimeType === "image/png", "image should be a PNG");
    const buf = Buffer.from(img.data, "base64");
    assert(buf.subarray(1, 4).toString() === "PNG", "image data should decode to a PNG");
    await writeFile(path.join(RENDER_DIR, `view-${i}.png`), buf);
  }
  assert(Buffer.from(render.structuredContent?.stlBase64 ?? "", "base64").length > 84, "render_model should also return STL bytes for the inline viewer");
  assert((render as any)._meta?.ui?.resourceUri === VIEWER_URI, "render_model should mount the inline viewer via _meta.ui.resourceUri");
  console.log("PASS render_model (inline viewer + PNG fallback):", textOf(render).split("\n")[0], `(PNGs in ${RENDER_DIR})`);

  // 4. render_model honors -D parameter overrides
  const paramRender: any = await client.callTool({
    name: "render_model",
    arguments: { code: DEMO, parameters: { size: 40 }, width: 320, height: 240 },
  });
  assert(!paramRender.isError, `param render should succeed, got: ${textOf(paramRender)}`);
  console.log("PASS render_model with -D parameters");

  // 4c. render_model tolerates loose inputs: bare-string view, string-encoded
  // numbers, and an unknown color scheme (should fall back, not error).
  const loose: any = await client.callTool({
    name: "render_model",
    arguments: { code: DEMO, views: "front", width: "320", height: "240", color_scheme: "nope" },
  });
  assert(!loose.isError, `loose inputs should be tolerated, got: ${textOf(loose)}`);
  assert(
    (loose.content as any[]).filter((c) => c.type === "image").length === 1,
    "expected 1 image from single-string view",
  );
  console.log("PASS render_model tolerant of loose inputs (string view/dims, bad scheme)");

  // 4d. code as an array of lines (joined with newlines) — the JSON-safe form
  // for long programs. Includes a quoted string literal like part = "assembly".
  const arrayCode: any = await client.callTool({
    name: "render_model",
    arguments: {
      code: [
        '// array-form source with a quoted literal',
        'part = "assembly";',
        "size = 15;",
        "cube(size, center = true);",
      ],
      width: 320,
      height: 240,
    },
  });
  assert(!arrayCode.isError, `array-form code should render, got: ${textOf(arrayCode)}`);
  console.log("PASS render_model accepts array-of-lines code (quotes intact)");

  // 4e. code_path — render a .scad file on disk instead of inlining source.
  const pathRender: any = await client.callTool({
    name: "render_model",
    arguments: { code_path: path.resolve("examples/enclosure.scad"), width: 320, height: 240 },
  });
  assert(!pathRender.isError, `code_path should render, got: ${textOf(pathRender)}`);
  console.log("PASS render_model via code_path");

  // 4f. neither code nor code_path -> clear, non-fatal error result
  const missing: any = await client.callTool({ name: "render_model", arguments: {} });
  assert(missing.isError === true, "missing source should set isError");
  assert(/code_path/.test(textOf(missing)), "error should mention code_path");
  console.log("PASS render_model reports missing source clearly");

  // 5. export_model writes an STL AND returns the bytes + viewer link
  const exp: any = await client.callTool({
    name: "export_model",
    arguments: { code: DEMO, format: "stl", filename: "smoke-bracket" },
  });
  assert(!exp.isError, `export should succeed, got: ${textOf(exp)}`);
  assert(/Exported STL/.test(textOf(exp)), "export summary missing");
  assert(Buffer.from(exp.structuredContent?.stlBase64 ?? "", "base64").length > 84, "export must return STL bytes in structuredContent");
  assert((exp as any)._meta?.ui?.resourceUri === VIEWER_URI, "STL export should link the inline viewer");
  console.log("PASS export_model (bytes + viewer):", textOf(exp).split("\n")[0]);

  // 5b. export_model survives a read-only export dir (bytes still returned)
  const expRO: any = await roClient.callTool({
    name: "export_model",
    arguments: { code: DEMO, format: "stl", filename: "smoke-ro" },
  });
  assert(!expRO.isError, `export must not fail on an unwritable dir, got: ${textOf(expRO)}`);
  assert(Buffer.from(expRO.structuredContent?.stlBase64 ?? "", "base64").length > 84, "bytes must be returned even when disk write fails");
  assert(/Not written to disk/.test(textOf(expRO)), "should note the disk write failure");
  console.log("PASS export_model resilient to read-only dir");

  // 5c. export_model accepts case-insensitive format ("STL" -> stl)
  const expUpper: any = await client.callTool({
    name: "export_model",
    arguments: { code: DEMO, format: "STL", filename: "smoke-upper" },
  });
  assert(!expUpper.isError, `uppercase format should work, got: ${textOf(expUpper)}`);
  console.log("PASS export_model case-insensitive format");

  await client.close();
  await roClient.close();
  console.log("\nALL SMOKE TESTS PASSED");
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
