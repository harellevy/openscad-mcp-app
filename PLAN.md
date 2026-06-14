# openscad-mcp-app — Plan

## Goal

An MCP server ("MCP app") that makes OpenSCAD usable **inline in chat**: the LLM writes OpenSCAD
code, calls a tool, and gets a rendered preview image back in the conversation — enabling a tight
write → render → look → fix iteration loop for 3D modeling, plus mesh export (STL/3MF/…) when the
model is done.

## Architecture

```
Claude (Code / Desktop / any MCP client)
        │  MCP over stdio
        ▼
openscad-mcp (TypeScript, @modelcontextprotocol/sdk)
        │  spawns CLI per call (xvfb-run wrapper on headless Linux for PNG)
        ▼
OpenSCAD binary  ──►  PNG preview (returned inline as MCP image content)
                 ──►  STL / 3MF / OFF / AMF / CSG (written to exports dir)
```

Design decisions:

- **TypeScript + official MCP SDK, stdio transport** — works in Claude Code and Claude Desktop
  with a one-line config; Streamable HTTP can be added later without touching tool logic.
- **Stateless tools** — the full SCAD source is passed on every call. The chat itself is the
  iteration history; no hidden server state to drift out of sync.
- **Inline images** — `render_model` returns MCP `image` content blocks (base64 PNG), so previews
  appear directly in the conversation. Multi-view = one image block per requested view.
- **Headless rendering** — PNG rendering needs a GL context; on Linux without `$DISPLAY` the
  server transparently wraps OpenSCAD in `xvfb-run`. Mesh export and syntax checking don't need GL.
- **Customizer-style parameters** — every tool accepts a `parameters` map translated to `-D`
  flags, so values can be tweaked without regenerating the whole source.

## Tool surface

| Tool | Purpose | Returns |
|---|---|---|
| `check_model` | Fast parse/eval check (no geometry render) | OK / ERROR + WARNING lines with line numbers |
| `render_model` | Render preview PNG(s): views, size, color scheme, `-D` params, optional full CGAL render | Inline image(s) + render stats |
| `export_model` | Export mesh: `stl`, `off`, `3mf`, `amf`, `csg` | File path + size + geometry stats |

Recommended LLM loop: `check_model` (cheap) → `render_model` (look) → fix → repeat → `export_model`.

## Priorities

### P0 — Core iterate loop (this session) ✅
- [x] Repo bootstrap: `main`, working branch, plan
- [x] TS scaffold: package.json, tsconfig, stdio entry point
- [x] OpenSCAD wrapper: binary discovery (`OPENSCAD_PATH`), temp-file lifecycle, timeouts,
      xvfb fallback, ERROR/WARNING extraction
- [x] Tools: `check_model`, `render_model` (view presets: diagonal/front/back/left/right/top/bottom),
      `export_model`
- [x] End-to-end verification in this container: real render → PNG, real STL export, error-path check
      (`npm test`; demo model `examples/enclosure.scad` rendered and inspected)
- [x] README: install + Claude Code / Claude Desktop wiring

### P1 — Iteration quality
- [ ] Better diagnostics: echo the offending source line under each ERROR
- [ ] `render_model` extras: orthographic projection option, transparent background, custom camera
- [ ] Export dir listing tool + safe filenames; bounding-box / volume stats via CSG inspection
- [ ] Library support: mount a `libs/` dir on `OPENSCADPATH` (BOSL2, MCAD) so `include <...>` works

### P2 — Interactive viewer (MCP Apps UI)
- [ ] `ui://` HTML resource (MCP Apps / SEP-1865) embedding a three.js STL viewer with orbit
      controls — interactive rotate/zoom inline in hosts that support MCP apps; PNG tools remain
      the universal fallback (Claude Code CLI etc.)

### P3 — Distribution & hardening
- [ ] Smoke tests in CI (GitHub Actions, apt-installed OpenSCAD + xvfb)
- [ ] Dockerfile (pinned OpenSCAD) and npx-installable package
- [ ] Streamable HTTP transport option; per-call resource limits

## Risks / notes

- **OpenSCAD must be installed** where the server runs. Mitigation: clear startup error,
  `OPENSCAD_PATH` override, Dockerfile in P3.
- **Preview vs full render**: default preview (fast, OpenCSG) can show z-fighting artifacts on
  coincident faces; `full_render: true` switches to CGAL. Documented in tool description.
- **Untrusted code**: OpenSCAD evaluates `import`/`include` from disk. The server runs with the
  caller's privileges — same trust model as Claude running shell commands locally.
