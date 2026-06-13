import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const TIMEOUT_MS = Number(process.env.OPENSCAD_TIMEOUT_MS ?? 120_000);

/**
 * Absolute locations to probe when `openscad` isn't on PATH. A stdio MCP server
 * inherits the (often minimal) environment of whatever host spawned it, so the
 * binary frequently exists yet isn't on the inherited PATH — especially with
 * Homebrew (/opt/homebrew) or the macOS app bundle.
 */
const OPENSCAD_CANDIDATES = [
  "/usr/bin/openscad",
  "/usr/local/bin/openscad",
  "/opt/homebrew/bin/openscad",
  "/snap/bin/openscad",
  "/var/lib/flatpak/exports/bin/org.openscad.OpenSCAD",
  "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD",
];

const NEEDS_DISPLAY = process.platform === "linux" && !process.env.DISPLAY;

export interface OpenscadResult {
  exitCode: number;
  stderr: string;
  /** Contents of the produced output file, when one was written. */
  output?: Buffer;
  durationMs: number;
}

export interface Probe {
  ok: boolean;
  openscad: string | null;
  version: string | null;
  xvfbRun: string | null;
  needsDisplay: boolean;
  report: string;
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a bare command name against PATH (pure Node — no dependency on `which`). */
function onPath(cmd: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, cmd);
    if (isExecutable(full)) return full;
  }
  return null;
}

let cachedOpenscad: string | null | undefined;

/** Absolute path to the OpenSCAD binary, or null if it can't be located. */
export function resolveOpenscad(): string | null {
  if (cachedOpenscad !== undefined) return cachedOpenscad;
  const override = process.env.OPENSCAD_PATH;
  if (override) {
    cachedOpenscad =
      path.isAbsolute(override) || override.includes(path.sep)
        ? isExecutable(override)
          ? override
          : null
        : onPath(override);
  } else {
    cachedOpenscad = onPath("openscad") ?? OPENSCAD_CANDIDATES.find(isExecutable) ?? null;
  }
  return cachedOpenscad;
}

let cachedXvfb: string | null | undefined;

/** Absolute path to `xvfb-run`, or null. Only relevant for PNG on headless Linux. */
export function resolveXvfbRun(): string | null {
  if (cachedXvfb === undefined) cachedXvfb = onPath("xvfb-run");
  return cachedXvfb;
}

function probeVersion(bin: string): Promise<{ version: string | null; detail: string }> {
  return new Promise((resolve) => {
    let out = "";
    let spawnErr = "";
    const child = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString())); // OpenSCAD prints version to stderr
    child.on("error", (e: Error) => (spawnErr = e.message));
    child.on("close", (code, signal) => {
      const match = out.match(/OpenSCAD version .*/i);
      if (match) return resolve({ version: match[0].trim(), detail: "" });
      let detail = spawnErr || out.trim().split(/\r?\n/)[0] || "";
      if (!detail && signal) {
        detail =
          `the binary was killed by signal ${signal} before producing output` +
          (process.platform === "darwin"
            ? " — on macOS this is almost always Gatekeeper blocking an unverified binary, " +
              "or an Intel-only build running without Rosetta on Apple Silicon"
            : "");
      }
      resolve({ version: null, detail: detail || `exited with code ${code}` });
    });
  });
}

/** Inspect the environment and produce a human-readable status report. */
export async function probeEnvironment(): Promise<Probe> {
  const openscad = resolveOpenscad();
  const xvfbRun = resolveXvfbRun();
  const ver = openscad
    ? await probeVersion(openscad).catch(() => ({ version: null, detail: "version probe threw" }))
    : { version: null, detail: "" };

  const lines: string[] = [];
  if (openscad) {
    lines.push(`OpenSCAD: ${openscad}${ver.version ? ` — ${ver.version}` : ""}`);
    if (!ver.version) {
      lines.push(`  WARNING: found the binary but it would not run: ${ver.detail}`);
      if (process.platform === "darwin") {
        lines.push(
          "  macOS fixes: (a) de-quarantine — xattr -dr com.apple.quarantine on the binary/app, " +
            "or approve it in System Settings > Privacy & Security; " +
            "(b) install Rosetta for Intel-only builds — softwareupdate --install-rosetta --agree-to-license; " +
            "(c) or install a native arm64 build (e.g. a current OpenSCAD snapshot).",
        );
      }
    }
  } else {
    lines.push("OpenSCAD: NOT FOUND.");
    lines.push(`  PATH seen by server: ${process.env.PATH ?? "<empty>"}`);
    lines.push(`  Also probed: ${OPENSCAD_CANDIDATES.join(", ")}`);
    lines.push("  Fix: install OpenSCAD in THIS environment, or set OPENSCAD_PATH to its absolute path.");
  }
  if (NEEDS_DISPLAY) {
    lines.push(
      xvfbRun
        ? `xvfb-run: ${xvfbRun} — headless PNG rendering is wrapped automatically.`
        : "xvfb-run: NOT FOUND. Headless Linux needs it for render_model (PNG). " +
            "check_model and export_model still work without it. Fix: install the 'xvfb' package.",
    );
  }
  return {
    ok: !!openscad && !!ver.version && (!NEEDS_DISPLAY || !!xvfbRun),
    openscad,
    version: ver.version,
    xvfbRun,
    needsDisplay: NEEDS_DISPLAY,
    report: lines.join("\n"),
  };
}

