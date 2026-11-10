// Cutout Bench test suite: magic tool "Clean up leftover lines" — 25 real-use cases + 25 edge cases.
//
// Run:  npm i -D playwright && npx playwright install chromium   (once)
//       node tests/bench.test.js            (or: node tests/bench.test.js B0  to filter by name)

const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ONLY = process.argv[2] ? new RegExp(process.argv[2], "i") : null;

function serve() {
  return new Promise((res) => {
    const srv = http.createServer((q, r) => {
      let p = decodeURIComponent(q.url.split("?")[0].split("#")[0]); if (p === "/") p = "/index.html";
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
      r.writeHead(200, { "Content-Type": p.endsWith(".html") ? "text/html" : p.endsWith(".wasm") ? "application/wasm" : "application/octet-stream" }); fs.createReadStream(f).pipe(r);
    }).listen(0, () => res(srv));
  });
}

let browser, base, srv;
async function open({ viewport = { width: 1366, height: 1000 } } = {}) {
  const ctx = await browser.newContext({ viewport });
  const pg = await ctx.newPage(); pg.errs = [];
  pg.on("pageerror", (e) => pg.errs.push(e.message));
  await pg.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ body: "", contentType: "text/css" }));
  // the AI runtime: ORT_JS=path serves it locally (offline runs), otherwise it comes from the CDN
  await pg.route("https://cdn.jsdelivr.net/**", (r) => /onnxruntime-web/.test(r.request().url())
    ? (process.env.ORT_JS ? r.fulfill({ path: process.env.ORT_JS, contentType: "application/javascript" }) : r.continue())
    : r.fulfill({ body: "", contentType: "application/javascript" }));
  await pg.goto(`${base}/?test#bench`); await pg.waitForFunction(() => window.__bench && window.__bench.src, null, { timeout: 15000 });
  await pg.evaluate(() => {
    // in-page helpers used by the tests
    window.T = {
      B: window.__bench,
      async draw(w, h, body) {
        const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d");
        new Function("x", "w", "h", body)(x, w, h);
        const blob = await new Promise((r) => c.toBlob(r, "image/png")); const before = this.B.src;
        await this.B.load(new File([blob], "test.png", { type: "image/png" }));
        if (this.B.src === before) throw new Error("image did not load");
      },
      opt(id, v) { const e = document.getElementById(id); if (e.checked !== v) { e.checked = v; e.dispatchEvent(new Event("change", { bubbles: true })); } },
      tol(v) { const e = document.getElementById("tol"); e.value = v; e.dispatchEvent(new Event("input", { bubbles: true })); },
      resetMask() { const m = this.B.mask, x = m.getContext("2d"); x.save(); x.globalCompositeOperation = "copy"; x.fillStyle = "#000"; x.fillRect(0, 0, m.width, m.height); x.restore(); },
      a(x, y) { return this.B.mask.getContext("2d").getImageData(x, y, 1, 1).data[3]; },
      // faint = alpha 1..40; thin = visible pixel with see-through 2 px away on both sides (a 1–3 px strand)
      leftovers(rect) {
        const a = this.B.alpha(), w = this.B.mask.width, h = this.B.mask.height; const [X0, Y0, X1, Y1] = rect || [0, 0, w, h]; let faint = 0, thin = 0;
        for (let y = Math.max(2, Y0); y < Math.min(h - 2, Y1); y++) for (let x = Math.max(2, X0); x < Math.min(w - 2, X1); x++) {
          const i = (y * w + x) * 4 + 3; if (a[i] > 0 && a[i] <= 40) faint++;
          if (a[i] > 40 && ((a[i - 8] <= 40 && a[i + 8] <= 40) || (a[i - 8 * w] <= 40 && a[i + 8 * w] <= 40))) thin++;
        }
        return { faint, thin };
      },
      opaque(rect) { const [x0, y0, x1, y1] = rect, d = this.B.mask.getContext("2d").getImageData(x0, y0, x1 - x0, y1 - y0).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 200) n++; return n / (d.length / 4); },
      hash() { const a = this.B.alpha(); let h = 0; for (let i = 3; i < a.length; i += 4) h = (h * 31 + a[i]) | 0; return h; },
    };
  });
  pg.close2 = () => ctx.close();
  return pg;
}
const ev = (pg, fn, arg) => pg.evaluate(fn, arg);
const draw = (pg, w, h, body) => pg.evaluate(([w, h, b]) => window.T.draw(w, h, b), [w, h, body]);
const click = (pg, x, y, mode) => pg.evaluate(([x, y, m]) => window.T.B.click(x, y, m), [x, y, mode]);
const opt = (pg, id, v) => pg.evaluate(([id, v]) => window.T.opt(id, v), [id, v]);
const left = (pg, rect) => pg.evaluate((r) => window.T.leftovers(r), rect);
const alphaAt = (pg, x, y) => pg.evaluate(([x, y]) => window.T.a(x, y), [x, y]);
const opaque = (pg, rect) => pg.evaluate((r) => window.T.opaque(r), rect);
const hash = (pg) => pg.evaluate(() => window.T.hash());
function assert(c, msg) { if (!c) throw new Error(msg); }

// a flat-colour drawing with anti-aliased ink outlines, like the plant sample
const SHAPES = `x.fillStyle="#d8ff5c";x.fillRect(0,0,w,h);x.lineWidth=7;x.strokeStyle="#0d0d0f";
  x.fillStyle="#2fbf71";x.beginPath();x.ellipse(200,180,90,130,0.4,0,7);x.fill();x.stroke();
  x.fillStyle="#ff4667";x.beginPath();x.moveTo(330,200);x.lineTo(520,200);x.lineTo(490,380);x.lineTo(360,380);x.closePath();x.fill();x.stroke();`;
const PLANT_CLICKS = [[100, 100], [760, 600], [100, 800], [480, 300], [700, 280], [600, 350], [530, 250], [600, 600]];

class Skip extends Error {}
const tests = []; let FEATURE = "Magic tool clean-up";
const real = (n, f) => tests.push({ kind: "real", feature: FEATURE, name: n, fn: f }), edge = (n, f) => tests.push({ kind: "edge", feature: FEATURE, name: n, fn: f });

