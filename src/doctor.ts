#!/usr/bin/env node
/**
 * Standalone environment self-test. Run this IN THE SAME container/host where
 * the MCP server runs — it uses the exact binary-resolution logic the server
 * uses, then actually renders a cube (check + PNG + STL) to prove OpenSCAD is
 * not just present but usable. No MCP client involved.
 *
 *   npm run doctor        (or)        node dist/doctor.js
 *
 * Exit code: 0 = ready, 1 = not ready / an operation failed.
 */
import { probeEnvironment, runOpenscad } from "./openscad.js";

const CUBE = "cube([10, 10, 10], center = true);";

async function step(label: string, fn: () => Promise<string>): Promise<boolean> {
  process.stdout.write(`  • ${label} ... `);
  try {
    const detail = await fn();
    console.log(`OK${detail ? ` — ${detail}` : ""}`);
    return true;
  } catch (err) {
    console.log(`FAIL — ${(err as Error).message}`);
    return false;
  }
}

async function main() {
  console.log("openscad-mcp doctor");
  console.log("===================");
  const probe = await probeEnvironment();
  console.log(probe.report);
  console.log("");

  if (!probe.openscad) {
    console.log("RESULT: NOT READY — the OpenSCAD binary was not located (see above).");
    console.log("Install OpenSCAD in THIS environment, or set OPENSCAD_PATH to its absolute path.");
    process.exit(1);
  }

  console.log("Running real operations on a 10mm cube:");
  let ok = true;

  ok =
    (await step("check  (parse + evaluate, no display)", async () => {
      const r = await runOpenscad(CUBE, "csg");
      if (r.exitCode !== 0) throw new Error(r.stderr.trim().slice(-400) || `exit ${r.exitCode}`);
      return `${r.durationMs} ms`;
    })) && ok;

  ok =
    (await step("render (PNG preview — needs a display)", async () => {
      const r = await runOpenscad(CUBE, "png", ["--imgsize", "200,150", "--autocenter", "--viewall"]);
      if (r.exitCode !== 0 || !r.output) throw new Error(r.stderr.trim().slice(-400) || `exit ${r.exitCode}`);
      return `${r.output.length}-byte PNG in ${r.durationMs} ms`;
    })) && ok;

  ok =
    (await step("export (STL — no display)", async () => {
      const r = await runOpenscad(CUBE, "stl");
      if (r.exitCode !== 0 || !r.output) throw new Error(r.stderr.trim().slice(-400) || `exit ${r.exitCode}`);
      return `${r.output.length}-byte STL in ${r.durationMs} ms`;
    })) && ok;

  console.log("");
  console.log(
    ok
      ? "RESULT: READY — OpenSCAD is found and all three operations work here."
      : "RESULT: PARTIAL — binary found, but an operation failed above. If only 'render' failed " +
          "on headless Linux, install the 'xvfb' package; check/export do not need it.",
  );
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