/** Translate a parameters map into OpenSCAD `-D name=value` overrides. */
export function defineArgs(
  parameters?: Record<string, string | number | boolean>,
): string[] {
  if (!parameters) return [];
  return Object.entries(parameters).flatMap(([name, value]) => {
    const literal = typeof value === "string" ? JSON.stringify(value) : String(value);
    return ["-D", `${name}=${literal}`];
  });
}

/** Lines from stderr worth surfacing to the caller (errors, warnings, echoes). */
export function diagnostics(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(ERROR|WARNING|TRACE|ECHO)\b/i.test(line));
}

/**
 * Run OpenSCAD over `code`, producing a single output file with extension
 * `outExt`. PNG rendering needs an OpenGL context, so on headless Linux the
 * invocation is wrapped in `xvfb-run` when available (mesh/CSG export does not
 * need a display). The binary is located via resolveOpenscad(), so a minimal
 * inherited PATH is not a problem as long as OpenSCAD is installed.
 */
export async function runOpenscad(
  code: string,
  outExt: string,
  extraArgs: string[] = [],
): Promise<OpenscadResult> {
  const openscad = resolveOpenscad();
  if (!openscad) {
    const probe = await probeEnvironment();
    throw new Error(`Cannot run OpenSCAD.\n${probe.report}`);
  }

  const dir = await mkdtemp(path.join(tmpdir(), "openscad-mcp-"));
  const scadFile = path.join(dir, "model.scad");
  const outFile = path.join(dir, `out.${outExt}`);
  await writeFile(scadFile, code, "utf8");

  let command = openscad;
  let args = ["-o", outFile, ...extraArgs, scadFile];
  const env: NodeJS.ProcessEnv = { ...process.env };

  if (outExt === "png" && NEEDS_DISPLAY) {
    const xvfb = resolveXvfbRun();
    if (xvfb) {
      args = ["-a", command, ...args];
      command = xvfb;
    } else {
      // Best effort without xvfb: ask Qt for an offscreen platform. May still
      // fail to acquire a GL context; the failure (and the fix) is in stderr.
      env.QT_QPA_PLATFORM = env.QT_QPA_PLATFORM ?? "offscreen";
    }
  }

  const started = Date.now();
  try {
    const { exitCode, stderr } = await execute(command, args, env);
    const output = await readFile(outFile).catch(() => undefined);
    return { exitCode, stderr, output, durationMs: Date.now() - started };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function execute(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], env });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`OpenSCAD timed out after ${TIMEOUT_MS} ms`));
    }, TIMEOUT_MS);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(
          new Error(
            `'${command}' could not be executed (ENOENT). ` +
              (command.includes("xvfb")
                ? "Install the 'xvfb' package for headless PNG rendering."
                : "Install OpenSCAD or set OPENSCAD_PATH to its absolute path."),
          ),
        );
      } else {
        reject(err);
      }
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      let out = stderr;
      if (code === null && signal) {
        out +=
          `\n[OpenSCAD was killed by signal ${signal} before finishing.` +
          (process.platform === "darwin"
            ? " On macOS this is typically Gatekeeper blocking an unverified binary, or an Intel-only " +
              "build running without Rosetta on Apple Silicon. Fix: de-quarantine the binary " +
              "(xattr -dr com.apple.quarantine <path>) / approve it in System Settings > Privacy & Security, " +
              "or install Rosetta / a native arm64 build.]"
            : "]");
      }
      resolve({ exitCode: code ?? -1, stderr: out });
    });
  });
}
