// Cutout Animate test suite: 25 real-use cases + 25 edge cases for the newest Animate features
// (view zoom, per-property keyframes, voice lip sync, reload rendering).
//
// Run:  npm i -D playwright && npx playwright install chromium   (once)
//       node tests/animate.test.js
// Optional: MUX_JS=/path/to/mp4-muxer.js to serve the muxer locally (offline runs).
// ffmpeg/ffprobe on PATH enable the export check; without them that test is skipped.

const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const ONLY = process.argv[2] ? new RegExp(process.argv[2], "i") : null;

// ---------- tiny static server ----------
const TYPES = { ".html": "text/html", ".wasm": "application/wasm", ".js": "application/javascript", ".svg": "image/svg+xml", ".png": "image/png" };
function serve() {
  return new Promise((res) => {
    const srv = http.createServer((q, r) => {
      let p = decodeURIComponent(q.url.split("?")[0].split("#")[0]); if (p === "/") p = "/index.html";
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
      r.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(r);
    }).listen(0, () => res(srv));
  });
}

// ---------- WAV generator (16-bit PCM) ----------
function wav(seconds, fn, { sr = 48000, channels = 1 } = {}) {
  const n = Math.max(1, Math.round(seconds * sr)), data = Buffer.alloc(n * channels * 2);
  for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) {
    const v = Math.max(-1, Math.min(1, fn(i / sr, c))); data.writeInt16LE(Math.round(v * 32767), (i * channels + c) * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
let noiseSeed = 1; const noise = () => { noiseSeed = (noiseSeed * 1103515245 + 12345) & 0x7fffffff; return noiseSeed / 0x3fffffff - 1; };
const voiced = (t) => (0.5 * Math.sin(2 * Math.PI * 180 * t) + 0.3 * Math.sin(2 * Math.PI * 360 * t) + 0.2 * Math.sin(2 * Math.PI * 900 * t)) * Math.pow(Math.abs(Math.sin(2 * Math.PI * 2.5 * t)), 0.6);
// speech in [0.6,1.6] and [2.3,3.3] over a quiet noise floor
const SPEECH = wav(4, (t) => ((t >= 0.6 && t <= 1.6) || (t >= 2.3 && t <= 3.3) ? voiced(t) : 0) + noise() * 0.004);
const file = (name, buffer, mimeType = "audio/wav") => ({ name, mimeType, buffer });

// ---------- harness ----------
let browser, base, srv;
async function open({ viewport = { width: 1366, height: 1000 }, tab, hash = "animate" } = {}) {
  const ctx = await browser.newContext({ viewport });
  const pg = await ctx.newPage(); pg.errs = [];
  pg.on("pageerror", (e) => pg.errs.push(e.message));
  await pg.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ body: "", contentType: "text/css" }));
  if (process.env.MUX_JS) await pg.route("https://cdn.jsdelivr.net/npm/mp4-muxer**", (r) => r.fulfill({ path: process.env.MUX_JS, contentType: "application/javascript" }));
  if (tab) await pg.addInitScript((t) => { try { localStorage.setItem("cutout-animate-tab", t); } catch {} }, tab);
  await pg.goto(`${base}/?test#${hash}`); await pg.waitForFunction(() => window.__an, null, { timeout: 15000 }); await pg.waitForTimeout(150);
  pg.close2 = () => ctx.close();
  return pg;
}
const an = (pg, fn, arg) => pg.evaluate(fn, arg);
const setT = (pg, s) => an(pg, (s) => { window.__an.t = s; }, s);
const scrubTo = async (pg, s) => { await pg.$eval("#an-scrub", (e, s) => { e.value = Math.round(s / window.__an.duration() * 1000); e.dispatchEvent(new Event("input", { bubbles: true })); }, s); };
const slider = (pg, id, v) => pg.$eval("#" + id, (e, v) => { e.value = v; e.dispatchEvent(new Event("input", { bubbles: true })); }, v);
const pickProp = (pg, p) => pg.selectOption("#an-kfProp", p);
const addKey = (pg) => pg.click("#an-kfAdd");
const ease = (pg, e) => pg.selectOption("#an-kfEase", e);
const val = (pg, p, tt) => an(pg, ([p, tt]) => window.__an.valAt(p, tt), [p, tt]);
const nKeys = (pg, p) => an(pg, (p) => window.__an.tracks[p].length, p);
const cvRect = (pg) => pg.$eval("#an-preview", (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
async function canvasToClient(pg, pt) { return an(pg, (pt) => { const c = window.__an.cv, r = c.getBoundingClientRect(); return { x: r.left + pt.x * r.width / c.width, y: r.top + pt.y * r.height / c.height }; }, pt); }
async function lumaStats(pg) {
  return an(pg, () => { const c = window.__an.cv, d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let s = 0, s2 = 0, n = 0;
    for (let i = 0; i < d.length; i += 4 * 37) { const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; s += y; s2 += y * y; n++; }
    const m = s / n; return { mean: m, sd: Math.sqrt(Math.max(0, s2 / n - m * m)) }; });
}
const cornerLuma = (pg) => an(pg, () => { const c = window.__an.cv, d = c.getContext("2d").getImageData(2, 2, 12, 12).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; return s / (d.length / 4); });
async function dragCharacter(pg, fx0, fy0, fx1, fy1) {
  const r = await cvRect(pg);
  await pg.mouse.move(r.x + r.w * fx0, r.y + r.h * fy0); await pg.mouse.down();
  await pg.mouse.move(r.x + r.w * fx1, r.y + r.h * fy1, { steps: 6 }); await pg.mouse.up();
}
async function loadVoice(pg, f) { await pg.setInputFiles("#an-audio", f); await pg.waitForFunction(() => !/Reading/.test(document.getElementById("an-audioHint").textContent), null, { timeout: 15000 }); await pg.waitForTimeout(100); }
const mouthSamples = (pg, t0, t1, step = 0.02) => an(pg, ([a, b, s]) => { const o = []; for (let t = a; t <= b + 1e-9; t += s) o.push(window.__an.mouthOpen(t)); return o; }, [t0, t1, step]);

function assert(c, msg) { if (!c) throw new Error(msg); }
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: expected ≈${b} (±${tol}), got ${a}`);
class Skip extends Error {}

const tests = []; let FEATURE = "";
const feature = (name) => { FEATURE = name; };
const real = (name, fn) => tests.push({ kind: "real", feature: FEATURE, name, fn });
const edge = (name, fn) => tests.push({ kind: "edge", feature: FEATURE, name, fn });

feature("Zoom, keyframes, voice lip sync");
// =====================================================================
// 25 REAL-USE CASES
// =====================================================================
real("R01 Animate page loads without errors and has 4 tabs (Voice merged into Person)", async (pg) => {
  const tabs = await pg.$$eval("[data-antab]", (a) => a.map((b) => b.dataset.antab));
  assert(JSON.stringify(tabs) === JSON.stringify(["person", "moves", "scene", "output"]), "tabs: " + tabs);
  assert(await pg.$("#an-panel-person #an-audio"), "voice upload is not in the Person tab");
  assert(await pg.$("#an-panel-person #an-mouthBtn"), "mouth button is not in the Person tab");
});
real("R02 First frame after a reload shows the scene, not a colour wash", async (pg) => {
  await pg.reload(); await pg.waitForFunction(() => window.__an); await pg.waitForTimeout(200);
  const s = await lumaStats(pg); assert(s.sd > 25, `preview looks washed out (luma sd ${s.sd.toFixed(1)})`);
});
real("R03 Zoom + makes the preview 1.5× bigger and shows the percentage", async (pg) => {
  const w0 = (await cvRect(pg)).w; await pg.click("#an-zIn"); const w1 = (await cvRect(pg)).w;
  near(w1 / w0, 1.5, 0.03, "zoom ratio"); assert((await pg.textContent("#an-zFit")) === "150%", "label");
});
real("R04 Fit returns to the fitted view", async (pg) => {
  const w0 = (await cvRect(pg)).w; await pg.click("#an-zIn"); await pg.click("#an-zIn"); await pg.click("#an-zFit");
  near((await cvRect(pg)).w, w0, 2, "width after Fit"); assert((await pg.textContent("#an-zFit")) === "Fit", "label");
});
real("R05 Ctrl + scroll over the view zooms in", async (pg) => {
  const v = await pg.$eval("#an-view", (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  await pg.mouse.move(v[0], v[1]); await pg.keyboard.down("Control"); await pg.mouse.wheel(0, -300); await pg.keyboard.up("Control"); await pg.waitForTimeout(80);
  assert(await an(pg, () => window.__an.zoom) > 1.2, "zoom did not increase");
});
real("R06 Zoomed preview renders at a higher resolution", async (pg) => {
  const w0 = await an(pg, () => window.__an.cv.width); await pg.click("#an-zIn"); await pg.click("#an-zIn");
  assert(await an(pg, () => window.__an.cv.width) > w0 * 1.5, "canvas resolution did not grow");
});
real("R07 Space + drag pans the zoomed view", async (pg) => {
  for (let i = 0; i < 3; i++) await pg.click("#an-zIn");
  const s0 = await pg.$eval("#an-view", (e) => [e.scrollLeft, e.scrollTop]);
  const v = await pg.$eval("#an-view", (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  await pg.mouse.move(v[0], v[1]); await pg.keyboard.down("Space"); await pg.mouse.down(); await pg.mouse.move(v[0] - 150, v[1] - 80, { steps: 5 }); await pg.mouse.up(); await pg.keyboard.up("Space");
  const s1 = await pg.$eval("#an-view", (e) => [e.scrollLeft, e.scrollTop]);
  assert(Math.abs(s1[0] - s0[0]) > 50, `did not pan (${s0} → ${s1})`);
});
real("R08 Scrolling over an unselected character does not resize it", async (pg) => {
  await an(pg, () => { window.__an.selected = false; });
  const r = await cvRect(pg); await pg.mouse.move(r.x + r.w / 2, r.y + r.h * 0.7); await pg.mouse.wheel(0, -200); await pg.waitForTimeout(60);
  near(await val(pg, "size", 0), 90, 0.01, "size");
});
real("R09 Scrolling over the selected character resizes it", async (pg) => {
  const r = await cvRect(pg); await pg.mouse.click(r.x + r.w / 2, r.y + r.h * 0.8);
  assert(await an(pg, () => window.__an.selected), "click did not select");
  await pg.mouse.wheel(0, -100); await pg.waitForTimeout(60);
  assert(await val(pg, "size", 0) > 92, "size did not grow");
});
real("R10 Size keyframes glide smoothly between two keys", async (pg) => {
  await pickProp(pg, "size"); await scrubTo(pg, 0); await addKey(pg);
  await scrubTo(pg, 4); await slider(pg, "an-size", 150);
  assert(await nKeys(pg, "size") === 2, "expected 2 size keys");
  const v1 = await val(pg, "size", 1), v2 = await val(pg, "size", 2);
  assert(v1 > 90 && v1 < 105, `smooth start should ease in (got ${v1})`); near(v2, 120, 2, "midpoint");
});
real("R11 Linear easing gives an even glide", async (pg) => {
  await pickProp(pg, "size"); await setT(pg, 0); await addKey(pg); await setT(pg, 4); await slider(pg, "an-size", 150); await ease(pg, "linear");
  near(await val(pg, "size", 1), 105, 0.5, "quarter point");
});
real("R12 Hold keeps the value until the next key", async (pg) => {
  await pickProp(pg, "size"); await setT(pg, 0); await addKey(pg); await setT(pg, 4); await slider(pg, "an-size", 150); await ease(pg, "hold");
  near(await val(pg, "size", 3.9), 90, 0.01, "held value"); near(await val(pg, "size", 4), 150, 0.01, "value at key");
});
real("R13 Dragging the character on two keys animates its position", async (pg) => {
  await pickProp(pg, "pos"); await scrubTo(pg, 0); await addKey(pg);
  await scrubTo(pg, 3); await dragCharacter(pg, 0.5, 0.75, 0.3, 0.75);
  const a = await val(pg, "pos", 0), b = await val(pg, "pos", 3), m = await val(pg, "pos", 1.5);
  assert(b.x < a.x - 0.1, `end x should be left (${a.x} → ${b.x})`); assert(m.x < a.x && m.x > b.x, "midpoint not between");
});
real("R14 Rotating with the handle keys the rotation", async (pg) => {
  await pickProp(pg, "rot"); await setT(pg, 0); await addKey(pg); await setT(pg, 3);
  await an(pg, () => { window.__an.selected = true; });
  const H = await an(pg, () => { const A = window.__an, X = A.charXf(A.cv.width, A.cv.height), h = A.handles(X); return { cx: X.cx, cy: X.cy, rx: h.rotate.x, ry: h.rotate.y }; });
  const R = Math.hypot(H.rx - H.cx, H.ry - H.cy), a = Math.PI / 6;
  const p0 = await canvasToClient(pg, { x: H.rx, y: H.ry }), p1 = await canvasToClient(pg, { x: H.cx + Math.sin(a) * R, y: H.cy - Math.cos(a) * R });
  await pg.mouse.move(p0.x, p0.y); await pg.mouse.down(); await pg.mouse.move(p1.x, p1.y, { steps: 8 }); await pg.mouse.up();
  near(await val(pg, "rot", 3), a, 0.08, "rotation at 3 s"); near(await val(pg, "rot", 0), 0, 0.001, "rotation at 0 s");
});
real("R15 Blur slider follows its keyframes while scrubbing", async (pg) => {
  await pickProp(pg, "blur"); await slider(pg, "an-blur", 0); await setT(pg, 0); await addKey(pg);
  await setT(pg, 6); await slider(pg, "an-blur", 100); await ease(pg, "linear"); await scrubTo(pg, 3);
  near(+(await pg.$eval("#an-blur", (e) => e.value)), 50, 2, "slider at midpoint");
});
real("R16 Vignette keyframes darken the corners over time", async (pg) => {
  await pickProp(pg, "vig"); await slider(pg, "an-vig", 0); await setT(pg, 0); await addKey(pg);
  await setT(pg, 6); await slider(pg, "an-vig", 100);
  await setT(pg, 0); const c0 = await cornerLuma(pg); await setT(pg, 6); const c1 = await cornerLuma(pg);
  assert(c0 - c1 > 40, `corners should darken (${c0.toFixed(0)} → ${c1.toFixed(0)})`);
});
real("R17 Move-energy keyframes make the moves calm then strong", async (pg) => {
  await pickProp(pg, "energy"); await slider(pg, "an-energy", 10); await setT(pg, 0); await addKey(pg);
  await setT(pg, 6); await slider(pg, "an-energy", 200);
  const amp = (a, b) => an(pg, ([a, b]) => { let m = 0; for (let t = a; t < b; t += 0.01) m = Math.max(m, Math.abs(window.__an.pose(t, false).dy)); return m; }, [a, b]);
  const lo = await amp(0.2, 1.2), hi = await amp(4.8, 5.8);
  assert(hi > lo * 4, `energy should grow (${lo.toFixed(4)} → ${hi.toFixed(4)})`);
});
real("R18 Clicking a diamond jumps the playhead to that key", async (pg) => {
  await pickProp(pg, "size"); await setT(pg, 2.5); await addKey(pg); await setT(pg, 0);
  await pg.click(".kf-key"); near(await an(pg, () => window.__an.t), 2.5, 0.001, "playhead");
});
real("R19 Dragging a diamond moves the key in time", async (pg) => {
  await pickProp(pg, "size"); await setT(pg, 3); await addKey(pg);
  const k = await (await pg.$(".kf-key")).boundingBox(), tr = await (await pg.$("#an-kfTrack")).boundingBox();
  const target = tr.x + 11 + (tr.width - 22) * 1.5 / 6;
  await pg.mouse.move(k.x + k.width / 2, k.y + k.height / 2); await pg.mouse.down(); await pg.mouse.move(target, k.y + k.height / 2, { steps: 6 }); await pg.mouse.up();
  near(await an(pg, () => window.__an.tracks.size[0].t), 1.5, 0.07, "key time");
});
real("R20 Previous / next buttons step between keys", async (pg) => {
  await pickProp(pg, "size"); for (const s of [1, 2, 4]) { await setT(pg, s); await addKey(pg); }
  await setT(pg, 3); await pg.click("#an-kfNext"); near(await an(pg, () => window.__an.t), 4, 0.001, "next");
  await pg.click("#an-kfPrev"); await pg.click("#an-kfPrev"); near(await an(pg, () => window.__an.t), 1, 0.001, "prev ×2");
});
real("R21 Delete removes only the key under the playhead", async (pg) => {
  await pickProp(pg, "size"); for (const s of [1, 2, 3]) { await setT(pg, s); await addKey(pg); }
  await setT(pg, 2); await pg.click("#an-kfDel");
  const ts = await an(pg, () => window.__an.tracks.size.map((k) => k.t)); assert(JSON.stringify(ts) === "[1,3]", "keys left: " + ts);
});
real("R22 The Keyframe menu shows which effects have keys", async (pg) => {
  await pickProp(pg, "size"); await setT(pg, 1); await addKey(pg); await setT(pg, 2); await addKey(pg);
  await pickProp(pg, "vig"); await addKey(pg);
  const o = await pg.$$eval("#an-kfProp option", (a) => Object.fromEntries(a.map((x) => [x.value, x.textContent])));
  assert(/◆2/.test(o.size) && /◆1/.test(o.vig) && !/◆/.test(o.pos), JSON.stringify(o));
  assert(await pg.$$eval(".kf-dot", (a) => a.length) === 2, "faint marks for the size keys");
});
real("R23 Loading a voice clip shows the hint, start control and voice strip", async (pg) => {
  await loadVoice(pg, file("speech.wav", SPEECH));
  const hint = await pg.textContent("#an-audioHint"); assert(/speaking \d+%/.test(hint), hint);
  assert(await pg.isVisible("#an-voRow") && await pg.isVisible("#an-vStartRow") && await pg.isVisible("#an-audioClear"), "voice controls not shown");
});
real("R24 Mouth moves only while the voice speaks (voice starting at 1 s)", async (pg) => {
  await loadVoice(pg, file("speech.wav", SPEECH)); await slider(pg, "an-vStart", 1);
  const at = async (t) => an(pg, (t) => window.__an.mouthOpen(t), t);
  for (const t of [0.3, 1.2, 3.0, 4.6, 5.5]) assert(await at(t) === 0, `mouth should be shut at ${t}s (got ${await at(t)})`);
  const open1 = Math.max(...await mouthSamples(pg, 1.7, 2.5)), open2 = Math.max(...await mouthSamples(pg, 3.4, 4.2));
  assert(open1 > 0.3 && open2 > 0.3, `mouth should open in speech (${open1}, ${open2})`);
});
real("R25 Export follows the keyframes (2 s, vignette 0 → 100)", async (pg) => {
  try { execFileSync("ffprobe", ["-version"], { stdio: "ignore" }); } catch { throw new Skip("ffmpeg/ffprobe not installed"); }
  const can = await an(pg, async () => { try { return !!window.VideoEncoder && (await VideoEncoder.isConfigSupported({ codec: "avc1.640028", width: 1920, height: 1080 })).supported; } catch { return false; } });
  if (!can) throw new Skip("this browser has no H.264 encoder");
  await slider(pg, "an-len", 2); await pg.click('[data-antab="output"]'); await pg.selectOption("#an-container", "mp4");
  await pickProp(pg, "vig"); await slider(pg, "an-vig", 0); await setT(pg, 0); await addKey(pg); await setT(pg, 2); await slider(pg, "an-vig", 100);
  await pg.$eval("#an-exportBtn", (b) => b.click());
  await pg.waitForFunction(() => !document.getElementById("an-result").hidden, null, { timeout: 180000 });
  const b64 = await an(pg, async () => { const r = await fetch(document.getElementById("an-resultVideo").src); const a = new Uint8Array(await r.arrayBuffer()); let s = ""; for (let i = 0; i < a.length; i += 32768) s += String.fromCharCode.apply(null, a.subarray(i, i + 32768)); return btoa(s); });
  const f = path.join(os.tmpdir(), `an-export-${process.pid}.mp4`); fs.writeFileSync(f, Buffer.from(b64, "base64"));
  const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames,r_frame_rate,width,height", "-of", "json", f]).toString()).streams[0];
  assert(info.width === 1920 && info.height === 1080, "size " + info.width + "x" + info.height);
  assert(Math.abs(+info.nb_read_frames - 60) <= 1, "frames " + info.nb_read_frames);
  const corner = (ss) => { const raw = execFileSync("ffmpeg", ["-v", "error", "-ss", String(ss), "-i", f, "-frames:v", "1", "-vf", "crop=60:60:0:0,scale=1:1", "-f", "rawvideo", "-pix_fmt", "gray", "-"]); return raw[0]; };
  const a = corner(0.05), b = corner(1.95); fs.unlinkSync(f);
  assert(a - b > 40, `exported corners should darken (${a} → ${b})`);
});

// =====================================================================
// 25 EDGE CASES
// =====================================================================
edge("E01 Adding a key twice at the same time keeps one key", async (pg) => {
  await pickProp(pg, "size"); await setT(pg, 2); await addKey(pg); await addKey(pg); await pg.keyboard.press("k");
  assert(await nKeys(pg, "size") === 1, "duplicate keys");
});
edge("E02 A single key holds its value for the whole video", async (pg) => {
  await pickProp(pg, "size"); await slider(pg, "an-size", 130); await setT(pg, 3); await addKey(pg);
  for (const t of [0, 1.5, 3, 6]) near(await val(pg, "size", t), 130, 0.01, `size at ${t}`);
});
edge("E03 Before the first key and after the last, values are clamped", async (pg) => {
  await pickProp(pg, "size"); await slider(pg, "an-size", 60); await setT(pg, 2); await addKey(pg); await setT(pg, 4); await slider(pg, "an-size", 200);
  near(await val(pg, "size", 0), 60, 0.01, "before"); near(await val(pg, "size", 6), 200, 0.01, "after");
});
edge("E04 Keys snap to whole frames (1/30 s)", async (pg) => {
  await pickProp(pg, "size"); await setT(pg, 1.234); await addKey(pg);
  near(await an(pg, () => window.__an.tracks.size[0].t), 37 / 30, 1e-9, "snapped time");
});
edge("E05 A key can't be dragged onto another key's time", async (pg) => {
  await pickProp(pg, "size"); await setT(pg, 1); await addKey(pg); await setT(pg, 2); await addKey(pg);
  const ks = await pg.$$(".kf-key"), a = await ks[0].boundingBox(), b = await ks[1].boundingBox();
  await pg.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await pg.mouse.down(); await pg.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 }); await pg.mouse.up();
  const ts = await an(pg, () => window.__an.tracks.size.map((k) => k.t)); assert(ts.length === 2 && ts[0] !== ts[1], "keys collided: " + ts);
});
edge("E06 Deleting the last key keeps the value you see", async (pg) => {
  await pickProp(pg, "size"); await setT(pg, 2); await addKey(pg); await slider(pg, "an-size", 170);
  await pg.click("#an-kfDel"); assert(await nKeys(pg, "size") === 0, "key not deleted");
  near(await val(pg, "size", 0), 170, 0.01, "size kept");
});
edge("E07 Clear all on one effect leaves other effects' keys alone", async (pg) => {
  await pickProp(pg, "blur"); await addKey(pg); await pickProp(pg, "size"); await addKey(pg); await setT(pg, 2); await addKey(pg);
  await pg.click("#an-kfClear"); assert(await nKeys(pg, "size") === 0 && await nKeys(pg, "blur") === 1, "wrong track cleared");
});
edge("E08 Only keyed properties auto-key; others change for the whole video", async (pg) => {
  await pickProp(pg, "size"); await setT(pg, 0); await addKey(pg); await scrubTo(pg, 3); await dragCharacter(pg, 0.5, 0.75, 0.35, 0.75);
  assert(await nKeys(pg, "pos") === 0, "position should not be keyed");
  const a = await val(pg, "pos", 0), b = await val(pg, "pos", 6); near(a.x, b.x, 1e-9, "same x everywhere"); assert(a.x < 0.45, "position did not change");
});
edge("E09 Size stays between 20% and 250% however far you scroll", async (pg) => {
  await an(pg, () => { window.__an.selected = true; }); const r = await cvRect(pg); await pg.mouse.move(r.x + r.w / 2, r.y + r.h * 0.8);
  for (let i = 0; i < 60; i++) await pg.mouse.wheel(0, -100); await pg.waitForTimeout(50);
  assert(await val(pg, "size", 0) <= 250, "above max");
  for (let i = 0; i < 120; i++) await pg.mouse.wheel(0, 100); await pg.waitForTimeout(50);
  assert(await val(pg, "size", 0) >= 20, "below min");
});
edge("E10 Zoom is limited to Fit … 800%", async (pg) => {
  for (let i = 0; i < 12; i++) await pg.click("#an-zIn"); assert(await an(pg, () => window.__an.zoom) === 8, "max zoom");
  for (let i = 0; i < 12; i++) await pg.click("#an-zOut"); assert(await an(pg, () => window.__an.zoom) === 1, "min zoom");
});
edge("E11 Zoom keeps the 9:16 shape for Shorts", async (pg) => {
  await pg.$eval('[data-anratio="9:16"]', (b) => b.click()); await pg.click("#an-zIn");
  const r = await cvRect(pg); near(r.w / r.h, 9 / 16, 0.01, "aspect");
});
edge("E12 Typing K in the file name does not add a keyframe", async (pg) => {
  await pg.click("#an-fname"); await pg.keyboard.type("kk");
  assert(await nKeys(pg, "pos") === 0, "key added while typing"); assert((await pg.inputValue("#an-fname")).endsWith("kk"), "text not typed");
});
edge("E13 Space does nothing special when the view isn't zoomed", async (pg) => {
  await pg.mouse.click(5, 5); await pg.keyboard.down("Space"); const sd = await an(pg, () => window.__an.spaceDown); await pg.keyboard.up("Space");
  assert(sd === false, "space pan armed without zoom");
});
edge("E14 A 35 s voice clip extends the video past the 30 s slider", async (pg) => {
  await loadVoice(pg, file("long.wav", wav(35, (t) => (t % 3 < 1.5 ? voiced(t) : 0) + noise() * 0.003, { sr: 16000 })));
  assert(await an(pg, () => window.__an.duration()) >= 35, "duration too short");
});
edge("E15 A completely silent clip keeps the mouth shut", async (pg) => {
  await loadVoice(pg, file("silent.wav", wav(2, () => 0)));
  assert(/speaking 0%/.test(await pg.textContent("#an-audioHint")), "hint should say 0%");
  assert(Math.max(...await mouthSamples(pg, 0, 2)) === 0, "mouth opened in silence");
});
edge("E16 Background noise alone barely opens the mouth", async (pg) => {
  await loadVoice(pg, file("noise.wav", wav(3, () => noise() * 0.05)));
  const s = await mouthSamples(pg, 0, 3); const open = s.filter((v) => v > 0).length / s.length;
  assert(open < 0.1, `mouth open ${Math.round(open * 100)}% of the time on noise`);
});
edge("E17 A clipped, very loud clip stays within mouth limits", async (pg) => {
  await loadVoice(pg, file("loud.wav", wav(2, (t) => (t > 0.5 && t < 1.5 ? Math.sign(Math.sin(2 * Math.PI * 150 * t)) : 0))));
  const s = await mouthSamples(pg, 0, 2); assert(s.every((v) => v >= 0 && v <= 1), "mouth out of range"); assert(Math.max(...s) > 0.5, "mouth barely opened");
});
edge("E18 Before the voice starts and after it ends the mouth is shut", async (pg) => {
  await loadVoice(pg, file("speech.wav", SPEECH)); await slider(pg, "an-vStart", 2);
  assert(Math.max(...await mouthSamples(pg, 0, 1.99)) === 0, "open before start");
  assert(Math.max(...await mouthSamples(pg, 6.1, 7)) === 0, "open after end");
  near(await an(pg, () => window.__an.duration()), 6, 0.01, "duration = start + clip");
});
edge("E19 Removing the voice restores the made-up talking and hides the strip", async (pg) => {
  await loadVoice(pg, file("speech.wav", SPEECH)); await pg.click("#an-audioClear");
  assert(!(await pg.isVisible("#an-voRow")) && !(await pg.isVisible("#an-vStartRow")), "voice controls still visible");
  assert(await an(pg, () => window.__an.voice) === null, "voice still set");
  assert(Math.max(...await mouthSamples(pg, 0, 3)) > 0.2, "made-up talking not back");
});
edge("E20 A tiny 0.2 s clip loads", async (pg) => {
  await loadVoice(pg, file("blip.wav", wav(0.2, (t) => voiced(t + 0.1))));
  assert(/0:00\.2/.test(await pg.textContent("#an-audioHint")), await pg.textContent("#an-audioHint"));
});
edge("E21 A stereo clip with the voice only on the right channel still drives the mouth", async (pg) => {
  await loadVoice(pg, file("right.wav", wav(2, (t, c) => (c === 1 && t > 0.5 && t < 1.5 ? voiced(t) : 0) + noise() * 0.003, { channels: 2 })));
  assert(Math.max(...await mouthSamples(pg, 0.6, 1.4)) > 0.3, "mouth did not open"); assert(Math.max(...await mouthSamples(pg, 0, 0.4)) === 0, "open before speech");
});
edge("E22 A broken audio file shows a friendly error", async (pg) => {
  await loadVoice(pg, file("broken.mp3", Buffer.from("this is not audio at all"), "audio/mpeg"));
  assert(/couldn't read/i.test(await pg.textContent("#an-audioHint")), "no error message"); assert(await an(pg, () => window.__an.voice) === null, "voice set");
});
edge("E23 Switching the aspect ratio keeps the keyframes", async (pg) => {
  await pickProp(pg, "size"); await addKey(pg); await setT(pg, 2); await slider(pg, "an-size", 140);
  await pg.$eval('[data-anratio="1:1"]', (b) => b.click()); assert(await nKeys(pg, "size") === 2, "keys lost");
  near(await val(pg, "size", 2), 140, 0.01, "value");
});
edge("E24 Shortening the video below a key's time doesn't break the track", async (pg) => {
  await pickProp(pg, "size"); await setT(pg, 5); await addKey(pg); await slider(pg, "an-len", 2); await setT(pg, 1);
  const left = await pg.$eval(".kf-key", (e) => { const r = e.getBoundingClientRect(), p = e.parentElement.getBoundingClientRect(); return (r.left + r.width / 2 - p.left) / p.width; });
  assert(left <= 1.0, "diamond drawn outside the track"); assert(pg.errs.length === 0, pg.errs.join("; "));
});
edge("E25 Phone-size screen: clean first frame and no sideways scrolling", async (pg) => {
  const ph = await open({ viewport: { width: 390, height: 844 } });
  try {
    const s = await lumaStats(ph); assert(s.sd > 25, "washed first frame on phone");
    const over = await ph.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); assert(over <= 1, `page scrolls sideways by ${over}px`);
    assert(ph.errs.length === 0, ph.errs.join("; "));
  } finally { await ph.close2(); }
});

// =====================================================================
// Feature: zoom punch driven by the voice, and the new default avatar
// =====================================================================
feature("Voice zoom punch + new avatar");
const say = (t, amp) => amp * voiced(t);
// quiet talking 0.5–2.5 s, loud talking 3.5–5 s
const QUIET_LOUD = wav(6, (t) => (t >= 0.5 && t <= 2.5 ? say(t, 0.12) : t >= 3.5 && t <= 5 ? say(t, 0.95) : 0) + noise() * 0.003);
// normal talking, one emphasised phrase (2–3 s) and one shouted phrase (6–7 s)
const TWO_PEAKS = wav(8, (t) => (t >= 2 && t <= 3 ? say(t, 0.4) : t >= 6 && t <= 7 ? say(t, 1) : t > 0.3 ? say(t, 0.12) : 0) + noise() * 0.002);
const cams = (pg, a, b, step = 0.02) => an(pg, ([a, b, s]) => { const o = []; for (let t = a; t <= b + 1e-9; t += s) o.push(window.__an.pose(t, false).cam); return o; }, [a, b, step]);
const camAt = (pg, t) => an(pg, (t) => window.__an.pose(t, false).cam, t);
const segments = (arr, step) => { const seg = []; let st = -1; arr.forEach((v, i) => { if (v > 1 && st < 0) st = i; if ((v <= 1 || i === arr.length - 1) && st >= 0) { seg.push([st * step, (v > 1 ? i + 1 : i) * step]); st = -1; } }); return seg; };
const setMove = (pg, m, on) => pg.$eval(`[data-move="${m}"]`, (b, on) => { if ((b.getAttribute("aria-pressed") === "true") !== on) b.click(); }, on);
const art = (pg, pts) => an(pg, (pts) => { const a = window.__an.sampleArt(), x = a.c.getContext("2d"); return pts.map(([px, py]) => [...x.getImageData(px, py, 1, 1).data]); }, pts);
const regionDiff = (pg) => an(pg, () => { const c = window.__an.cv; return c.getContext("2d").getImageData(0, 0, c.width, c.height).data; });

// ---------- 25 real-use cases ----------
real("Z01 Without a voice clip the zoom punch never fires", async (pg) => {
  assert((await cams(pg, 0, 6, 0.05)).every((c) => c === 1), "camera zoomed without a voice");
});
real("Z02 With quiet and loud talking, punches happen only in the loud part", async (pg) => {
  await loadVoice(pg, file("ql.wav", QUIET_LOUD));
  assert((await cams(pg, 0, 3.4)).every((c) => c === 1), "punched during quiet talking");
  assert((await cams(pg, 3.5, 5)).some((c) => c > 1.1), "no punch in the loud part");
});
real("Z03 Punches move with the voice start offset", async (pg) => {
  await loadVoice(pg, file("ql.wav", QUIET_LOUD)); await slider(pg, "an-vStart", 2);
  assert((await cams(pg, 0, 5.4)).every((c) => c === 1), "punched before the shifted loud part");
  assert((await cams(pg, 5.5, 7)).some((c) => c > 1.1), "no punch after shifting");
});
real("Z04 Turning Zoom punch off removes the punches", async (pg) => {
  await loadVoice(pg, file("ql.wav", QUIET_LOUD)); await setMove(pg, "zoom", false);
  assert((await cams(pg, 0, 6)).every((c) => c === 1), "punched while off");
});
real("Z05 Louder moments punch harder", async (pg) => {
  await loadVoice(pg, file("peaks.wav", TWO_PEAKS));
  const a = Math.max(...await cams(pg, 2, 3.2)), b = Math.max(...await cams(pg, 6, 7.2));
  assert(a > 1 && b > a + 0.03, `medium ${a.toFixed(3)} vs loud ${b.toFixed(3)}`);
});
real("Z06 Move energy scales the punch size", async (pg) => {
  await loadVoice(pg, file("ql.wav", QUIET_LOUD)); await slider(pg, "an-energy", 50); const lo = Math.max(...await cams(pg, 3.5, 5));
  await slider(pg, "an-energy", 150); const hi = Math.max(...await cams(pg, 3.5, 5));
  assert(hi - 1 > (lo - 1) * 2.5, `energy 50: ${lo.toFixed(3)}, 150: ${hi.toFixed(3)}`);
});
real("Z07 Each punch holds for at least half a second", async (pg) => {
  await loadVoice(pg, file("peaks.wav", TWO_PEAKS)); const seg = segments(await cams(pg, 0, 8, 0.01), 0.01);
  assert(seg.length > 0 && seg.every(([a, b]) => b - a >= 0.48), "short punches: " + JSON.stringify(seg));
});
real("Z08 Punches start at least 1 s apart", async (pg) => {
  await loadVoice(pg, file("loud.wav", wav(6, (t) => say(t, 0.9) * (t > 0.3 ? 1 : 0) + noise() * 0.002)));
  const seg = segments(await cams(pg, 0, 6, 0.01), 0.01);
  for (let i = 1; i < seg.length; i++) assert(seg[i][0] - seg[i - 1][0] >= 0.99, "punches too close: " + JSON.stringify(seg));
});
real("Z09 The Moves tab says how many punches the voice gives", async (pg) => {
  await loadVoice(pg, file("ql.wav", QUIET_LOUD)); assert(/\d+ punch/.test(await pg.textContent("#an-zoomHint")), await pg.textContent("#an-zoomHint"));
});
real("Z10 Without a voice the Moves tab explains punches need one", async (pg) => {
  assert(/add a voice clip/i.test(await pg.textContent("#an-zoomHint")), "hint missing");
});
real("Z11 Removing the voice turns the punches off again", async (pg) => {
  await loadVoice(pg, file("ql.wav", QUIET_LOUD)); await pg.click("#an-audioClear");
  assert((await cams(pg, 0, 6)).every((c) => c === 1), "still punching"); assert(/add a voice clip/i.test(await pg.textContent("#an-zoomHint")), "hint not reset");
});
real("Z12 The preview visibly zooms in during a punch", async (pg) => {
  await loadVoice(pg, file("ql.wav", QUIET_LOUD)); await setMove(pg, "talk", false);
  const seg = segments(await cams(pg, 3.4, 5.2, 0.01), 0.01); assert(seg.length, "no punch");
  const tp = 3.4 + (seg[0][0] + seg[0][1]) / 2;
  await setT(pg, tp - 0.001 > 3.4 ? 3.0 : 3.0); const a = await regionDiff(pg); await setT(pg, tp); const b = await regionDiff(pg);
  let d = 0; for (let i = 0; i < a.length; i += 4 * 101) d += Math.abs(a[i] - b[i]); assert(d / (a.length / 404) > 6, "frame barely changed");
});
real("Z13 Exported video punches on the loud part", async (pg) => {
  try { execFileSync("ffprobe", ["-version"], { stdio: "ignore" }); } catch { throw new Skip("ffmpeg/ffprobe not installed"); }
  const can = await an(pg, async () => { try { return !!window.VideoEncoder && (await VideoEncoder.isConfigSupported({ codec: "avc1.640028", width: 1920, height: 1080 })).supported; } catch { return false; } });
  if (!can) throw new Skip("this browser has no H.264 encoder");
  await loadVoice(pg, file("ql.wav", QUIET_LOUD)); await setMove(pg, "talk", false); await setMove(pg, "slide", false); await setMove(pg, "bob", false);
  await setMove(pg, "headbob", false); await setMove(pg, "headtilt", false);
  const seg = segments(await cams(pg, 0, 6, 0.01), 0.01); assert(seg.length, "no punch");
  await pg.click('[data-antab="output"]'); await pg.selectOption("#an-container", "mp4");
  await pg.$eval("#an-exportBtn", (b) => b.click());
  await pg.waitForFunction(() => !document.getElementById("an-result").hidden, null, { timeout: 240000 });
  const b64 = await an(pg, async () => { const r = await fetch(document.getElementById("an-resultVideo").src); const a = new Uint8Array(await r.arrayBuffer()); let s = ""; for (let i = 0; i < a.length; i += 32768) s += String.fromCharCode.apply(null, a.subarray(i, i + 32768)); return btoa(s); });
  const f = path.join(os.tmpdir(), `an-punch-${process.pid}.mp4`); fs.writeFileSync(f, Buffer.from(b64, "base64"));
  const frame = (ss) => execFileSync("ffmpeg", ["-v", "error", "-ss", String(ss), "-i", f, "-frames:v", "1", "-vf", "scale=96:54", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
  const a = frame(2.9), b = frame((seg[0][0] + seg[0][1]) / 2), c = frame(2.95); fs.unlinkSync(f);
  let dPunch = 0, dSame = 0; for (let i = 0; i < a.length; i++) { dPunch += Math.abs(a[i] - b[i]); dSame += Math.abs(a[i] - c[i]); }
  assert(dPunch > dSame * 3 + a.length * 2, `export did not zoom (diff ${dPunch} vs still ${dSame})`);
});
real("Z14 Keyframing energy low at the start makes early punches small", async (pg) => {
  await loadVoice(pg, file("peaks.wav", TWO_PEAKS)); await pickProp(pg, "energy"); await slider(pg, "an-energy", 10); await setT(pg, 0); await addKey(pg); await setT(pg, 3.5); await addKey(pg);
  await setT(pg, 5.5); await slider(pg, "an-energy", 200);
  const early = Math.max(...await cams(pg, 2, 3.2)), late = Math.max(...await cams(pg, 6, 7.2));
  assert(early - 1 < 0.1 && late - 1 > 0.3, `early ${early.toFixed(3)}, late ${late.toFixed(3)}`);
});
real("A15 Default avatar wears a sage-green tee", async (pg) => {
  const [[r, g, b]] = await art(pg, [[330, 860]]); assert(g > r && g > b && g > 140 && g < 190, `shirt colour ${r},${g},${b}`);
});
real("A16 Default avatar has dark hair on top", async (pg) => {
  const px = await art(pg, [[430, 230], [510, 240]]); assert(px.every(([r, g, b, a]) => a > 200 && r < 50 && g < 40 && b < 40), JSON.stringify(px));
});
real("A17 Default avatar wears round gold glasses", async (pg) => {
  const px = await art(pg, [[365 - 64, 466], [535 + 64, 466], [365, 466 - 64]]);
  assert(px.every(([r, g, b]) => r > 170 && g > 130 && b < 120), "frame colour " + JSON.stringify(px));
});
real("A18 Default avatar has a dark leaf print on the shirt", async (pg) => {
  const dark = await an(pg, () => { const a = window.__an.sampleArt(), d = a.c.getContext("2d").getImageData(120, 930, 660, 150).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 50 && d[i + 1] < 70 && d[i + 2] > d[i] && d[i + 3] > 200) n++; return n / (d.length / 4); });
  assert(dark > 0.12, `only ${(dark * 100).toFixed(1)}% leaf print`);
});
real("A19 Default avatar has stubble: the jaw is darker than the forehead", async (pg) => {
  const l = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
  const [fh, jaw] = await art(pg, [[450, 360], [330, 650]]); assert(l(jaw) < l(fh) - 20, `jaw ${l(jaw)} vs forehead ${l(fh)}`);
});
real("A20 The mouth split sits on the avatar's mouth line", async (pg) => {
  const m = await an(pg, () => window.__an.sampleArt().mouth); near(m.y, 603, 6, "mouth y");
  const col = await art(pg, Array.from({ length: 16 }, (_, i) => [452, m.y - 6 + i])); assert(col.some(([r, g, b]) => r < 60 && g < 60 && b < 60), "no mouth line near the split");
});
real("A21 The avatar's jaw opens when it talks", async (pg) => {
  await setMove(pg, "bob", false); await setMove(pg, "headbob", false); await setMove(pg, "headtilt", false); await setMove(pg, "slide", false); await setMove(pg, "zoom", false);
  const t = await an(pg, () => { let best = 0, bt = 1; for (let t = 1; t < 3; t += 0.01) { const v = window.__an.mouthOpen(t); if (v > best) { best = v; bt = t; } } return bt; });
  const closed = await an(pg, () => { for (let t = 1; t < 5; t += 0.01) if (window.__an.mouthOpen(t) === 0) return t; return 0; });
  await setT(pg, closed); const a = await regionDiff(pg); await setT(pg, t); const b = await regionDiff(pg);
  let d = 0; for (let i = 0; i < a.length; i += 4 * 7) d += Math.abs(a[i] - b[i]); assert(d > 2000, "jaw didn't move");
});
real("A22 Opening your own photo replaces the avatar", async (pg) => {
  const png = Buffer.from(await an(pg, () => { const c = document.createElement("canvas"); c.width = 400; c.height = 500; const x = c.getContext("2d"); x.fillStyle = "#335"; x.fillRect(0, 0, 400, 500); x.fillStyle = "#fc9"; x.beginPath(); x.arc(200, 200, 90, 0, 7); x.fill(); return c.toDataURL().split(",")[1]; }), "base64");
  await pg.setInputFiles("#an-file", { name: "me.png", mimeType: "image/png", buffer: png }); await pg.waitForTimeout(600);
  assert(!/sample character/i.test(await pg.textContent("#an-photoHint")), "still on the sample");
});
real("A23 The avatar animates for 6 s of frames without errors", async (pg) => {
  await an(pg, () => { for (let t = 0; t < 6; t += 1 / 15) window.__an.t = t; });
  assert(pg.errs.length === 0, pg.errs.join("; "));
});
real("A24 The avatar art has a transparent background around it", async (pg) => {
  const px = await art(pg, [[5, 5], [890, 5], [5, 600], [890, 600]]); assert(px.every((p) => p[3] === 0), JSON.stringify(px));
});
real("A25 The avatar fills the lower middle of the 16:9 frame", async (pg) => {
  const p = await an(pg, () => { const c = window.__an.cv; return [...c.getContext("2d").getImageData(c.width * 0.5, c.height * 0.85, 1, 1).data]; });
  assert(p[1] > p[0] && p[1] > p[2], `expected the green tee at the bottom middle, got ${p}`);
});

// ---------- 25 edge cases ----------
edge("ZE01 A silent clip gives no punches", async (pg) => {
  await loadVoice(pg, file("silent.wav", wav(3, () => 0))); assert((await cams(pg, 0, 3)).every((c) => c === 1), "punched on silence");
  assert(/no loud moments/.test(await pg.textContent("#an-zoomHint")), await pg.textContent("#an-zoomHint"));
});
edge("ZE02 Noise alone gives no punches", async (pg) => {
  await loadVoice(pg, file("noise.wav", wav(3, () => noise() * 0.05))); assert((await cams(pg, 0, 3)).every((c) => c === 1), "punched on noise");
});
edge("ZE03 Non-stop loud talking still spaces punches and caps their length", async (pg) => {
  await loadVoice(pg, file("rant.wav", wav(10, (t) => say(t, 0.9) + noise() * 0.002)));
  const seg = segments(await cams(pg, 0, 10, 0.01), 0.01);
  assert(seg.every(([a, b]) => b - a <= 2.05), "punch longer than 2 s: " + JSON.stringify(seg));
});
edge("ZE04 A clipped, distorted clip never zooms past the limit", async (pg) => {
  await loadVoice(pg, file("clip.wav", wav(3, (t) => (t > 0.5 && t < 2.5 ? Math.sign(Math.sin(2 * Math.PI * 150 * t)) * (t < 1.5 ? 0.3 : 1) : 0))));
  await slider(pg, "an-energy", 200); assert((await cams(pg, 0, 3)).every((c) => c >= 1 && c <= 1 + 0.28 * 1.4 + 1e-6), "zoom out of range");
});
edge("ZE05 A 0.2 s clip loads and punches at most once", async (pg) => {
  await loadVoice(pg, file("blip.wav", wav(0.2, (t) => say(t + 0.1, 0.9))));
  assert(segments(await cams(pg, 0, 0.3, 0.005), 0.005).length <= 1, "more than one punch");
});
edge("ZE06 A voice started at 20 s still punches there", async (pg) => {
  await loadVoice(pg, file("ql.wav", QUIET_LOUD)); await slider(pg, "an-vStart", 20);
  assert(await an(pg, () => window.__an.duration()) >= 26, "video not extended");
  assert((await cams(pg, 23.5, 25)).some((c) => c > 1.1), "no punch at the shifted time");
});
edge("ZE07 Exactly at the voice start and end the zoom is valid", async (pg) => {
  await loadVoice(pg, file("ql.wav", QUIET_LOUD)); await slider(pg, "an-vStart", 1);
  for (const t of [1, 1 + 6, 1 + 5.9999]) { const c = await camAt(pg, t); assert(Number.isFinite(c) && c >= 1, `bad zoom ${c} at ${t}`); }
});
edge("ZE08 Times before 0 or after the clip give no zoom", async (pg) => {
  await loadVoice(pg, file("ql.wav", QUIET_LOUD)); for (const t of [-1, 6.5, 99]) assert(await camAt(pg, t) === 1, "zoom at " + t);
});
edge("ZE09 Minimum energy still gives a small visible punch", async (pg) => {
  await loadVoice(pg, file("ql.wav", QUIET_LOUD)); await slider(pg, "an-energy", 10); const m = Math.max(...await cams(pg, 3.5, 5));
  assert(m > 1.01 && m < 1.05, "punch size " + m);
});
edge("ZE10 Maximum energy is capped", async (pg) => {
  await loadVoice(pg, file("ql.wav", QUIET_LOUD)); await slider(pg, "an-energy", 200); assert(Math.max(...await cams(pg, 0, 6)) <= 1 + 0.28 * 1.4 + 1e-6, "over the cap");
});
edge("ZE11 The editing view (paused at a key) shows no punch", async (pg) => {
  await loadVoice(pg, file("ql.wav", QUIET_LOUD)); assert(await an(pg, () => window.__an.pose(4, true).cam) === 1, "rest pose zoomed");
});
edge("ZE12 Voice only on the right channel still punches", async (pg) => {
  await loadVoice(pg, file("right.wav", wav(6, (t, c) => (c === 1 ? (t >= 0.5 && t <= 2.5 ? say(t, 0.1) : t >= 3.5 && t <= 5 ? say(t, 0.95) : 0) : 0) + noise() * 0.002, { channels: 2 })));
  assert((await cams(pg, 3.5, 5)).some((c) => c > 1.1), "no punch");
});
edge("ZE13 A shout in the last moment of the clip doesn't overrun", async (pg) => {
  await loadVoice(pg, file("end.wav", wav(3, (t) => (t > 0.3 && t < 2.6 ? say(t, 0.08) : t >= 2.8 ? say(t, 1) : 0))));
  const c = await cams(pg, 2.7, 3.2, 0.01); assert(c.every(Number.isFinite), "NaN zoom"); assert(await camAt(pg, 3.05) === 1, "zoom after the clip ended");
});
edge("ZE14 Toggling zoom punch off and on keeps the same punches", async (pg) => {
  await loadVoice(pg, file("ql.wav", QUIET_LOUD)); const a = await cams(pg, 0, 6, 0.05);
  await setMove(pg, "zoom", false); await setMove(pg, "zoom", true); const b = await cams(pg, 0, 6, 0.05);
  assert(JSON.stringify(a) === JSON.stringify(b), "punches changed");
});
edge("ZE15 Replacing the voice clip recalculates the punches", async (pg) => {
  await loadVoice(pg, file("silent.wav", wav(3, () => 0))); await loadVoice(pg, file("ql.wav", QUIET_LOUD));
  assert((await cams(pg, 3.5, 5)).some((c) => c > 1.1), "punches not recalculated");
});
edge("ZE16 A 35 s clip spreads punches at least 1 s apart", async (pg) => {
  await loadVoice(pg, file("long.wav", wav(35, (t) => (t % 3 < 1.5 ? say(t, (t % 6 < 3 ? 0.9 : 0.15)) : 0) + noise() * 0.002, { sr: 16000 })));
  const seg = segments(await cams(pg, 0, 35, 0.02), 0.02); assert(seg.length >= 3, "too few punches: " + seg.length);
  for (let i = 1; i < seg.length; i++) assert(seg[i][0] - seg[i - 1][0] >= 0.98, "too close");
});
edge("ZE17 Rapid loud/quiet syllables don't make the camera jitter", async (pg) => {
  await loadVoice(pg, file("stutter.wav", wav(6, (t) => say(t, (Math.floor(t / 0.2) % 2 ? 0.95 : 0.1)) + noise() * 0.002)));
  const seg = segments(await cams(pg, 0, 6, 0.01), 0.01); assert(seg.every(([a, b]) => b - a >= 0.48), "jittery punches " + JSON.stringify(seg));
});
edge("ZE18 Punch works in 9:16", async (pg) => {
  await pg.$eval('[data-anratio="9:16"]', (b) => b.click()); await loadVoice(pg, file("ql.wav", QUIET_LOUD));
  await an(pg, () => { for (let t = 3.5; t < 5; t += 0.1) window.__an.t = t; }); assert(pg.errs.length === 0, pg.errs.join("; "));
});
edge("ZE19 Avatar fits a 9:16 frame", async (pg) => {
  await pg.$eval('[data-anratio="9:16"]', (b) => b.click()); await setT(pg, 0);
  const p = await an(pg, () => { const c = window.__an.cv; return [...c.getContext("2d").getImageData(c.width * 0.5, c.height * 0.95, 1, 1).data]; });
  assert(p[1] > p[0] && p[1] > p[2], "avatar not at the bottom of the 9:16 frame: " + p);
});
edge("ZE20 Mirrored avatar renders", async (pg) => {
  await pg.click("#an-flip"); const s = await lumaStats(pg); assert(s.sd > 25, "blank after flip");
});
edge("ZE21 Avatar at 20% and 250% size renders", async (pg) => {
  for (const v of [20, 250]) { await slider(pg, "an-size", v); const s = await lumaStats(pg); assert(s.sd > 10, "blank at " + v); }
});
edge("ZE22 Paper edge 0 and 40 render", async (pg) => {
  for (const v of [0, 40]) { await slider(pg, "an-outline", v); await setT(pg, 0.5); } assert(pg.errs.length === 0, pg.errs.join("; "));
});
edge("ZE23 Drop shadow off still renders the avatar", async (pg) => {
  await pg.$eval("#an-shadow", (c) => { c.checked = false; c.dispatchEvent(new Event("change", { bubbles: true })); }); const s = await lumaStats(pg); assert(s.sd > 25, "blank");
});
edge("ZE24 Jaw width at its extremes renders", async (pg) => {
  for (const v of [6, 45]) { await slider(pg, "an-jaw", v); await setT(pg, 1.3); } assert(pg.errs.length === 0, pg.errs.join("; "));
});
edge("ZE25 Phone screen shows the avatar on first load", async (pg) => {
  const ph = await open({ viewport: { width: 390, height: 844 } });
  try {
    const p = await ph.evaluate(() => { const c = window.__an.cv; return [...c.getContext("2d").getImageData(c.width * 0.5, c.height * 0.85, 1, 1).data]; });
    assert(p[1] > p[0] && p[1] > p[2], "avatar missing on phone: " + p);
  } finally { await ph.close2(); }
});

// ---------- runner ----------
(async () => {
  srv = await serve(); base = `http://localhost:${srv.address().port}`;
  browser = await chromium.launch();
  const list = tests.filter((t) => !ONLY || ONLY.test(t.name));
  let pass = 0, fail = 0, skip = 0; const failures = [];
  for (const t of list) {
    const t0 = Date.now(); let pg;
    try {
      pg = await open(); await t.fn(pg);
      if (pg.errs.length) throw new Error("page errors: " + pg.errs.join("; "));
      pass++; console.log(`  ✓ ${t.name} (${Date.now() - t0} ms)`);
    } catch (e) {
      if (e instanceof Skip) { skip++; console.log(`  - ${t.name} (skipped: ${e.message})`); }
      else { fail++; failures.push([t.name, e.message]); console.log(`  ✗ ${t.name}\n      ${e.message}`); }
    } finally { if (pg) await pg.close2().catch(() => {}); }
  }
  console.log("");
  for (const f of [...new Set(list.map((t) => t.feature))]) { const ts = list.filter((t) => t.feature === f); console.log(`  ${f}: ${ts.filter((t) => t.kind === "real").length} real-use + ${ts.filter((t) => t.kind === "edge").length} edge cases`); }
  console.log(`${pass} passed, ${fail} failed, ${skip} skipped  (${list.length} tests)`);
  await browser.close(); srv.close(); process.exit(fail ? 1 : 0);
})();
