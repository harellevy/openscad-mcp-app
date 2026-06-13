import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface OpenscadResult {
  exitCode: number;
  stderr: string;
  /** Contents of the produced output file, when one was written. */
  output?: Buffer;
  durationMs: number;
}

const BIN = process.env.OPENSCAD_PATH ?? "openscad";
const TIMEOUT_MS = Number(process.env.OPENSCAD_TIMEOUT_MS ?? 120_000);

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
 * invocation is wrapped in `xvfb-run`; mesh/CSG export does not need a display.
 */
export async function runOpenscad(
  code: string,
  outExt: string,
  extraArgs: string[] = [],
): Promise<OpenscadResult> {
  const dir = await mkdtemp(path.join(tmpdir(), "openscad-mcp-"));
  const scadFile = path.join(dir, "model.scad");
  const outFile = path.join(dir, `out.${outExt}`);
  await writeFile(scadFile, code, "utf8");

  let command = BIN;
  let args = ["-o", outFile, ...extraArgs, scadFile];
  if (outExt === "png" && process.platform === "linux" && !process.env.DISPLAY) {
    args = ["-a", command, ...args];
    command = "xvfb-run";
  }

  const started = Date.now();
  try {
    const { exitCode, stderr } = await execute(command, args);
    const output = await readFile(outFile).catch(() => undefined);
    return { exitCode, stderr, output, durationMs: Date.now() - started };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function execute(
  command: string,
  args: string[],
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
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
            `'${command}' was not found. Install OpenSCAD (and xvfb on headless Linux) or set OPENSCAD_PATH.`,
          ),
        );
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stderr });
    });
  });
}
