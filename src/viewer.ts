/**
 * Self-contained HTML for the interactive 3D viewer, served as the MCP Apps
 * UI resource (SEP-1865, mimeType text/html;profile=mcp-app). The host renders
 * this in a sandboxed iframe and pushes the triggering tool's result to it.
 *
 * Data delivery follows the production-proven MCP Apps contract:
 *   1. iframe sends `ui/initialize` (RPC), then BOTH `ui/notifications/initialized`
 *      and `notifications/initialized` — without the initialized notification the
 *      host treats the app as still initializing and never pushes the result.
 *   2. host pushes the tool result via `ui/notifications/tool-result`; the model
 *      data rides in `params.structuredContent` ({ stlBase64, pngBase64, name, stats }).
 *   3. iframe reports its height via `ui/notifications/size-changed`.
 *
 * FULLY SELF-CONTAINED — no third-party scripts, no CDN (the sandbox CSP blocks
 * external <script src>). 3D is a hand-written WebGL renderer that parses the
 * binary OR ascii STL. If WebGL is unavailable it falls back to the PNG carried
 * in the same message, so the panel is never blank.
 */

export const VIEWER_URI = "ui://openscad/viewer";
export const VIEWER_MIME = "text/html;profile=mcp-app";

export function buildViewerHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OpenSCAD model</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #1e1f22; color: #e6e6e6;
    font: 13px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  #wrap { position: relative; width: 100%; height: 440px; overflow: hidden; border-radius: 10px; }
  canvas { display: block; width: 100%; height: 100%; cursor: grab; touch-action: none; }
  canvas:active { cursor: grabbing; }
  #fallback { position: absolute; inset: 0; display: none; align-items: center;
    justify-content: center; background: #1e1f22; }
  #fallback img { max-width: 100%; max-height: 100%; object-fit: contain; }
  #bar { position: absolute; left: 0; right: 0; bottom: 0; display: flex; gap: 8px;
    align-items: center; padding: 8px 10px; background: rgba(20,21,24,0.82);
    border-top: 1px solid #34363b; }
  #name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #stats { color: #9aa0a6; margin-right: auto; }
  button { font: inherit; color: #e6e6e6; background: #2f3136; border: 1px solid #4a4d55;
    border-radius: 6px; padding: 6px 11px; cursor: pointer; }
  button:hover { background: #3a3d44; }
  button:disabled { opacity: 0.4; cursor: default; }
  #status { position: absolute; top: 10px; left: 12px; right: 12px; color: #9aa0a6; }
</style>
</head>
<body>
<div id="wrap">
  <canvas id="c"></canvas>
  <div id="fallback"><img id="png" alt="model preview" /></div>
  <div id="status">Waiting for a model — run the view_model tool.</div>
  <div id="bar">
    <span id="name">No model loaded</span>
    <span id="stats"></span>
    <button id="dlStl" disabled>Download STL</button>
    <button id="dlPng" disabled>Download PNG</button>
  </div>
</div>
<script>
/* Minimal dependency-free WebGL STL viewer + MCP Apps host handshake. */
(function () {
  'use strict';
  var statusEl = document.getElementById('status');
  var nameEl = document.getElementById('name');
  var statsEl = document.getElementById('stats');
  var fallbackEl = document.getElementById('fallback');
  var pngEl = document.getElementById('png');
  var dlStl = document.getElementById('dlStl');
  var dlPng = document.getElementById('dlPng');

  var pending = null;   // model that arrived before the renderer was ready
  var render3D = null;  // set if WebGL initialised

  function b64ToBytes(b64) {
    var bin = atob(b64), n = bin.length, bytes = new Uint8Array(n);
    for (var i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function downloadBytes(name, mime, bytes) {
    var blob = new Blob([bytes], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }
  function gunzip(bytes) {
    if (typeof DecompressionStream === 'undefined') return Promise.reject(new Error('gzip unsupported here'));
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  }
  // Mesh arrives as compact binary STL (stlBase64) or gzipped binary
  // (stlGzipBase64, inflated natively); resolve to an ArrayBuffer either way.
  function stlBufferOf(model) {
    if (model.stlBase64) return Promise.resolve(b64ToBytes(model.stlBase64).buffer);
    if (model.stlGzipBase64) return gunzip(b64ToBytes(model.stlGzipBase64));
    return Promise.resolve(null);
  }
  function showPng(b64, msg) {
    if (b64) { pngEl.src = 'data:image/png;base64,' + b64; fallbackEl.style.display = 'flex'; }
    statusEl.textContent = msg || '';
    reportSize();
  }

  function onModel(model) {
    if (!model) return;
    nameEl.textContent = model.name || 'model';
    statsEl.textContent = model.stats || '';
    if (model.pngBase64) {
      dlPng.disabled = false;
      dlPng.onclick = function () { downloadBytes((model.name || 'model') + '.png', 'image/png', b64ToBytes(model.pngBase64)); };
    }
    stlBufferOf(model).then(function (stlBuf) {
      if (stlBuf) {
        dlStl.disabled = false;
        dlStl.onclick = function () { downloadBytes((model.name || 'model') + '.stl', 'model/stl', stlBuf); };
      }
      if (stlBuf && render3D) {
        try {
          render3D(stlBuf);
          fallbackEl.style.display = 'none'; statusEl.textContent = ''; reportSize();
        } catch (e) { showPng(model.pngBase64, '3D render failed: ' + e.message); }
      } else if (stlBuf && !render3D) {
        pending = model; // renderer not ready yet
      } else {
        showPng(model.pngBase64, model.meshOmitted
          ? ('Model too large for inline 3D (' + (model.tris || '?') + ' triangles) — showing image. Use export_model to download the STL.')
          : (model.pngBase64 ? '' : 'Model has no preview data.'));
      }
    }, function (e) {
      showPng(model.pngBase64, 'Could not decode mesh (' + e.message + ') — showing image.');
    });
  }

  /* ---- MCP Apps host messaging (JSON-RPC 2.0 over postMessage) ---- */
  var PV = '2026-01-26', nextId = 1, waiting = {};
  function send(m) { try { window.parent.postMessage(m, '*'); } catch (e) {} }
  function rpc(method, params) {
    var id = nextId++;
    return new Promise(function (res) { waiting[id] = res;
      send({ jsonrpc: '2.0', id: id, method: method, params: params || {} }); });
  }
  function reportSize() {
    send({ jsonrpc: '2.0', method: 'ui/notifications/size-changed',
      params: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight } });
  }
  /* Pull the model from a tool result: structuredContent is the proven channel;
     _meta and a PNG content block are fallbacks. */
  function extractModel(params) {
    if (!params) return null;
    var sc = params.structuredContent || (params.toolResult && params.toolResult.structuredContent);
    if (sc && (sc.stlBase64 || sc.pngBase64)) return sc;
    var meta = params._meta && params._meta['openscad/viewer'];
    if (meta && (meta.stlBase64 || meta.pngBase64)) return meta;
    var content = params.content || (params.toolResult && params.toolResult.content) || [];
    var png = null;
    content.forEach(function (c) { if (c && c.type === 'image' && (c.mimeType === 'image/png' || !png)) png = c.data; });
    return png ? { pngBase64: png } : null;
  }
  window.addEventListener('message', function (ev) {
    var m = ev.data; if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') return;
    if (m.id != null && waiting[m.id]) { waiting[m.id](m.result || m.error); delete waiting[m.id]; return; }
    if (m.method === 'ui/notifications/tool-result') onModel(extractModel(m.params));
  });
  function sendInitialized() {
    send({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }
  rpc('ui/initialize', { protocolVersion: PV, appCapabilities: {},
    appInfo: { name: 'openscad-viewer', version: '1.0.0' } }).then(sendInitialized, sendInitialized);
  if (window.ResizeObserver) new ResizeObserver(reportSize).observe(document.documentElement);
  window.addEventListener('load', reportSize);

  /* ---- vector / matrix helpers ---- */
  function nrm(v) { var l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; }
  function sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
  function cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
  function dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
  function perspective(fovy, aspect, near, far) {
    var f = 1/Math.tan(fovy/2), nf = 1/(near-far);
    return new Float32Array([f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0]);
  }
  function lookAt(eye, ctr, up) {
    var z = nrm(sub(eye, ctr)), x = nrm(cross(up, z)), y = cross(z, x);
    return new Float32Array([x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0,
      -dot(x,eye), -dot(y,eye), -dot(z,eye), 1]);
  }

  /* ---- STL parser (binary OR ascii): centered positions + per-face normals ----
     OpenSCAD emits ASCII STL by default; binary detection is the standard
     size-formula check (84 + 50*n === byteLength). */
  function looksBinary(buf) {
    if (buf.byteLength < 84) return false;
    var n = new DataView(buf).getUint32(80, true);
    return 84 + n * 50 === buf.byteLength;
  }
  function readBinary(buf) {
    var dv = new DataView(buf), n = dv.getUint32(80, true), off = 84, tris = [];
    for (var i = 0; i < n; i++) {
      off += 12; // skip stored face normal
      for (var k = 0; k < 3; k++) {
        tris.push([dv.getFloat32(off, true), dv.getFloat32(off+4, true), dv.getFloat32(off+8, true)]);
        off += 12;
      }
      off += 2; // attribute byte count
    }
    return tris;
  }
  function readAscii(buf) {
    var txt = new TextDecoder().decode(new Uint8Array(buf));
    var re = /vertex\\s+([^\\s]+)\\s+([^\\s]+)\\s+([^\\s]+)/g, m, tris = [];
    while ((m = re.exec(txt))) tris.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
    return tris;
  }
  function parseSTL(buf) {
    var verts = looksBinary(buf) ? readBinary(buf) : readAscii(buf);
    var n = Math.floor(verts.length / 3);
    if (n < 1) throw new Error('no triangles found in STL');
    var pos = new Float32Array(n*9), nor = new Float32Array(n*9);
    var pi = 0, mn = [1e30,1e30,1e30], mx = [-1e30,-1e30,-1e30];
    for (var i = 0; i < n; i++) {
      var a = verts[i*3], b = verts[i*3+1], c = verts[i*3+2];
      var fn = nrm(cross(sub(b, a), sub(c, a)));
      var tri = [a, b, c];
      for (var j = 0; j < 3; j++) {
        var p = tri[j];
        pos[pi] = p[0]; pos[pi+1] = p[1]; pos[pi+2] = p[2];
        nor[pi] = fn[0]; nor[pi+1] = fn[1]; nor[pi+2] = fn[2]; pi += 3;
        if (p[0] < mn[0]) mn[0] = p[0]; if (p[1] < mn[1]) mn[1] = p[1]; if (p[2] < mn[2]) mn[2] = p[2];
        if (p[0] > mx[0]) mx[0] = p[0]; if (p[1] > mx[1]) mx[1] = p[1]; if (p[2] > mx[2]) mx[2] = p[2];
      }
    }
    var ctr = [(mn[0]+mx[0])/2, (mn[1]+mx[1])/2, (mn[2]+mx[2])/2];
    for (var q = 0; q < pos.length; q += 3) { pos[q] -= ctr[0]; pos[q+1] -= ctr[1]; pos[q+2] -= ctr[2]; }
    var rad = 0.5 * Math.hypot(mx[0]-mn[0], mx[1]-mn[1], mx[2]-mn[2]) || 1;
    return { pos: pos, nor: nor, count: n*3, radius: rad };
  }

  /* ---- WebGL setup ---- */
  function initGL() {
    var canvas = document.getElementById('c');
    var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) throw new Error('WebGL not available');

    var VS = ['attribute vec3 aPos;', 'attribute vec3 aNormal;', 'uniform mat4 uProj;',
      'uniform mat4 uView;', 'varying vec3 vN;', 'varying vec3 vP;',
      'void main(){ vN = aNormal; vP = aPos; gl_Position = uProj * uView * vec4(aPos,1.0); }'].join('\\n');
    var FS = ['precision mediump float;', 'varying vec3 vN;', 'varying vec3 vP;', 'uniform vec3 uEye;',
      'void main(){', '  vec3 N = normalize(vN);', '  vec3 L = normalize(uEye - vP);',
      '  float d = abs(dot(N, L));', '  float f = abs(dot(N, normalize(vec3(0.2,0.3,1.0)))) * 0.35;',
      '  vec3 albedo = vec3(0.79,0.64,0.18);', '  vec3 col = albedo * (0.22 + 0.78*d) + vec3(f);',
      '  gl_FragColor = vec4(min(col, vec3(1.0)), 1.0);', '}'].join('\\n');

    function sh(type, src) {
      var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    var prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    var aPos = gl.getAttribLocation(prog, 'aPos'), aNormal = gl.getAttribLocation(prog, 'aNormal');
    var uProj = gl.getUniformLocation(prog, 'uProj'), uView = gl.getUniformLocation(prog, 'uView'),
      uEye = gl.getUniformLocation(prog, 'uEye');
    var posBuf = gl.createBuffer(), norBuf = gl.createBuffer();
    gl.enable(gl.DEPTH_TEST);

    var geom = null, az = 0.9, el = 0.6, rad = 200;

    function resize() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = (canvas.clientWidth || 1) * dpr;
      canvas.height = (canvas.clientHeight || 1) * dpr;
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    window.addEventListener('resize', resize); resize();

    var drag = false, lx = 0, ly = 0;
    canvas.addEventListener('pointerdown', function (e) { drag = true; lx = e.clientX; ly = e.clientY;
      try { canvas.setPointerCapture(e.pointerId); } catch (x) {} });
    canvas.addEventListener('pointerup', function () { drag = false; });
    canvas.addEventListener('pointermove', function (e) {
      if (!drag) return;
      az -= (e.clientX - lx) * 0.01; el += (e.clientY - ly) * 0.01;
      el = Math.max(-1.5, Math.min(1.5, el)); lx = e.clientX; ly = e.clientY;
    });
    canvas.addEventListener('wheel', function (e) { e.preventDefault();
      rad *= (e.deltaY > 0 ? 1.1 : 0.9); }, { passive: false });

    function frame() {
      requestAnimationFrame(frame);
      gl.clearColor(0.118, 0.122, 0.133, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!geom) return;
      var ce = Math.cos(el);
      var eye = [rad*ce*Math.cos(az), rad*ce*Math.sin(az), rad*Math.sin(el)];
      var aspect = canvas.width / canvas.height || 1;
      var proj = perspective(45*Math.PI/180, aspect, Math.max(rad/1000, 0.01), rad*100);
      var view = lookAt(eye, [0, 0, 0], [0, 0, 1]);
      gl.useProgram(prog);
      gl.uniformMatrix4fv(uProj, false, proj);
      gl.uniformMatrix4fv(uView, false, view);
      gl.uniform3fv(uEye, eye);
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, norBuf);
      gl.enableVertexAttribArray(aNormal); gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, geom.count);
    }
    frame();

    return function (buf) {
      var g = parseSTL(buf);
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf); gl.bufferData(gl.ARRAY_BUFFER, g.pos, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, norBuf); gl.bufferData(gl.ARRAY_BUFFER, g.nor, gl.STATIC_DRAW);
      geom = { count: g.count }; rad = g.radius * 2.6; az = 0.9; el = 0.6;
    };
  }

  try {
    render3D = initGL();
    if (pending) { var p = pending; pending = null; onModel(p); }
  } catch (e) {
    render3D = null;
    showPng(pending && pending.pngBase64, 'Interactive 3D unavailable (' + e.message + '). Showing PNG preview.');
  }
})();
</script>
</body>
</html>`;
}
