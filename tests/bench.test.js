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
      r.writeHead(200, { "Content-Type": p.endsWith(".html") ? "text/html" : "application/octet-stream" }); fs.createReadStream(f).pipe(r);
    }).listen(0, () => res(srv));
  });
}

let browser, base, srv;
async function open({ viewport = { width: 1366, height: 1000 } } = {}) {
  const ctx = await browser.newContext({ viewport });
  const pg = await ctx.newPage(); pg.errs = [];
  pg.on("pageerror", (e) => pg.errs.push(e.message));
  await pg.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ body: "", contentType: "text/css" }));
  await pg.route("https://cdn.jsdelivr.net/**", (r) => r.fulfill({ body: "", contentType: "application/javascript" }));   // no AI model needed here
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

const tests = []; const real = (n, f) => tests.push({ kind: "real", name: n, fn: f }), edge = (n, f) => tests.push({ kind: "edge", name: n, fn: f });

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

(async () => {
  srv = await serve(); base = `http://localhost:${srv.address().port}`; browser = await chromium.launch();
  const list = tests.filter((t) => !ONLY || ONLY.test(t.name)); let pass = 0, fail = 0;
  for (const t of list) {
    const t0 = Date.now(); let pg;
    try { pg = await open(); await t.fn(pg); if (pg.errs.length) throw new Error("page errors: " + pg.errs.join("; ")); pass++; console.log(`  ✓ ${t.name} (${Date.now() - t0} ms)`); }
    catch (e) { fail++; console.log(`  ✗ ${t.name}\n      ${e.message}`); }
    finally { if (pg) await pg.close2().catch(() => {}); }
  }
  console.log(`\n  Magic tool clean-up: ${list.filter((t) => t.kind === "real").length} real-use + ${list.filter((t) => t.kind === "edge").length} edge cases`);
  console.log(`${pass} passed, ${fail} failed (${list.length} tests)`); await browser.close(); srv.close(); process.exit(fail ? 1 : 0);
})();
