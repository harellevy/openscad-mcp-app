import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { VIEWS, VIEW_NAMES, type ViewName } from "./cameras.js";
import { defineArgs, diagnostics, runOpenscad } from "./openscad.js";

const SERVER_VERSION = "0.1.0";

const EXPORT_DIR =
  process.env.OPENSCAD_MCP_EXPORT_DIR ?? path.join(process.cwd(), "exports");

const COLOR_SCHEMES = [
  "Cornfield",
  "Metallic",
  "Sunset",
  "Starnight",
  "BeforeDawn",
  "Nature",
  "DeepOcean",
  "Tomorrow",
  "Tomorrow Night",
  "Solarized",
] as const;

const EXPORT_FORMATS = ["stl", "off", "amf", "3mf", "csg"] as const;

const codeSchema = z
  .string()
  .min(1)
  .describe("Complete OpenSCAD source code (the full program, not a fragment).");

const parametersSchema = z
  .record(z.union([z.string(), z.number(), z.boolean()]))
  .optional()
  .describe(
    "Top-level variable overrides applied as `-D name=value` (OpenSCAD customizer style), e.g. {\"wall\": 3, \"part\": \"lid\"}.",
  );

type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image"; data: string; mimeType: string };

function errorResult(message: string): { content: TextBlock[]; isError: true } {
  return { content: [{ type: "text", text: message }], isError: true };
}

function describeFailure(stderr: string): string {
  const diag = diagnostics(stderr);
  return diag.length > 0 ? diag.join("\n") : stderr.trim().slice(-2000) || "unknown error";
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "openscad-mcp", version: SERVER_VERSION });

  server.registerTool(
    "check_model",
    {
      title: "Check OpenSCAD code",
      description:
        "Fast validation of OpenSCAD source: parses and evaluates the model without rendering geometry. " +
        "Call this first after writing or editing code — it returns errors and warnings (with line numbers) in well under a second. " +
        "Follow up with render_model to see the result.",
      inputSchema: {
        code: codeSchema,
        parameters: parametersSchema,
      },
    },
    async ({ code, parameters }) => {
      const result = await runOpenscad(code, "csg", defineArgs(parameters));
      if (result.exitCode !== 0) {
        return errorResult(`OpenSCAD reported errors:\n${describeFailure(result.stderr)}`);
      }
      const diag = diagnostics(result.stderr);
      const text =
        diag.length > 0
          ? `Code is valid (${result.durationMs} ms), with diagnostics:\n${diag.join("\n")}`
          : `Code is valid (${result.durationMs} ms). No warnings.`;
      return { content: [{ type: "text", text } satisfies TextBlock] };
    },
  );

  server.registerTool(
    "render_model",
    {
      title: "Render OpenSCAD preview",
      description:
        "Render OpenSCAD source to PNG preview image(s), returned inline so you can see the model and iterate. " +
        "Call this after every meaningful code change. Request multiple views to inspect geometry from different sides. " +
        "Uses fast OpenCSG preview by default; set full_render=true for slower, artifact-free CGAL rendering " +
        "(useful when difference()/intersection() previews look wrong).",
      inputSchema: {
        code: codeSchema,
        views: z
          .array(z.enum(VIEW_NAMES))
          .min(1)
          .max(7)
          .default(["diagonal"])
          .describe("Camera presets to render, one image per view."),
        width: z.number().int().min(64).max(1920).default(800).describe("Image width in pixels."),
        height: z.number().int().min(64).max(1920).default(600).describe("Image height in pixels."),
        color_scheme: z.enum(COLOR_SCHEMES).default("Cornfield").describe("OpenSCAD color scheme."),
        full_render: z
          .boolean()
          .default(false)
          .describe("Force a full CGAL render instead of the fast preview."),
        parameters: parametersSchema,
      },
    },
    async ({ code, views, width, height, color_scheme, full_render, parameters }) => {
      const content: Array<TextBlock | ImageBlock> = [];
      let warnings: string[] = [];
      let totalMs = 0;

      for (const view of views as ViewName[]) {
        const args = [
          "--imgsize",
          `${width},${height}`,
          "--camera",
          VIEWS[view],
          "--autocenter",
          "--viewall",
          "--colorscheme",
          color_scheme,
          ...(full_render ? ["--render"] : []),
          ...defineArgs(parameters),
        ];
        const result = await runOpenscad(code, "png", args);
        if (result.exitCode !== 0 || !result.output) {
          return errorResult(
            `Render failed (view: ${view}):\n${describeFailure(result.stderr)}`,
          );
        }
        totalMs += result.durationMs;
        warnings = diagnostics(result.stderr); // identical across views; keep the latest
        content.push({
          type: "image",
          data: result.output.toString("base64"),
          mimeType: "image/png",
        });
      }

      const summary = [
        `Rendered ${views.length} view(s) [${views.join(", ")}] at ${width}x${height} ` +
          `(${full_render ? "full CGAL render" : "fast preview"}) in ${totalMs} ms.`,
        ...(warnings.length > 0 ? ["Diagnostics:", ...warnings] : []),
      ].join("\n");
      content.push({ type: "text", text: summary });

      return { content };
    },
  );

  server.registerTool(
    "export_model",
    {
      title: "Export OpenSCAD model",
      description:
        "Export the model as a mesh/solid file (STL, OFF, AMF, 3MF, or CSG) for 3D printing or further processing. " +
        "Runs a full geometry render. Call this once the previews look right.",
      inputSchema: {
        code: codeSchema,
        format: z.enum(EXPORT_FORMATS).default("stl").describe("Output file format."),
        filename: z
          .string()
          .optional()
          .describe("Output file name (basename only; extension is forced to match format)."),
        parameters: parametersSchema,
      },
    },
    async ({ code, format, filename, parameters }) => {
      const result = await runOpenscad(code, format, defineArgs(parameters));
      if (result.exitCode !== 0 || !result.output) {
        return errorResult(`Export failed:\n${describeFailure(result.stderr)}`);
      }

      const stem = (filename ? path.basename(filename) : `model-${Date.now()}`)
        .replace(/\.[A-Za-z0-9]+$/, "")
        .replace(/[^\w.-]+/g, "_") || "model";
      await mkdir(EXPORT_DIR, { recursive: true });
      const outPath = path.join(EXPORT_DIR, `${stem}.${format}`);
      await writeFile(outPath, result.output);

      const stats = result.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^(Top level object|Facets:|Vertices:|Simple:)/.test(line));
      const text = [
        `Exported ${format.toUpperCase()} (${formatBytes(result.output.length)}) to ${outPath} in ${result.durationMs} ms.`,
        ...stats,
        ...diagnostics(result.stderr),
      ].join("\n");

      return { content: [{ type: "text", text } satisfies TextBlock] };
    },
  );

  return server;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
