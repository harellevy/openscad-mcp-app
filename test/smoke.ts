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

  // Tool discovery
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  assert(
    JSON.stringify(names) === JSON.stringify(["check_model", "export_model", "render_model"]),
    `unexpected tool list: ${names.join(", ")}`,
  );
  console.log("PASS tool discovery:", names.join(", "));

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
  console.log("PASS render_model:", textOf(render).split("\n")[0], `(PNGs in ${RENDER_DIR})`);

  // 4. render_model honors -D parameter overrides
  const paramRender: any = await client.callTool({
    name: "render_model",
    arguments: { code: DEMO, parameters: { size: 40 }, width: 320, height: 240 },
  });
  assert(!paramRender.isError, `param render should succeed, got: ${textOf(paramRender)}`);
  console.log("PASS render_model with -D parameters");

  // 5. export_model writes an STL
  const exp: any = await client.callTool({
    name: "export_model",
    arguments: { code: DEMO, format: "stl", filename: "smoke-bracket" },
  });
  assert(!exp.isError, `export should succeed, got: ${textOf(exp)}`);
  assert(/Exported STL/.test(textOf(exp)), "export summary missing");
  console.log("PASS export_model:", textOf(exp).split("\n")[0]);

  await client.close();
  console.log("\nALL SMOKE TESTS PASSED");
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
