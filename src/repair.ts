/**
 * Client for the VAR2 STL Repair Space (https://huggingface.co/spaces/var2/stl-repair).
 *
 * The Space is a FastAPI service that takes a GLB mesh and returns a watertight,
 * 3D-print-ready binary STL (it voxelizes to a closed solid). OpenSCAD emits STL,
 * so we convert STL → GLB before uploading. The `/repair-stream-upload` endpoint
 * streams NDJSON: one {type:"progress", stage, percent, message} per stage, then a
 * final {type:"done", stats, stl_b64}.
 *
 * Base URL is configurable via STL_REPAIR_URL (default the public Space).
 */
import { parseStlTriangles } from "./openscad.js";

const SPACE_URL = (process.env.STL_REPAIR_URL ?? "https://var2-stl-repair.hf.space").replace(/\/+$/, "");

export interface RepairEvent {
  type: "progress" | "done" | "error" | string;
  stage?: string;
  percent?: number;
  message?: string;
  stats?: Record<string, unknown>;
  error?: string;
}

/** Convert ASCII/binary STL to a minimal binary glTF (GLB) — POSITION-only mesh. */
export function stlToGlb(stl: Buffer): Buffer {
  const v = parseStlTriangles(stl); // flat [x,y,z, …], 9 numbers per triangle
  const count = Math.floor(v.length / 3); // vertex count
  if (count < 3) throw new Error("STL has no triangles to convert");

  const bin = Buffer.alloc(count * 12); // 3 floats per vertex
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 3; k++) {
      const val = v[i * 3 + k];
      bin.writeFloatLE(val, i * 12 + k * 4);
      if (val < min[k]) min[k] = val;
      if (val > max[k]) max[k] = val;
    }
  }

  const gltf = {
    asset: { version: "2.0", generator: "openscad-mcp" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count, type: "VEC3", min, max }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length, target: 34962 }],
    buffers: [{ byteLength: bin.length }],
  };

  let jsonBuf = Buffer.from(JSON.stringify(gltf), "utf8");
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  if (jsonPad) jsonBuf = Buffer.concat([jsonBuf, Buffer.from(" ".repeat(jsonPad))]);
  const binPad = (4 - (bin.length % 4)) % 4;
  const binBuf = binPad ? Buffer.concat([bin, Buffer.alloc(binPad)]) : bin;

  const total = 12 + 8 + jsonBuf.length + 8 + binBuf.length;
  const out = Buffer.alloc(total);
  let o = 0;
  out.writeUInt32LE(0x46546c67, o); o += 4; // magic "glTF"
  out.writeUInt32LE(2, o); o += 4; // version
  out.writeUInt32LE(total, o); o += 4;
  out.writeUInt32LE(jsonBuf.length, o); o += 4;
  out.writeUInt32LE(0x4e4f534a, o); o += 4; // "JSON"
  jsonBuf.copy(out, o); o += jsonBuf.length;
  out.writeUInt32LE(binBuf.length, o); o += 4;
  out.writeUInt32LE(0x004e4942, o); o += 4; // "BIN\0"
  binBuf.copy(out, o);
  return out;
}

/**
 * Upload a GLB to the repair Space and stream progress. Resolves with the
 * repaired binary STL and the Space's stats once the `done` event arrives.
 */
export async function repairGlb(
  glb: Buffer,
  quality: string,
  onProgress: (e: RepairEvent) => void,
): Promise<{ stl: Buffer; stats: Record<string, unknown> }> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(glb)], { type: "model/gltf-binary" }), "model.glb");
  form.append("quality", quality);

  const res = await fetch(`${SPACE_URL}/repair-stream-upload`, { method: "POST", body: form });
  if (!res.ok || !res.body) {
    throw new Error(`repair service responded ${res.status} ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let result: { stl: Buffer; stats: Record<string, unknown> } | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev: RepairEvent & { stl_b64?: string };
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "error") throw new Error(ev.error || "repair failed mid-stream");
      if (ev.type === "done" && ev.stl_b64) {
        result = { stl: Buffer.from(ev.stl_b64, "base64"), stats: ev.stats ?? {} };
        onProgress({ type: "progress", stage: "done", percent: 100, message: "Repaired" });
      } else {
        onProgress(ev);
      }
    }
  }
  if (!result) throw new Error("repair stream ended without a result");
  return result;
}

export { SPACE_URL };