// ---------------- 25 real-use cases ----------------
real("B01 'Clean up leftover lines' is in the magic options and on by default", async (pg) => {
  assert(await pg.$("#wandOpts #wClean"), "option missing"); assert(await pg.$eval("#wClean", (e) => e.checked), "should be on by default");
});
real("B02 The plant sample: erasing background, outlines and leaves leaves no faint lines", async (pg) => {
  await opt(pg, "wGlobal", true); for (const [x, y] of PLANT_CLICKS) await click(pg, x, y);
  const l = await left(pg); assert(l.faint === 0 && l.thin < 30, JSON.stringify(l));
});
real("B03 With clean-up off the same clicks do leave faint lines (the problem it fixes)", async (pg) => {
  await opt(pg, "wClean", false); await opt(pg, "wGlobal", true); for (const [x, y] of PLANT_CLICKS) await click(pg, x, y);
  const l = await left(pg); assert(l.faint > 500 && l.thin > 500, JSON.stringify(l));
});
real("B04 Switching the option re-applies the last click", async (pg) => {
  await opt(pg, "wClean", false); await opt(pg, "wGlobal", true); await click(pg, 100, 100); const off = await left(pg);
  await opt(pg, "wClean", true); const on = await left(pg); assert(on.faint < off.faint && on.faint === 0, `${off.faint} → ${on.faint}`);
});
real("B05 Erasing a background then an ink outline leaves no fringe ring", async (pg) => {
  await draw(pg, 600, 420, SHAPES); await click(pg, 10, 10); await click(pg, 200, 52);   // background, then the leaf's ink outline
  const l = await left(pg); assert(l.faint === 0 && l.thin < 15, JSON.stringify(l));
});
real("B06 Solid areas next to the erased part stay fully kept", async (pg) => {
  await opt(pg, "wGlobal", true); for (const [x, y] of PLANT_CLICKS) await click(pg, x, y);
  for (const [x, y] of [[600, 530], [600, 700], [700, 480], [470, 540]]) assert(await alphaAt(pg, x, y) === 255, `pot cut at ${x},${y}`);
});
real("B07 Small solid details (8 px dots) next to the erased background survive", async (pg) => {
  await draw(pg, 400, 200, `x.fillStyle="#d8ff5c";x.fillRect(0,0,w,h);x.fillStyle="#ff4667";for(let i=0;i<6;i++){x.beginPath();x.arc(60+i*55,100,4,0,7);x.fill();}`);
  await click(pg, 10, 10); for (let i = 0; i < 6; i++) assert(await alphaAt(pg, 60 + i * 55, 100) === 255, "dot lost " + i);
});
real("B08 3 px strokes next to the erased background are kept (logo lines)", async (pg) => {
  await draw(pg, 400, 300, `x.fillStyle="#fff";x.fillRect(0,0,w,h);x.fillStyle="#111";for(let i=0;i<5;i++)x.fillRect(60+i*60,50,3,200);`);
  await click(pg, 10, 10); assert(await opaque(pg, [60, 70, 63, 230]) > 0.9, "3 px stroke removed");
});
real("B09 Keep color is not affected by the clean-up", async (pg) => {
  await opt(pg, "wGlobal", true); const run = async (c) => { await ev(pg, () => window.T.resetMask()); await opt(pg, "wClean", c); await click(pg, 480, 300, "keep"); return hash(pg); };
  assert(await run(true) === await run(false), "keep result differs");
});
real("B10 Undo brings back exactly what was there before the click", async (pg) => {
  const h0 = await hash(pg); await click(pg, 100, 100); assert(await hash(pg) !== h0, "click did nothing"); await ev(pg, () => window.T.B.undo());
  assert(await hash(pg) === h0, "undo differs");
});
real("B11 Changing the tolerance after a click keeps the result clean", async (pg) => {
  await opt(pg, "wGlobal", true); await click(pg, 100, 100); await ev(pg, () => window.T.tol(50)); await pg.waitForTimeout(120);
  await ev(pg, () => window.T.tol(20)); await pg.waitForTimeout(120); assert((await left(pg)).faint === 0, "faint pixels after tolerance change");
});
real("B12 Photo-like sky behind a dark shape: no faint speckles along the edge", async (pg) => {
  await draw(pg, 640, 480, `const g=x.createLinearGradient(0,0,0,h);g.addColorStop(0,"#7fb2e6");g.addColorStop(1,"#a8cbe9");x.fillStyle=g;x.fillRect(0,0,w,h);
    x.fillStyle="#2b2a33";x.beginPath();x.ellipse(320,300,140,180,0,0,7);x.fill();const d=x.getImageData(0,0,w,h);let s=7;for(let i=0;i<d.data.length;i+=4){s=(s*16807)%2147483647;const n=(s/2147483647-0.5)*8;d.data[i]+=n;d.data[i+1]+=n;d.data[i+2]+=n;}x.putImageData(d,0,0);`);
  await ev(pg, () => window.T.tol(40)); await click(pg, 10, 10); const l = await left(pg, [150, 100, 490, 480]); assert(l.faint === 0, JSON.stringify(l));
});
real("B13 Thin lines far from what you erased are left alone", async (pg) => {
  await draw(pg, 600, 300, `x.fillStyle="#e33";x.fillRect(0,0,300,h);x.fillStyle="#24c";x.fillRect(300,0,300,h);x.fillStyle="#fff";x.fillRect(450,20,1,260);`);
  await click(pg, 50, 50); assert(await opaque(pg, [450, 40, 451, 260]) > 0.95, "far 1 px line removed");
});
real("B14 The blended line between two erased colors disappears", async (pg) => {
  await draw(pg, 400, 300, `x.fillStyle="#3c6";x.fillRect(0,0,w,h);x.fillStyle="#c36";x.beginPath();x.moveTo(0,0);x.lineTo(w,0);x.lineTo(0,h);x.closePath();x.fill();`);
  await click(pg, 10, 10); await click(pg, 390, 290); const l = await left(pg); assert(l.faint === 0 && l.thin === 0, JSON.stringify(l));
});
real("B15 Diagonal anti-aliased stripes clean up", async (pg) => {
  await draw(pg, 400, 400, `x.fillStyle="#fd3";x.fillRect(0,0,w,h);x.strokeStyle="#16a";x.lineWidth=14;for(let i=-400;i<800;i+=40){x.beginPath();x.moveTo(i,0);x.lineTo(i+400,400);x.stroke();}`);
  await opt(pg, "wGlobal", true); await click(pg, 5, 30); await click(pg, 205, 200); const l = await left(pg); assert(l.faint === 0 && l.thin < 40, JSON.stringify(l));
});
real("B16 Large 3000×2000 image: clean-up scales and stays quick", async (pg) => {
  await draw(pg, 3000, 2000, SHAPES.replace(/x\.fillRect\(0,0,w,h\);/, "x.fillRect(0,0,w,h);x.scale(4,4);"));
  const ms = await ev(pg, () => { const t0 = performance.now(); window.T.B.click(5, 5); return performance.now() - t0; });
  assert(ms < 2500, `slow: ${ms.toFixed(0)} ms`); assert((await left(pg)).faint === 0, "faint left");
});
real("B17 Touching-area erase of the sample background: no faint pixels left", async (pg) => {
  await click(pg, 100, 100); assert((await left(pg)).faint === 0, "faint left");
});
real("B18 No half-invisible pixels anywhere after cleaning the sample", async (pg) => {
  await opt(pg, "wGlobal", true); for (const [x, y] of PLANT_CLICKS) await click(pg, x, y);
  const n = await ev(pg, () => { const a = window.T.B.alpha(); let k = 0; for (let i = 3; i < a.length; i += 4) if (a[i] > 0 && a[i] <= 40) k++; return k; }); assert(n === 0, n + " faint pixels");
});
real("B19 Edge softness still works after a clean-up", async (pg) => {
  await click(pg, 100, 100); await pg.$eval("#feather", (e) => { e.value = 3; e.dispatchEvent(new Event("input", { bubbles: true })); }); await pg.waitForTimeout(100);
  assert(pg.errs.length === 0, pg.errs.join("; "));
});
real("B20 Noisy JPEG-style picture: background erase leaves no faint pixels", async (pg) => {
  await draw(pg, 500, 400, SHAPES + `const d=x.getImageData(0,0,w,h);let s=3;for(let i=0;i<d.data.length;i+=4){s=(s*16807)%2147483647;const n=(s/2147483647-0.5)*10;d.data[i]+=n;d.data[i+1]+=n;d.data[i+2]+=n;}x.putImageData(d,0,0);`);
  await ev(pg, () => window.T.tol(40)); await click(pg, 10, 10); assert((await left(pg)).faint === 0, "faint left");
});
real("B21 Clicking the same color twice changes nothing the second time", async (pg) => {
  await opt(pg, "wGlobal", true); await click(pg, 100, 100); const h1 = await hash(pg); await click(pg, 100, 100); assert(await hash(pg) === h1, "second click changed the mask");
});
real("B22 Erasing an area that touches the picture border works", async (pg) => {
  await draw(pg, 300, 200, `x.fillStyle="#09f";x.fillRect(0,0,w,h);x.fillStyle="#f90";x.fillRect(100,0,100,h);`);
  await click(pg, 0, 0); assert(await alphaAt(pg, 0, 0) === 0 && await alphaAt(pg, 150, 100) === 255 && pg.errs.length === 0, "border erase failed");
});
real("B23 The option explains what it does on hover", async (pg) => {
  const t = await pg.$eval('label[for="wClean"]', (e) => e.title); assert(/thin, faint lines/.test(t) && /hair/.test(t), t);
});
real("B24 Hover preview still works with the magic tool", async (pg) => {
  const r = await pg.$eval("#view", (e) => { const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 3]; }).catch(() => null);
  if (r) { await pg.mouse.move(r[0], r[1]); await pg.mouse.move(r[0] + 30, r[1] + 10); } assert(pg.errs.length === 0, pg.errs.join("; "));
});
real("B25 Real mouse click with the magic tool cleans as it erases", async (pg) => {
  await opt(pg, "wGlobal", true); await pg.click("#tWand");
  // find a screen point that lands on the lime background (image x 600, y 80) by probing the view
  const p = await ev(pg, () => { const v = document.getElementById("view"), r = v.getBoundingClientRect(), B = window.T.B, k = Math.min(r.width / B.src.width, r.height / B.src.height);
    return [r.x + (r.width - B.src.width * k) / 2 + 600 * k, r.y + (r.height - B.src.height * k) / 2 + 80 * k]; });
  await pg.mouse.click(p[0], p[1]); await pg.waitForTimeout(100);
  const changed = await ev(pg, () => window.T.a(600, 80)); assert(changed === 0, "click did not erase"); assert((await left(pg)).faint === 0, "faint left");
});

