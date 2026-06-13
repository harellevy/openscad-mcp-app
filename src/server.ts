import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import { VIEWS, VIEW_NAMES, type ViewName } from "./cameras.js";
import { defineArgs, diagnostics, probeEnvironment, runOpenscad, toBinaryStl } from "./openscad.js";
import { VIEWER_MIME, VIEWER_URI, buildViewerHtml } from "./viewer.js";

const SERVER_VERSION = "0.2.2";

// Default to a guaranteed-writable dir. The server's cwd when spawned by a host
// (e.g. Claude Desktop) is often "/", so cwd-relative "exports" becomes the
// unwritable "/exports". Bytes are returned in the result regardless of disk.
const EXPORT_DIR =
  process.env.OPENSCAD_MCP_EXPORT_DIR ?? path.join(tmpdir(), "openscad-mcp-exports");

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
  .union([z.string(), z.array(z.string())])
  .optional()
  .describe(
    "Complete OpenSCAD source (the whole program, not a fragment). Accepts a single string OR an " +
      "array of lines (joined with newlines). Prefer the array form for long programs — it avoids " +
      "the JSON-escaping and truncation problems of one giant single-line string. " +
      "Provide either `code` or `code_path`.",
  );

const codePathSchema = z
  .string()
  .optional()
  .describe(
    "Absolute path to a .scad file to render instead of inlining source. Best for large models: " +
      "write the file with your editor/file tool, then pass its path here. The file must be readable " +
      "by the server process. Provide either `code` or `code_path`.",
  );

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

/**
 * Resolve the OpenSCAD source for a call. Source may arrive inline as a string,
 * as an array of lines (joined with newlines — friendlier to JSON encoding for
 * long programs), or as a path to a .scad file the caller already wrote.
 */
async function resolveSource(
  code: string | string[] | undefined,
  codePath: string | undefined,
): Promise<{ code: string } | { error: string }> {
  if (codePath) {
    try {
      return { code: await readFile(codePath, "utf8") };
    } catch (err) {
      return { error: `Could not read code_path '${codePath}': ${(err as Error).message}` };
    }
  }
  if (code !== undefined) {
    const text = Array.isArray(code) ? code.join("\n") : code;
    if (text.trim().length === 0) return { error: "`code` is empty." };
    return { code: text };
  }
  return {
    error: "Provide either `code` (OpenSCAD source) or `code_path` (path to a .scad file).",
  };
}

type ViewerFields = { stlBase64?: string; stlGzipBase64?: string; meshOmitted?: boolean; tris?: number };

/**
 * Compact, size-bounded mesh for the viewer's structuredContent. OpenSCAD emits
 * ASCII STL (~5x bigger than binary); we re-encode to binary, gzip if still
 * large (the iframe inflates natively via DecompressionStream), and omit the
 * mesh entirely when genuinely huge so the result can't exceed the host's cap.
 */
function meshPayload(stlOutput: Buffer): ViewerFields {
  const bin = toBinaryStl(stlOutput);
  const tris = Math.max(0, Math.round((bin.length - 84) / 50));
  const b64 = bin.toString("base64");
  if (b64.length <= 600_000) return { stlBase64: b64 };
  const gz = gzipSync(bin).toString("base64");
  if (gz.length <= 700_000) return { stlGzipBase64: gz };
  return { meshOmitted: true, tris };
}

/**
 * Hard guarantee the serialized tool result stays under the host's 1MB limit,
 * shedding the heaviest / most-redundant payload first: mesh → extra view
 * images → the structuredContent PNG → remaining images.
 */
