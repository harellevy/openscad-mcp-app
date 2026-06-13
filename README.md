# openscad-mcp

An MCP server for iterating on [OpenSCAD](https://openscad.org/) models **inline in chat**: the
LLM writes OpenSCAD code, renders it through this server, sees the preview image directly in the
conversation, and refines it — then exports an STL when the model is right.

## Tools

| Tool | What it does |
|---|---|
| `view_model` | **Interactive 3D viewer inline in chat** (MCP Apps / SEP-1865): rotate/zoom + STL/PNG download buttons. Returns a PNG too, so hosts without MCP-Apps support still show a preview. Best in Claude Desktop / claude.ai. |
| `render_model` | PNG preview(s) returned inline. Options: `views` (diagonal/front/back/left/right/top/bottom), `width`/`height`, `color_scheme`, `full_render` (CGAL), `parameters` (`-D` overrides) |
| `check_model` | Fast parse/eval validation — errors & warnings with line numbers, no geometry render |
| `export_model` | Export `stl` / `off` / `amf` / `3mf` / `csg` to the exports directory |
| `diagnose` | Report whether the server can find/run OpenSCAD (path, version, what was probed). Call first if other tools fail. |

The interactive viewer is **fully self-contained** — a hand-written WebGL STL renderer, no three.js, no CDN, no external loads (the MCP-Apps iframe CSP blocks external `<script src>`). It parses both ASCII and binary STL and falls back to the PNG if WebGL is unavailable.

All tools accept `parameters` — a map applied as OpenSCAD `-D name=value` overrides, so individual
values can be tweaked without resending changed source.

### Passing source code

Every tool takes the model source one of three ways. For anything beyond a few lines, prefer the
last two — a long program crammed into a single JSON string is the most common cause of failed tool
calls (the model mis-escapes a newline/quote or the arguments get truncated, and the MCP client
rejects the call before the server sees it):

- `code: "<full program>"` — a single string. Fine for short snippets.
- `code: ["line 1", "line 2", …]` — an array of lines, joined with newlines. Each line is escaped
  independently, so this sidesteps the giant-single-string fragility.
- `code_path: "/abs/path/to/model.scad"` — render a file on disk. **Best for large models in Claude
  Code:** have the assistant write the `.scad` file with its normal editor tool, then pass the path.
  No source travels through the tool-call JSON at all.

## Requirements

- Node.js ≥ 18
- The `openscad` binary on `PATH` (or set `OPENSCAD_PATH`) — `apt install openscad`,
  `brew install openscad`, or [openscad.org/downloads](https://openscad.org/downloads.html)
- Headless Linux only: `xvfb` (`apt install xvfb`) — PNG rendering needs a GL context; the server
  wraps OpenSCAD in `xvfb-run` automatically when `$DISPLAY` is absent

## Install & build

```sh
npm install
npm run build
```

## Hook into Claude

**Claude Code:**

```sh
claude mcp add openscad -- node /absolute/path/to/openscad-mcp-app/dist/index.js
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "openscad": {
      "command": "node",
      "args": ["/absolute/path/to/openscad-mcp-app/dist/index.js"]
    }
  }
}
```

## The inline 3D viewer needs the HTTP transport

The tools work over **stdio** (the config above), but the **inline interactive 3D viewer**
(`view_model` / the MCP-App iframe) frequently does **not** render over stdio in Claude Desktop —
the iframe handshake never completes ([ext-apps#671](https://github.com/modelcontextprotocol/ext-apps/issues/671),
[claude-ai-mcp#165](https://github.com/anthropics/claude-ai-mcp/issues/165)). The inline-UI path is
exercised over **Streamable HTTP**, the same transport remote MCP servers/connectors use. To get the
orbit/zoom viewer, run the HTTP server and add it as a **custom connector**:

```sh
npm run build
npm run start:http          # listens on http://localhost:3333/mcp  (set PORT to change)
```

Then in Claude Desktop / claude.ai: **Settings → Connectors → Add custom connector**, URL
`http://localhost:3333/mcp`. Over stdio you still get tools + the PNG preview; over HTTP you get the
inline interactive viewer. (Run only one at a time to avoid two servers competing.)

## The iteration loop

1. Ask for a model ("design a parametric enclosure for a 60×40 mm PCB").
2. The assistant writes OpenSCAD → `check_model` (fast validation) → `render_model` (preview
   appears inline) → you comment on what's wrong → it fixes the code and re-renders.
3. When it looks right: `export_model` → STL lands in `./exports/` (or `OPENSCAD_MCP_EXPORT_DIR`).

Try the demo model: `examples/enclosure.scad` — a fully parameterized two-part electronics
enclosure.

## Troubleshooting: `'openscad' was not found` / `cannot run OpenSCAD`

The server process must be able to execute the OpenSCAD binary. If tools fail with a not-found error
(even `check_model`, which needs no display), the binary isn't reachable from the **server's**
environment — which is often not the same as your interactive shell.

1. **Ask the server** — call the `diagnose` tool (or read the server's stderr at startup). It prints
   whether OpenSCAD was found, the resolved path + version, the `PATH` the server actually sees, and
   every location it probed.
2. **Confirm the install really landed where the server runs.** In that same container/host:
   `which openscad && openscad --version`. If that fails, the install didn't take there (a different
   container, or `apt-get` errored) — fix that first.
3. **PATH mismatch** — if `which openscad` works in your shell but the server still can't find it, the
   stdio server inherited a minimal PATH from its host (common with Claude Desktop, Homebrew, app
   bundles). The server now auto-probes `/usr/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, `/snap/bin`,
   and the macOS app bundle. If your binary is elsewhere, set `OPENSCAD_PATH` to its absolute path in
   the MCP config's `env`.
4. **`check_model` works but `render_model` fails on headless Linux** → it's the display, not your
   code. PNG rendering needs a GL context; install `xvfb` (the server wraps OpenSCAD in `xvfb-run`
   automatically). `export_model` and `check_model` don't need it.

```jsonc
// MCP config with an explicit binary path (Claude Desktop / Claude Code)
{
  "mcpServers": {
    "openscad": {
      "command": "node",
      "args": ["/absolute/path/to/openscad-mcp-app/dist/index.js"],
      "env": { "OPENSCAD_PATH": "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD" }
    }
  }
}
```

After changing the install or config, **restart the MCP client** so it respawns the server.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `OPENSCAD_PATH` | `openscad` | Path to the OpenSCAD binary |
| `OPENSCAD_MCP_EXPORT_DIR` | `$TMPDIR/openscad-mcp-exports` | Where `export_model` writes files (always a writable dir). The mesh bytes are returned in the result regardless, so a read-only sandbox still works; set this to e.g. `~/Desktop` to collect files. |
| `OPENSCAD_TIMEOUT_MS` | `120000` | Per-invocation timeout |

## Development

```sh
npm test   # end-to-end smoke test: spawns the server over stdio, real renders + export
```

Roadmap and priorities: see [PLAN.md](PLAN.md).