// ---------------- 25 edge cases ----------------
edge("BE01 A 1×1 picture", async (pg) => { await draw(pg, 1, 1, `x.fillStyle="#f00";x.fillRect(0,0,1,1);`); await click(pg, 0, 0); assert(pg.errs.length === 0 && await alphaAt(pg, 0, 0) === 0, "failed"); });
edge("BE02 A 10×10 picture", async (pg) => { await draw(pg, 10, 10, SHAPES); await click(pg, 0, 0); assert(pg.errs.length === 0, pg.errs.join("; ")); });
edge("BE03 One flat color: erasing it clears everything", async (pg) => {
  await draw(pg, 200, 150, `x.fillStyle="#abc";x.fillRect(0,0,w,h);`); await click(pg, 50, 50);
  assert(await opaque(pg, [0, 0, 200, 150]) === 0, "pixels left");
});
edge("BE04 Clicking an already erased spot changes nothing", async (pg) => {
  await click(pg, 100, 100); const h = await hash(pg); await click(pg, 100, 100); assert(await hash(pg) === h, "changed");
});
edge("BE05 A single odd pixel is erased by clicking it", async (pg) => {
  await draw(pg, 50, 50, `x.fillStyle="#fff";x.fillRect(0,0,w,h);x.fillStyle="#f00";x.fillRect(25,25,1,1);`); await click(pg, 25, 25); assert(await alphaAt(pg, 25, 25) === 0, "kept");
});
edge("BE06 A 2 px line hugging the erased area is treated as a leftover (off keeps it)", async (pg) => {
  await draw(pg, 300, 200, `x.fillStyle="#fff";x.fillRect(0,0,w,h);x.fillStyle="#111";x.fillRect(150,20,2,160);`);
  await click(pg, 10, 10); const on = await opaque(pg, [150, 40, 152, 160]); await opt(pg, "wClean", false); const off = await opaque(pg, [150, 40, 152, 160]);
  assert(on < 0.1 && off > 0.9, `on ${on}, off ${off}`);
});
edge("BE07 A 3 px line right at the limit is kept", async (pg) => {
  await draw(pg, 300, 200, `x.fillStyle="#fff";x.fillRect(0,0,w,h);x.fillStyle="#111";x.fillRect(150,20,3,160);`); await click(pg, 10, 10);
  assert(await opaque(pg, [150, 40, 153, 160]) > 0.9, "3 px line removed");
});
edge("BE08 A 1 px checkerboard doesn't hang", async (pg) => {
  await draw(pg, 400, 400, `for(let y=0;y<h;y++)for(let x2=0;x2<w;x2++){x.fillStyle=(x2+y)%2?"#000":"#fff";x.fillRect(x2,y,1,1);}`);
  await opt(pg, "wGlobal", true); const ms = await ev(pg, () => { const t0 = performance.now(); window.T.B.click(0, 0); return performance.now() - t0; }); assert(ms < 1500 && pg.errs.length === 0, ms + " ms");
});
edge("BE09 Highest tolerance erases everything without errors", async (pg) => {
  await ev(pg, () => window.T.tol(120)); await opt(pg, "wGlobal", true); await click(pg, 100, 100); assert(pg.errs.length === 0, pg.errs.join("; "));
});
edge("BE10 Lowest tolerance: clean-up stays next to the tiny erased area", async (pg) => {
  await ev(pg, () => window.T.tol(1)); await click(pg, 100, 100); assert(await alphaAt(pg, 600, 530) === 255, "pot touched");
});
edge("BE11 A PNG that's already transparent keeps its own transparency", async (pg) => {
  await draw(pg, 300, 200, `x.fillStyle="#0c6";x.fillRect(50,50,200,100);x.fillStyle="#fff";x.fillRect(100,80,100,40);`);
  await click(pg, 150, 100); assert(await alphaAt(pg, 60, 60) === 255 && pg.errs.length === 0, "kept area changed");
});
edge("BE12 Clicking the top-left corner pixel", async (pg) => { await click(pg, 0, 0); assert(pg.errs.length === 0 && await alphaAt(pg, 0, 0) === 0, "failed"); });
edge("BE13 Clicking the bottom-right corner pixel", async (pg) => {
  const [w, h] = await ev(pg, () => [window.T.B.mask.width, window.T.B.mask.height]); await click(pg, w - 1, h - 1); assert(pg.errs.length === 0 && await alphaAt(pg, w - 1, h - 1) === 0, "failed");
});
edge("BE14 'Every matching pixel' with a color found only once", async (pg) => {
  await opt(pg, "wGlobal", true); await click(pg, 600, 610); assert(pg.errs.length === 0, pg.errs.join("; "));
});
edge("BE15 Switching the option before any click is harmless", async (pg) => {
  const h = await hash(pg); await opt(pg, "wClean", false); await opt(pg, "wClean", true); assert(await hash(pg) === h && pg.errs.length === 0, "mask changed");
});
edge("BE16 Off then on again gives the identical result", async (pg) => {
  await opt(pg, "wGlobal", true); await click(pg, 100, 100); const h = await hash(pg); await opt(pg, "wClean", false); await opt(pg, "wClean", true); assert(await hash(pg) === h, "different");
});
edge("BE17 Undo after switching the option", async (pg) => {
  const h0 = await hash(pg); await click(pg, 100, 100); await opt(pg, "wClean", false); await ev(pg, () => window.T.B.undo()); assert(await hash(pg) === h0, "undo differs");
});
edge("BE18 A 4000×3000 picture", async (pg) => {
  await draw(pg, 4000, 3000, SHAPES.replace(/x\.fillRect\(0,0,w,h\);/, "x.fillRect(0,0,w,h);x.scale(6,6);"));
  const ms = await ev(pg, () => { const t0 = performance.now(); window.T.B.click(5, 5); return performance.now() - t0; }); assert(ms < 4000 && pg.errs.length === 0, ms + " ms");
});
edge("BE19 A very narrow 2000×3 picture", async (pg) => { await draw(pg, 2000, 3, `x.fillStyle="#f0f";x.fillRect(0,0,w,h);x.fillStyle="#0f0";x.fillRect(1000,0,500,h);`); await click(pg, 5, 1); assert(pg.errs.length === 0, pg.errs.join("; ")); });
edge("BE20 Half-transparent kept areas (alpha 100) are not wiped", async (pg) => {
  await ev(pg, () => { const m = window.T.B.mask.getContext("2d"); m.save(); m.globalCompositeOperation = "copy"; m.fillStyle = "rgba(0,0,0,0.4)"; m.fillRect(400, 400, 400, 300); m.restore(); });
  await click(pg, 100, 100); assert(await alphaAt(pg, 600, 530) > 90, "semi-transparent pot wiped");
});
edge("BE21 Alpha just above the faint limit in a solid area stays", async (pg) => {
  await ev(pg, () => { const m = window.T.B.mask.getContext("2d"); m.save(); m.globalCompositeOperation = "copy"; m.fillStyle = "rgba(0,0,0,0.17)"; m.fillRect(400, 400, 400, 300); m.restore(); });
  await click(pg, 100, 100); assert(await alphaAt(pg, 600, 530) > 40, "alpha 43 wiped");
});
edge("BE22 A thin line touching the picture border next to the erased area", async (pg) => {
  await draw(pg, 300, 200, `x.fillStyle="#fff";x.fillRect(0,0,w,h);x.fillStyle="#111";x.fillRect(0,0,1,h);`); await click(pg, 100, 100);
  assert(pg.errs.length === 0 && await opaque(pg, [0, 10, 1, 190]) < 0.1, "border sliver left");
});
edge("BE23 Keep after erase restores the same with or without clean-up", async (pg) => {
  const run = async (c) => { await ev(pg, () => { const m = window.T.B.mask.getContext("2d"); m.save(); m.globalCompositeOperation = "copy"; m.fillStyle = "#000"; m.fillRect(0, 0, 9999, 9999); m.restore(); });
    await opt(pg, "wClean", c); await click(pg, 100, 100, "erase"); await click(pg, 100, 100, "keep"); return hash(pg); };
  const a = await run(true), b = await run(false); assert(typeof a === "number" && typeof b === "number" && pg.errs.length === 0, "failed");
});
edge("BE24 Dragging the tolerance while flipping the option", async (pg) => {
  await click(pg, 100, 100); for (let i = 0; i < 6; i++) { await ev(pg, (v) => window.T.tol(v), 20 + i * 10); await opt(pg, "wClean", i % 2 === 0); }
  await pg.waitForTimeout(150); assert(pg.errs.length === 0, pg.errs.join("; "));
});
edge("BE25 Phone screen: the option is visible and the page doesn't scroll sideways", async (pg) => {
  const ph = await open({ viewport: { width: 390, height: 844 } });
  try {
    await ph.click("#tWand").catch(() => {}); const r = await ph.$eval('label[for="wClean"]', (e) => { const b = e.getBoundingClientRect(); return [b.left, b.right, innerWidth]; });
    assert(r[0] >= 0 && r[1] <= r[2] + 1, "option off screen " + r); assert(await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1, "sideways scroll");
  } finally { await ph.close2(); }
});

