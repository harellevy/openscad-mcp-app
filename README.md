# openscad-mcp

An MCP server for iterating on [OpenSCAD](https://openscad.org/) models **inline in chat**: the
LLM writes OpenSCAD code, renders it through this server, sees the preview image directly in the
conversation, and refines it — then exports an STL when the model is right.

## Tools

| Tool | What it does |
|---|---|
| `check_model` | Fast parse/eval validation — errors & warnings with line numbers, no geometry render |
| `render_model` | PNG preview(s) returned inline. Options: `views` (diagonal/front/back/left/right/top/bottom), `width`/`height`, `color_scheme`, `full_render` (CGAL), `parameters` (`-D` overrides) |
| `export_model` | Export `stl` / `off` / `amf` / `3mf` / `csg` to the exports directory |

All tools accept `parameters` — a map applied as OpenSCAD `-D name=value` overrides, so individual
values can be tweaked without resending changed source.

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

## The iteration loop

1. Ask for a model ("design a parametric enclosure for a 60×40 mm PCB").
2. The assistant writes OpenSCAD → `check_model` (fast validation) → `render_model` (preview
   appears inline) → you comment on what's wrong → it fixes the code and re-renders.
3. When it looks right: `export_model` → STL lands in `./exports/` (or `OPENSCAD_MCP_EXPORT_DIR`).

Try the demo model: `examples/enclosure.scad` — a fully parameterized two-part electronics
enclosure.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `OPENSCAD_PATH` | `openscad` | Path to the OpenSCAD binary |
| `OPENSCAD_MCP_EXPORT_DIR` | `./exports` | Where `export_model` writes files |
| `OPENSCAD_TIMEOUT_MS` | `120000` | Per-invocation timeout |

## Development

```sh
npm test   # end-to-end smoke test: spawns the server over stdio, real renders + export
```

Roadmap and priorities: see [PLAN.md](PLAN.md).