function clampResult<T extends { content: Array<{ type: string }>; structuredContent?: Record<string, unknown> }>(
  result: T,
): T {
  const LIMIT = 950_000;
  const size = () => Buffer.byteLength(JSON.stringify(result));
  if (size() <= LIMIT) return result;
  const sc = result.structuredContent;
  if (sc && (sc.stlBase64 || sc.stlGzipBase64 || sc.fileBase64)) {
    delete sc.stlBase64;
    delete sc.stlGzipBase64;
    delete sc.fileBase64;
    sc.meshOmitted = true;
    if (size() <= LIMIT) return result;
  }
  const images = result.content.filter((c) => c.type === "image");
  if (images.length > 1) {
    result.content = [images[0], ...result.content.filter((c) => c.type !== "image")];
    if (size() <= LIMIT) return result;
  }
  if (sc && sc.pngBase64) {
    delete sc.pngBase64;
    if (size() <= LIMIT) return result;
  }
  result.content = result.content.filter((c) => c.type !== "image");
  return result;
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "openscad-mcp", version: SERVER_VERSION });

  server.registerTool(
    "diagnose",
    {
      title: "Diagnose the OpenSCAD environment",
      description:
        "Report whether the server can locate the OpenSCAD binary (and xvfb-run on headless Linux), " +
        "including versions and the exact paths searched. Call this FIRST if check/render/export fail " +
        "with a 'not found' or 'cannot run' error — it shows whether the problem is a missing install " +
        "or a PATH issue, and what to set OPENSCAD_PATH to.",
      inputSchema: {},
    },
    async () => {
      const probe = await probeEnvironment();
      const status = probe.ok ? "READY" : "NOT READY";
      // Version + export dir make "am I running the new build?" answerable in one
      // call: the old scaffold reports export dir "/exports"; >=0.2.0 reports a
      // $TMPDIR path and includes view_model + the inline viewer.
      const header =
        `openscad-mcp v${SERVER_VERSION} (build with view_model + inline viewer)\n` +
        `Export dir: ${EXPORT_DIR}`;
      return {
        content: [
          { type: "text", text: `${header}\nOpenSCAD MCP environment: ${status}\n${probe.report}` } satisfies TextBlock,
        ],
      };
    },
  );

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
        code_path: codePathSchema,
        parameters: parametersSchema,
      },
    },
    async ({ code, code_path, parameters }) => {
      const src = await resolveSource(code, code_path);
      if ("error" in src) return errorResult(src.error);
      const result = await runOpenscad(src.code, "csg", defineArgs(parameters));
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
        "Render OpenSCAD source and mount it in an interactive 3D viewer inline in the chat (orbit/zoom), " +
        "with PNG preview(s) as a fallback. Call this after every meaningful code change. " +
        "Uses fast OpenCSG preview for the PNG by default; set full_render=true for slower, artifact-free CGAL " +
        "rendering (useful when difference()/intersection() previews look wrong). The 3D panel is freely " +
        "orbitable, so the camera views only affect the PNG fallback.",
      inputSchema: {
        code: codeSchema,
        code_path: codePathSchema,
        views: z
          .preprocess(
            (v) => (typeof v === "string" ? [v] : v),
            z.array(z.enum(VIEW_NAMES)),
          )
          .default(["diagonal"])
          .describe(
            "Camera preset(s) to render, one image per view. A single string is also accepted. " +
              `Valid: ${VIEW_NAMES.join(", ")}.`,
          ),
        width: z.coerce.number().int().min(64).max(1920).default(800).describe("Image width in pixels."),
        height: z.coerce.number().int().min(64).max(1920).default(600).describe("Image height in pixels."),
        color_scheme: z
          .string()
          .optional()
          .describe(
            `OpenSCAD color scheme (unknown values fall back to Cornfield). Valid: ${COLOR_SCHEMES.join(", ")}.`,
          ),
        full_render: z
          .boolean()
          .default(false)
          .describe("Force a full CGAL render instead of the fast preview."),
        parameters: parametersSchema,
      },
      _meta: { ui: { resourceUri: VIEWER_URI, visibility: ["model", "app"] } },
    },
    async ({ code, code_path, views, width, height, color_scheme, full_render, parameters }) => {
      const src = await resolveSource(code, code_path);
      if ("error" in src) return errorResult(src.error);

      // Be forgiving: dedupe views, cap at 7, fall back on an unknown color scheme.
      const viewList = [...new Set(views as ViewName[])].slice(0, 7);
      const scheme = (COLOR_SCHEMES as readonly string[]).includes(color_scheme ?? "")
        ? (color_scheme as string)
        : "Cornfield";

      const content: Array<TextBlock | ImageBlock> = [];
      let warnings: string[] = [];
      let totalMs = 0;
      let firstPng = "";

      for (const view of viewList) {
        const args = [
          "--imgsize",
          `${width},${height}`,
          "--camera",
          VIEWS[view],
          "--autocenter",
          "--viewall",
          "--colorscheme",
          scheme,
          ...(full_render ? ["--render"] : []),
          ...defineArgs(parameters),
        ];
        const result = await runOpenscad(src.code, "png", args);
        if (result.exitCode !== 0 || !result.output) {
          return errorResult(
            `Render failed (view: ${view}):\n${describeFailure(result.stderr)}`,
          );
        }
        totalMs += result.durationMs;
        warnings = diagnostics(result.stderr); // identical across views; keep the latest
        const pngB64 = result.output.toString("base64");
        if (!firstPng) firstPng = pngB64;
        content.push({ type: "image", data: pngB64, mimeType: "image/png" });
      }

      // Also export a mesh so the result mounts the inline interactive 3D viewer
      // (free orbit/zoom — not just the fixed camera angles). The PNG(s) above
      // stay as the fallback rung for hosts without MCP-Apps support. Best-effort:
      // a mesh failure still returns the PNGs.
      let structuredContent: Record<string, unknown> | undefined;
      let viewerMeta: { ui: { resourceUri: string; visibility: string[] } } | undefined;
      let meshOmitted = false;
      try {
        const stl = await runOpenscad(src.code, "stl", defineArgs(parameters));
        if (stl.exitCode === 0 && stl.output) {
          const mesh = meshPayload(stl.output);
          meshOmitted = !!mesh.meshOmitted;
          structuredContent = {
            kind: "3d",
            state: "completed",
            name: "model",
            stats: `STL ${formatBytes(stl.output.length)}`,
            pngBase64: firstPng,
            ...mesh,
          };
          viewerMeta = { ui: { resourceUri: VIEWER_URI, visibility: ["model", "app"] } };
        }
      } catch {
        /* mesh export is best-effort; the PNG fallback is still returned */
      }

      const summary = [
        `Rendered ${viewList.length} view(s) [${viewList.join(", ")}] at ${width}x${height} ` +
          `(${full_render ? "full CGAL render" : "fast preview"}) in ${totalMs} ms.` +
          (viewerMeta && !meshOmitted ? " Interactive 3D viewer ready (orbit/zoom)." : "") +
          (meshOmitted ? " (Model too large for inline 3D — showing image; export_model for the STL.)" : ""),
        ...(warnings.length > 0 ? ["Diagnostics:", ...warnings] : []),
      ].join("\n");
      content.push({ type: "text", text: summary });

      return clampResult({
        content,
        ...(structuredContent ? { structuredContent } : {}),
        ...(viewerMeta ? { _meta: viewerMeta } : {}),
      });
    },
  );

  server.registerTool(
    "export_model",
    {
      title: "Export OpenSCAD model",
      description:
        "Export the model as a mesh/solid file (STL, OFF, AMF, 3MF, or CSG) for 3D printing or further processing. " +
        "Runs a full geometry render. Call this once the previews look right. STL exports also open in the " +
        "interactive 3D viewer (rotate/zoom + a download button); the mesh bytes are returned regardless of disk.",
      inputSchema: {
        code: codeSchema,
        code_path: codePathSchema,
        format: z
          .string()
          .optional()
          .describe(`Output file format (case-insensitive, default stl). Valid: ${EXPORT_FORMATS.join(", ")}.`),
        filename: z
          .string()
          .optional()
          .describe("Output file name (basename only; extension is forced to match format)."),
        parameters: parametersSchema,
      },
      _meta: { ui: { resourceUri: VIEWER_URI, visibility: ["model", "app"] } },
    },
    async ({ code, code_path, format, filename, parameters }) => {
      try {
        const src = await resolveSource(code, code_path);
        if ("error" in src) return errorResult(src.error);

        const fmt = (format ?? "stl").toLowerCase().replace(/^\./, "");
        if (!(EXPORT_FORMATS as readonly string[]).includes(fmt)) {
          return errorResult(`Unknown format '${format}'. Valid: ${EXPORT_FORMATS.join(", ")}.`);
        }

        const result = await runOpenscad(src.code, fmt, defineArgs(parameters));
        if (result.exitCode !== 0 || !result.output) {
          return errorResult(`Export failed:\n${describeFailure(result.stderr)}`);
        }

        const stem = (filename ? path.basename(filename) : `model-${Date.now()}`)
          .replace(/\.[A-Za-z0-9]+$/, "")
          .replace(/[^\w.-]+/g, "_") || "model";

        // Best-effort disk write — never throw if the dir is read-only; the bytes
        // are returned in the result either way (works in any sandbox).
        let savedTo: string | null = null;
        let saveError: string | null = null;
        try {
          await mkdir(EXPORT_DIR, { recursive: true });
          savedTo = path.join(EXPORT_DIR, `${stem}.${fmt}`);
          await writeFile(savedTo, result.output);
        } catch (e) {
          savedTo = null;
          saveError = (e as Error).message;
        }

        const meshStats = result.stderr
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => /^(Top level object|Facets:|Vertices:|Simple:)/.test(line));
        const text = [
          `Exported ${fmt.toUpperCase()} (${formatBytes(result.output.length)}) in ${result.durationMs} ms.`,
          savedTo
            ? `Saved to ${savedTo}`
            : `Not written to disk (${saveError}). Use the viewer's Download button (STL) or the returned bytes.`,
          ...meshStats,
          ...diagnostics(result.stderr),
        ].join("\n");

        const structuredContent: Record<string, unknown> = {
          kind: fmt === "stl" ? "3d" : "file",
          state: "completed",
          name: stem,
          format: fmt,
          savedTo,
          stats: `${fmt.toUpperCase()} ${formatBytes(result.output.length)}`,
        };
        // STL feeds the inline 3D viewer (compact binary, rotate/zoom + download,
        // no disk needed). For other formats, only carry the bytes if the disk
        // write failed AND they're small enough to inline safely.
        if (fmt === "stl") {
          Object.assign(structuredContent, meshPayload(result.output));
        } else if (!savedTo) {
          const b64 = result.output.toString("base64");
          if (b64.length <= 600_000) structuredContent.fileBase64 = b64;
        }

        const out: {
          content: TextBlock[];
          structuredContent: Record<string, unknown>;
          _meta?: Record<string, unknown>;
        } = {
          content: [{ type: "text", text }],
          structuredContent,
        };
        if (fmt === "stl") {
          out._meta = { ui: { resourceUri: VIEWER_URI, visibility: ["model", "app"] } };
        }
        return clampResult(out);
      } catch (e) {
        // Defensive: a thrown error (timeout, kill, fs) returns a clean result
        // instead of bubbling up and risking the session.
        return errorResult(`export_model failed: ${(e as Error).message}`);
      }
    },
  );

  // Interactive 3D viewer (MCP Apps / SEP-1865). The HTML resource is static;
  // view_model ships the mesh in its result _meta, which the host forwards to
  // the iframe via a ui/notifications/tool-result postMessage.
  server.registerResource(
    "model-viewer",
    VIEWER_URI,
    {
      title: "OpenSCAD 3D viewer",
      description: "Interactive 3D model viewer (rotate/zoom) with STL/PNG download buttons.",
      mimeType: VIEWER_MIME,
      // prefersBorder:true keeps claude.ai from wrapping the iframe in an opaque
      // white card (counter-intuitive vs the spec wording, but empirically correct).
      _meta: { ui: { prefersBorder: true } },
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: VIEWER_MIME, text: buildViewerHtml() }],
    }),
  );

  server.registerTool(
    "view_model",
    {
      title: "View model in interactive 3D",
      description:
        "Render the model AND open it in an interactive 3D viewer panel in the chat — rotate, zoom, and " +
        "download the STL/PNG. Use this when the user wants to SEE and inspect the result, not just a static " +
        "image. Returns a PNG too, so hosts that can't render the panel still show the preview.",
      inputSchema: {
        code: codeSchema,
        code_path: codePathSchema,
        view: z
          .enum(VIEW_NAMES)
          .default("diagonal")
          .describe("Camera preset for the PNG thumbnail/fallback. The 3D panel is freely orbitable."),
        width: z.coerce.number().int().min(64).max(1920).default(900).describe("Preview width in pixels."),
        height: z.coerce.number().int().min(64).max(1920).default(700).describe("Preview height in pixels."),
        color_scheme: z
          .string()
          .optional()
          .describe(`Color scheme for the PNG (unknown falls back to Cornfield). Valid: ${COLOR_SCHEMES.join(", ")}.`),
        name: z.string().optional().describe("Display name / download filename stem for the model."),
        parameters: parametersSchema,
      },
      _meta: { ui: { resourceUri: VIEWER_URI, visibility: ["model", "app"] } },
    },
    async ({ code, code_path, view, width, height, color_scheme, name, parameters }) => {
      const src = await resolveSource(code, code_path);
      if ("error" in src) return errorResult(src.error);
      const scheme = (COLOR_SCHEMES as readonly string[]).includes(color_scheme ?? "")
        ? (color_scheme as string)
        : "Cornfield";

      const png = await runOpenscad(src.code, "png", [
        "--imgsize",
        `${width},${height}`,
        "--camera",
        VIEWS[view as ViewName],
        "--autocenter",
        "--viewall",
        "--colorscheme",
        scheme,
        ...defineArgs(parameters),
      ]);
      if (png.exitCode !== 0 || !png.output) {
        return errorResult(`Render failed:\n${describeFailure(png.stderr)}`);
      }

      const stl = await runOpenscad(src.code, "stl", defineArgs(parameters));
      if (stl.exitCode !== 0 || !stl.output) {
        return errorResult(`Mesh export failed:\n${describeFailure(stl.stderr)}`);
      }

      const stem = (name ? name : "model").replace(/[^\w.-]+/g, "_") || "model";
      const stats = `STL ${formatBytes(stl.output.length)}, rendered in ${png.durationMs + stl.durationMs} ms`;
      const warnings = diagnostics(png.stderr).concat(diagnostics(stl.stderr));
      const mesh = meshPayload(stl.output);

      // structuredContent is the channel the host pushes to the iframe (it is not
      // shown to the model); _meta.ui links the tool to its UI resource.
      const content: Array<TextBlock | ImageBlock> = [
        { type: "image", data: png.output.toString("base64"), mimeType: "image/png" },
        {
          type: "text",
          text:
            `Interactive 3D viewer ready for "${stem}" (rotate/zoom + download in the panel). ${stats}.` +
            (mesh.meshOmitted ? " (Model too large for inline 3D — showing the image instead.)" : "") +
            (warnings.length > 0 ? `\nDiagnostics:\n${warnings.join("\n")}` : ""),
        },
      ];
      return clampResult({
        content,
        structuredContent: {
          kind: "3d",
          state: "completed",
          name: stem,
          stats: stats,
          pngBase64: png.output.toString("base64"),
          ...mesh,
        },
        _meta: { ui: { resourceUri: VIEWER_URI, visibility: ["model", "app"] } },
      });
    },
  );

  return server;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