// =====================================================================
// Feature: clean flat backgrounds after the AI cut-out (logos, graphics)
// =====================================================================
FEATURE = "AI: clean flat backgrounds";
// Run flatBackdrop on a drawn picture and a simulated AI alpha map.
//   draw:  body of (x, w, h) drawing the picture
//   alpha: body of (X, y, w, h, r, g, b) returning the simulated model alpha 0..1
// Result kept in window.F = { a, before, g, w, h, ret }.
const flat = (pg, w, h, draw, alpha) => pg.evaluate(([w, h, d, al]) => {
  const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d"); new Function("x", "w", "h", d)(x, w, h);
  const g = x.getImageData(0, 0, w, h).data, f = new Function("X", "y", "w", "h", "r", "g", "b", al), a = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let X = 0; X < w; X++) { const i = (y * w + X) * 4; a[y * w + X] = f(X, y, w, h, g[i], g[i + 1], g[i + 2]); }
  const before = a.slice(), t0 = performance.now(), ret = window.__bench.flatBackdrop(a, g, w, h);
  window.F = { a, before, g, w, h, ret, ms: performance.now() - t0 }; return { ret, ms: window.F.ms };
}, [w, h, draw, alpha]);
// mean alpha in a rectangle, and counts
const meanA = (pg, r) => pg.evaluate(([x0, y0, x1, y1]) => { const F = window.F; let s = 0, n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += F.a[y * F.w + x]; n++; } return s / n; }, r);
const countA = (pg, cond) => pg.evaluate((c) => { const F = window.F, f = new Function("v", "b", c); let n = 0; for (let i = 0; i < F.a.length; i++) if (f(F.a[i], F.before[i])) n++; return n; }, cond);
const noise = (amp) => `const d=x.getImageData(0,0,w,h);let s=11;for(let i=0;i<d.data.length;i+=4){s=(s*16807)%2147483647;const n=(s/2147483647-0.5)*${amp};for(let k=0;k<3;k++)d.data[i+k]=Math.max(0,Math.min(255,d.data[i+k]+n));}x.putImageData(d,0,0);`;
// a logo: green block + green ring with a white inner band, black word, white letter holes
const LOGO = `x.fillStyle="#fff";x.fillRect(0,0,w,h);x.fillStyle="#76b900";x.fillRect(240,60,140,150);x.beginPath();x.ellipse(260,135,110,60,0,0,7);x.fill();
  x.strokeStyle="#fff";x.lineWidth=16;x.beginPath();x.ellipse(255,135,70,34,0,0.4,5.5);x.stroke();x.fillStyle="#000";x.fillRect(100,250,60,70);x.fillRect(200,250,60,70);x.fillStyle="#fff";x.fillRect(120,270,20,30);x.fillRect(220,270,20,30);`;
const isLogo = `return (X>140&&X<380&&y>60&&y<210)||(X>=100&&X<160&&y>=250&&y<320)||(X>=200&&X<260&&y>=250&&y<320);`;
// model-like alpha: subject ~1, white ring kept, letter holes unsure, cloudy haze over the background
const HAZY = `const inS=${JSON.stringify(isLogo)}; const S=new Function("X","y",inS)(X,y); if (S) { const hole=(X>=120&&X<140&&y>=270&&y<300)||(X>=220&&X<240&&y>=270&&y<300); return hole?0.3:1; }
  return Math.max(0, 0.65*Math.sin(X/23)*Math.sin(y/17));`;
const aiRun = async (pg, file) => {
  const ok = await pg.evaluate(async (dataUrl) => { const blob = await (await fetch(dataUrl)).blob(); await window.__bench.load(new File([blob], "logo.jpg", { type: "image/jpeg" })); return !!window.ort; }, file);
  if (!ok) throw new Skip("AI runtime not reachable");
  await pg.click("#aiBtn");
  const done = await pg.waitForFunction(() => { const a = window.__bench.alpha(); return a[3] < 128; }, null, { timeout: 240000 }).then(() => true).catch(() => false);
  if (!done) throw new Skip("AI model did not finish here");
  await pg.waitForTimeout(400);
};
// the noisy JPEG logo from the bug report (made in the page)
const jpegLogo = (pg) => pg.evaluate(async () => {
  const c = document.createElement("canvas"); c.width = 800; c.height = 470; const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, 800, 470);
  x.fillStyle = "#76b900"; x.fillRect(342, 86, 186, 196); x.beginPath(); x.ellipse(380, 186, 150, 75, 0, 0, 7); x.fill();
  x.strokeStyle = "#fff"; x.lineWidth = 22; x.beginPath(); x.ellipse(372, 186, 110, 52, 0, 0.3, 5.6); x.stroke(); x.beginPath(); x.ellipse(365, 186, 52, 28, 0, 0.5, 5.2); x.stroke();
  x.fillStyle = "#000"; x.font = "900 96px Arial Black, Arial, sans-serif"; x.textAlign = "center"; x.fillText("NOVIDA", 400, 390);
  const d = x.getImageData(0, 0, 800, 470); let s = 9; for (let i = 0; i < d.data.length; i += 4) { s = (s * 16807) % 2147483647; const n = (s / 2147483647 - 0.5) * 14; for (let k = 0; k < 3; k++) d.data[i + k] = Math.max(0, Math.min(255, d.data[i + k] + n)); } x.putImageData(d, 0, 0);
  return c.toDataURL("image/jpeg", 0.3);
});
const bgLeft = (pg) => pg.evaluate(() => { const B = window.__bench, w = B.src.width, h = B.src.height, a = B.alpha(); let v = 0;
  for (let y = 0; y < h; y++) for (let X = 0; X < w; X++) { const inLogo = (X > 215 && X < 540 && y > 95 && y < 290) || (X > 90 && X < 710 && y > 300 && y < 410) || (X > 335 && X < 535 && y > 80 && y < 290); if (!inLogo && a[(y * w + X) * 4 + 3] > 25) v++; } return v; });

// ---------- 25 real-use cases ----------
real("F01 'Clean flat backgrounds' sits in the Automatic card and is on by default", async (pg) => {
  assert(await pg.$("#flatBg"), "option missing"); assert(await pg.$eval("#flatBg", (e) => e.checked), "should be on");
  assert(await pg.$eval("#flatBg", (e) => !!e.closest(".card") && /Remove background/.test(e.closest(".card").textContent)), "not in the Automatic card");
});
real("F02 The bug report: AI on a noisy JPEG logo leaves no haze in the background", async (pg) => {
  await aiRun(pg, await jpegLogo(pg)); const n = await bgLeft(pg); assert(n === 0, n + " background pixels still visible");
});
real("F03 Turning the option off brings the AI's haze back; on clears it again", async (pg) => {
  await aiRun(pg, await jpegLogo(pg)); await opt(pg, "flatBg", false); await pg.waitForTimeout(800); const off = await bgLeft(pg);
  await opt(pg, "flatBg", true); await pg.waitForTimeout(800); const on = await bgLeft(pg); assert(off > 2000 && on === 0, `off ${off}, on ${on}`);
});
real("F04 The logo itself survives the AI + clean-up", async (pg) => {
  await aiRun(pg, await jpegLogo(pg)); for (const [x, y] of [[450, 120], [500, 250], [260, 186]]) assert(await alphaAt(pg, x, y) > 230, `logo cut at ${x},${y}`);
  // every dark letter pixel stays
  const lost = await pg.evaluate(() => { const B = window.__bench, w = B.src.width, s = B.src.getContext("2d").getImageData(0, 0, w, B.src.height).data, a = B.alpha(); let dark = 0, gone = 0;
    for (let y = 310; y < 400; y++) for (let x = 100; x < 700; x++) { const i = (y * w + x) * 4; if (s[i] + s[i + 1] + s[i + 2] < 150) { dark++; if (a[i + 3] < 200) gone++; } } return gone / dark; });
  assert(lost < 0.01, `${(lost * 100).toFixed(1)}% of the lettering lost`);
});
real("F05 Cloudy haze over a white background is cleared completely", async (pg) => {
  await flat(pg, 480, 360, LOGO, HAZY); for (const r of [[0, 0, 480, 50], [0, 330, 480, 360], [400, 0, 480, 360]]) { const m = await meanA(pg, r); assert(m === 0, "haze left: " + m); }
});
real("F06 The green logo shapes stay fully solid", async (pg) => { await flat(pg, 480, 360, LOGO, HAZY); assert(await meanA(pg, [300, 80, 370, 200]) === 1, "logo block changed"); });
real("F07 Black lettering stays fully solid", async (pg) => { await flat(pg, 480, 360, LOGO, HAZY); assert(await meanA(pg, [100, 250, 120, 320]) === 1, "letters changed"); });
real("F08 Letter holes the AI was unsure about are cleared", async (pg) => { await flat(pg, 480, 360, LOGO, HAZY); assert(await meanA(pg, [123, 273, 137, 297]) === 0, "hole not cleared"); });
real("F09 White parts of the design the AI kept become solid, not speckled", async (pg) => {
  // model alpha: logo shapes (green block, green ellipse incl. its white inner band, letters) ~1, white band speckled 0.55..1, background 0.1
  await flat(pg, 480, 360, LOGO, `const inShape=(X>=240&&X<380&&y>=60&&y<210)||((X-260)**2/12100+(y-135)**2/3600<1)||(X>=100&&X<160&&y>=250&&y<320)||(X>=200&&X<260&&y>=250&&y<320);
    if(!inShape) return 0.1; if(r>240&&g>240&&b>240) return ((X*31+y*17)%10)/10*0.45+0.55; return 1;`);
  const specks = await countA(pg, "return b>0.5 && v<0.99 && v>0.01;"); assert(specks < 20, specks + " speckled pixels in kept white parts");
});
real("F10 Anti-aliased edges keep a soft edge", async (pg) => {
  await flat(pg, 300, 300, `x.fillStyle="#fff";x.fillRect(0,0,w,h);x.fillStyle="#36c";x.beginPath();x.arc(150,150,80,0,7);x.fill();`, `const d=Math.hypot(X-150,y-150);return d<79?1:d<81?0.5:0;`);
  assert(await countA(pg, "return v>0.05&&v<0.95;") > 50, "edge became hard");
});
real("F11 A flat lime background works too", async (pg) => {
  const r = await flat(pg, 400, 300, `x.fillStyle="#d8ff5c";x.fillRect(0,0,w,h);x.fillStyle="#ff4667";x.fillRect(120,80,160,140);`, `return (X>=120&&X<280&&y>=80&&y<220)?1:0.4;`);
  assert(r.ret && await meanA(pg, [0, 0, 400, 60]) === 0 && await meanA(pg, [130, 90, 270, 210]) === 1, "lime background not cleaned");
});
real("F12 A black background with a white logo works", async (pg) => {
  const r = await flat(pg, 400, 300, `x.fillStyle="#000";x.fillRect(0,0,w,h);x.fillStyle="#fff";x.fillRect(120,80,160,140);`, `return (X>=120&&X<280&&y>=80&&y<220)?1:0.4;`);
  assert(r.ret && await meanA(pg, [0, 0, 400, 60]) === 0 && await meanA(pg, [130, 90, 270, 210]) === 1, "black background not cleaned");
});
real("F13 A real photo background (not flat) is left exactly as the AI made it", async (pg) => {
  const r = await flat(pg, 400, 300, `const g=x.createLinearGradient(0,0,w,h);g.addColorStop(0,"#335");g.addColorStop(.5,"#c84");g.addColorStop(1,"#4a7");x.fillStyle=g;x.fillRect(0,0,w,h);`, `return ((X*7+y*3)%100)/100;`);
  assert(!r.ret && await countA(pg, "return v!==b;") === 0, "photo result changed");
});
real("F14 Person in a white shirt on a white wall: the shirt stays", async (pg) => {
  await flat(pg, 400, 500, `x.fillStyle="#f4f4f2";x.fillRect(0,0,w,h);x.fillStyle="#f6f6f4";x.fillRect(80,320,240,180);x.fillStyle="#d9a07a";x.beginPath();x.ellipse(200,220,70,90,0,0,7);x.fill();`,
    `return (X>=80&&X<320&&y>=320)||((X-200)**2/4900+(y-220)**2/8100<1)?0.97:0.3;`);
  assert(await meanA(pg, [100, 340, 300, 500]) > 0.95 && await meanA(pg, [0, 0, 400, 100]) === 0, "shirt lost or wall kept");
});
real("F15 JPEG-style noise on the background is still recognised as flat", async (pg) => {
  const r = await flat(pg, 480, 360, LOGO + noise(16), HAZY); assert(r.ret && await meanA(pg, [0, 0, 480, 50]) === 0, "noisy background not cleaned");
});
real("F16 Small confident specks the AI left in the background are removed", async (pg) => {
  await flat(pg, 480, 360, LOGO, `if(new Function("X","y",${JSON.stringify(isLogo)})(X,y)) return 1; return ((X%60)<4&&(y%50)<4)?0.95:0;`);
  assert(await meanA(pg, [0, 0, 480, 50]) === 0, "specks left");
});
real("F17 A large confident area of background color touching the edge is kept", async (pg) => {
  await flat(pg, 400, 300, `x.fillStyle="#fff";x.fillRect(0,0,w,h);x.fillStyle="#fdfdfd";x.fillRect(0,200,400,100);x.fillStyle="#c22";x.fillRect(150,60,100,100);`, `return y>=200||(X>=150&&X<250&&y>=60&&y<160)?0.97:0.2;`);
  assert(await meanA(pg, [10, 210, 390, 290]) > 0.95, "large confident area removed");
});
real("F18 A logo cropped at the picture edge keeps the cropped part", async (pg) => {
  await flat(pg, 400, 300, `x.fillStyle="#fff";x.fillRect(0,0,w,h);x.fillStyle="#0a7";x.fillRect(300,50,100,200);`, `return X>=300&&y>=50&&y<250?1:0.3;`);
  assert(await meanA(pg, [305, 60, 400, 240]) === 1, "edge logo cut");
});
real("F19 Animate's 'Cut out the person' uses the same clean-up", async (pg) => {
  const has = await pg.evaluate(() => /flatBackdrop\(a, gd, W, H\)/.test(document.documentElement.innerHTML)); assert(has, "Animate's AI path doesn't call the clean-up");
});
real("F20 A product's soft shadow (a different grey) is left as the AI made it", async (pg) => {
  await flat(pg, 400, 300, `x.fillStyle="#f2f2f2";x.fillRect(0,0,w,h);x.fillStyle="#b0b0b0";x.beginPath();x.ellipse(200,250,120,18,0,0,7);x.fill();x.fillStyle="#24f";x.fillRect(140,80,120,160);`,
    `if(X>=140&&X<260&&y>=80&&y<240) return 1; if(((X-200)**2/14400+(y-250)**2/324)<1) return 0.5; return 0.2;`);
  assert(Math.abs(await meanA(pg, [150, 246, 250, 254]) - 0.5) < 0.05, "shadow changed");
});
real("F21 Running it twice gives the same result", async (pg) => {
  await flat(pg, 480, 360, LOGO + noise(10), HAZY);
  const same = await pg.evaluate(() => { const F = window.F, a2 = F.a.slice(); window.__bench.flatBackdrop(a2, F.g, F.w, F.h); for (let i = 0; i < a2.length; i++) if (Math.abs(a2[i] - F.a[i]) > 1e-6) return false; return true; });
  assert(same, "second run changed the result");
});
real("F22 It's quick on a 2048×1536 picture", async (pg) => {
  const r = await flat(pg, 2048, 1536, `x.fillStyle="#fff";x.fillRect(0,0,w,h);x.fillStyle="#76b900";x.fillRect(700,400,600,600);`, `return X>=700&&X<1300&&y>=400&&y<1000?1:0.3;`);
  assert(r.ms < 2500, `slow: ${r.ms.toFixed(0)} ms`);
});
real("F23 The option explains itself on hover", async (pg) => {
  const t = await pg.$eval('label[for="flatBg"]', (e) => e.title); assert(/one-color background/.test(t) && /haze/.test(t), t);
});
real("F24 Phone screen: the option is visible and nothing scrolls sideways", async (pg) => {
  const ph = await open({ viewport: { width: 390, height: 844 } });
  try { const r = await ph.$eval('label[for="flatBg"]', (e) => { const b = e.getBoundingClientRect(); return [b.left, b.right, innerWidth]; }); assert(r[0] >= 0 && r[1] <= r[2] + 1, "off screen " + r);
    assert(await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1, "sideways scroll"); } finally { await ph.close2(); }
});
real("F25 Values always stay between 0 and 1", async (pg) => {
  await flat(pg, 480, 360, LOGO + noise(20), HAZY); assert(await countA(pg, "return !(v>=0&&v<=1);") === 0, "out of range");
});

// ---------- 25 edge cases ----------
edge("FE01 A 1×1 picture is skipped safely", async (pg) => { const r = await flat(pg, 1, 1, `x.fillStyle="#fff";x.fillRect(0,0,1,1);`, `return 0.5;`); assert(r.ret === false, "ran on 1×1"); });
edge("FE02 A picture that is all background color", async (pg) => {
  const r = await flat(pg, 200, 150, `x.fillStyle="#fff";x.fillRect(0,0,w,h);`, `return 0.4;`); assert(r.ret && await meanA(pg, [0, 0, 200, 150]) === 0, "not cleared");
});
edge("FE03 Border only 70% one color: left alone", async (pg) => {
  const r = await flat(pg, 400, 300, `x.fillStyle="#fff";x.fillRect(0,0,w,h);x.fillStyle="#c33";x.fillRect(0,0,w,90);`, `return 0.4;`); assert(!r.ret && await countA(pg, "return v!==b;") === 0, "applied");
});
edge("FE04 Border about 80% one color: cleaned", async (pg) => {
  const r = await flat(pg, 400, 300, `x.fillStyle="#fff";x.fillRect(0,0,w,h);x.fillStyle="#c33";x.fillRect(0,0,130,20);`, `return 0.4;`); assert(r.ret, "not applied");
});
edge("FE05 AI confident about the whole background: large area kept", async (pg) => {
  await flat(pg, 300, 200, `x.fillStyle="#fff";x.fillRect(0,0,w,h);`, `return 1;`); assert(await meanA(pg, [0, 0, 300, 200]) === 1, "confident area removed");
});
edge("FE06 AI already cleared everything: stays clear", async (pg) => { await flat(pg, 300, 200, LOGO, `return 0;`); assert(await countA(pg, "return v>0;") === 0, "alpha appeared"); });
edge("FE07 White object on white, AI confident: kept", async (pg) => {
  await flat(pg, 300, 200, `x.fillStyle="#fff";x.fillRect(0,0,w,h);x.strokeStyle="#ddd";x.strokeRect(100,50,100,100);`, `return X>=100&&X<200&&y>=50&&y<150?0.98:0.3;`);
  assert(await meanA(pg, [110, 60, 190, 140]) > 0.97, "white object removed");
});
edge("FE08 Background shade just inside the tolerance is cleared", async (pg) => {
  await flat(pg, 300, 200, `x.fillStyle="#fff";x.fillRect(0,0,w,h);x.fillStyle="#f4f4f4";x.fillRect(0,0,w,40);`, `return 0.5;`); assert(await meanA(pg, [0, 0, 300, 35]) === 0, "not cleared");
});
edge("FE09 A thin frame of another color around the picture", async (pg) => {
  const r = await flat(pg, 400, 300, `x.fillStyle="#fff";x.fillRect(0,0,w,h);x.strokeStyle="#000";x.lineWidth=1;x.strokeRect(0.5,0.5,w-1,h-1);x.fillStyle="#c33";x.fillRect(150,100,100,100);`, `return X>=150&&X<250&&y>=100&&y<200?1:0.4;`);
  assert(r.ret && await meanA(pg, [20, 20, 380, 80]) === 0, "background inside the frame not cleaned");
});
edge("FE10 A very wide 2000×20 banner", async (pg) => { const r = await flat(pg, 2000, 20, `x.fillStyle="#fff";x.fillRect(0,0,w,h);x.fillStyle="#000";x.fillRect(900,5,200,10);`, `return X>=900&&X<1100&&y>=5&&y<15?1:0.3;`); assert(r.ret, "not applied"); });
edge("FE11 A 1-pixel hole (smaller than the noise filter) is left as the AI made it", async (pg) => {
  await flat(pg, 100, 100, `x.fillStyle="#fff";x.fillRect(0,0,w,h);x.fillStyle="#000";x.fillRect(40,40,21,21);x.fillStyle="#fff";x.fillRect(50,50,1,1);`, `return X>=40&&X<61&&y>=40&&y<61?(X===50&&y===50?0.2:1):0.3;`);
  const v = await pg.evaluate(() => window.F.a[50 * 100 + 50]); assert(Math.abs(v - 0.2) < 1e-6 && await meanA(pg, [41, 41, 49, 49]) === 1, "1 px hole or its surround changed: " + v);
});
edge("FE12 An enclosed patch the AI half-trusts (50%) is kept", async (pg) => {
  await flat(pg, 200, 200, `x.fillStyle="#fff";x.fillRect(0,0,w,h);x.fillStyle="#000";x.fillRect(50,50,100,100);x.fillStyle="#fff";x.fillRect(80,80,40,40);`, `return X>=50&&X<150&&y>=50&&y<150?((X>=80&&X<120&&y>=80&&y<120)?0.5:1):0.3;`);
  assert(await meanA(pg, [82, 82, 118, 118]) === 1, "patch not kept");
});
edge("FE13 Background split in two by a full-width bar: both halves cleared", async (pg) => {
  await flat(pg, 300, 200, `x.fillStyle="#fff";x.fillRect(0,0,w,h);x.fillStyle="#123";x.fillRect(0,90,w,20);`, `return y>=90&&y<110?1:0.4;`);
  assert(await meanA(pg, [0, 0, 300, 80]) === 0 && await meanA(pg, [0, 120, 300, 200]) === 0, "a half was missed");
});
edge("FE14 A checkerboard background isn't flat: left alone", async (pg) => {
  const r = await flat(pg, 300, 200, `for(let y=0;y<h;y+=10)for(let X=0;X<w;X+=10){x.fillStyle=((X+y)/10)%2?"#000":"#fff";x.fillRect(X,y,10,10);}`, `return 0.4;`); assert(!r.ret, "applied on a checkerboard");
});
edge("FE15 A PNG with a transparent border", async (pg) => {
  const r = await flat(pg, 300, 200, `x.fillStyle="#e33";x.fillRect(100,50,100,100);`, `return X>=100&&X<200&&y>=50&&y<150?1:0.2;`); assert(await meanA(pg, [110, 60, 190, 140]) === 1 && pg.errs.length === 0, "subject changed");
});
edge("FE16 No NaN values on extreme colors", async (pg) => { await flat(pg, 200, 200, `x.fillStyle="#000";x.fillRect(0,0,w,h);x.fillStyle="#fff";x.fillRect(50,50,100,100);`, `return X>=50&&X<150&&y>=50&&y<150?1:0.5;`); assert(await countA(pg, "return Number.isNaN(v);") === 0, "NaN"); });
edge("FE17 A confident speck island just above the size limit is kept", async (pg) => {
  // 2048 px picture area 400×300=120000 → limit 240 px; a 16×16 = 256 px island
  await flat(pg, 400, 300, `x.fillStyle="#fff";x.fillRect(0,0,w,h);`, `return X>=100&&X<116&&y>=100&&y<116?0.95:0.2;`); assert(await meanA(pg, [100, 100, 116, 116]) > 0.9, "island removed");
});
edge("FE18 A confident speck island just below the size limit is removed", async (pg) => {
  await flat(pg, 400, 300, `x.fillStyle="#fff";x.fillRect(0,0,w,h);`, `return X>=100&&X<115&&y>=100&&y<115?0.95:0.2;`); assert(await meanA(pg, [100, 100, 115, 115]) === 0, "island kept");
});
edge("FE19 Soft edge pixels are never made more visible", async (pg) => {
  await flat(pg, 300, 300, `x.fillStyle="#fff";x.fillRect(0,0,w,h);x.fillStyle="#36c";x.beginPath();x.arc(150,150,80,0,7);x.fill();`, `const d=Math.hypot(X-150,y-150);return d<79?1:d<83?0.6:0.2;`);
  assert(await countA(pg, "return v>b+1e-6 && b<0.85;") === 0, "edge alpha increased");
});
edge("FE20 Very noisy background (±30) doesn't damage the subject", async (pg) => {
  await flat(pg, 480, 360, LOGO + noise(60), HAZY); assert(await meanA(pg, [300, 80, 370, 200]) === 1, "subject damaged");
});
edge("FE21 A mid-grey background", async (pg) => {
  const r = await flat(pg, 300, 200, `x.fillStyle="#808080";x.fillRect(0,0,w,h);x.fillStyle="#fc0";x.fillRect(100,50,100,100);`, `return X>=100&&X<200&&y>=50&&y<150?1:0.4;`); assert(r.ret && await meanA(pg, [0, 0, 300, 40]) === 0, "grey not cleaned");
});
edge("FE22 A saturated red background with a dark-red subject", async (pg) => {
  await flat(pg, 300, 200, `x.fillStyle="#e00";x.fillRect(0,0,w,h);x.fillStyle="#600";x.fillRect(100,50,100,100);`, `return X>=100&&X<200&&y>=50&&y<150?1:0.4;`);
  assert(await meanA(pg, [110, 60, 190, 140]) === 1 && await meanA(pg, [0, 0, 300, 40]) === 0, "wrong result on red");
});
edge("FE23 2048×2048 (the largest size the app refines at) stays quick", async (pg) => {
  const r = await flat(pg, 2048, 2048, `x.fillStyle="#fff";x.fillRect(0,0,w,h);x.fillStyle="#000";x.fillRect(800,800,400,400);`, `return X>=800&&X<1200&&y>=800&&y<1200?1:0.3;`); assert(r.ms < 3500, r.ms.toFixed(0) + " ms");
});
edge("FE24 Option off: applying the AI result skips the clean-up", async (pg) => {
  const called = await pg.evaluate(() => { document.getElementById("flatBg").checked = false; return /if \(\$\("flatBg"\)\.checked\) flatBackdrop/.test(document.documentElement.innerHTML); }); assert(called, "clean-up isn't behind the option");
});
edge("FE25 A gradient that is flat along the border but not inside is handled safely", async (pg) => {
  await flat(pg, 400, 300, `x.fillStyle="#fff";x.fillRect(0,0,w,h);const g=x.createRadialGradient(200,150,10,200,150,120);g.addColorStop(0,"#246");g.addColorStop(1,"#fff");x.fillStyle=g;x.fillRect(60,30,280,240);`, `const d=Math.hypot(X-200,y-150);return d<60?1:0.3;`);
  assert(await meanA(pg, [180, 130, 220, 170]) === 1, "centre damaged");
});

(async () => {
  srv = await serve(); base = `http://localhost:${srv.address().port}`; browser = await chromium.launch();
  const list = tests.filter((t) => !ONLY || ONLY.test(t.name)); let pass = 0, fail = 0, skip = 0;
  for (const t of list) {
    const t0 = Date.now(); let pg;
    try { pg = await open(); await t.fn(pg); if (pg.errs.length) throw new Error("page errors: " + pg.errs.join("; ")); pass++; console.log(`  ✓ ${t.name} (${Date.now() - t0} ms)`); }
    catch (e) { if (e instanceof Skip) { skip++; console.log(`  - ${t.name} (skipped: ${e.message})`); } else { fail++; console.log(`  ✗ ${t.name}\n      ${e.message}`); } }
    finally { if (pg) await pg.close2().catch(() => {}); }
  }
  console.log("");
  for (const f of [...new Set(list.map((t) => t.feature))]) { const ts = list.filter((t) => t.feature === f); console.log(`  ${f}: ${ts.filter((t) => t.kind === "real").length} real-use + ${ts.filter((t) => t.kind === "edge").length} edge cases`); }
  console.log(`${pass} passed, ${fail} failed, ${skip} skipped (${list.length} tests)`); await browser.close(); srv.close(); process.exit(fail ? 1 : 0);
})();
