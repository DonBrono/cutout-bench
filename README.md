# Cutout Bench

Two browser tools in one page:

- **Remove background**: AI cutout of any photo, with erase, restore and magic-eraser touch-ups. Saves PNG or JPG.
- **Resize video**: reframe videos for YouTube Shorts (9:16) or long-form (16:9) at YouTube's recommended resolutions and bitrates.

Everything runs in the visitor's browser. No server, no uploads, no build step.

## Files

- `index.html`: the whole app
- `model/part0-7.wasm`: the IS-Net cutout model, split into eight parts (loaded on first use)
- `ort/engine0-1.bin.wasm`: ONNX Runtime Web engine (ort-wasm-simd.wasm, 1.17.3) split in two

## Run locally

Opening `index.html` by double-clicking won't load the model. Serve the folder instead:

    npx serve .

## Credits and license

The background-removal model comes from @imgly/background-removal
(https://github.com/imgly/background-removal-js), licensed under AGPL-3.0.
ONNX Runtime Web is MIT-licensed by Microsoft.
Because the model is AGPL-3.0, keep this repository public and keep this notice.

## Tests

Every new feature ships with 50 automated browser tests: 25 real-use cases and 25 edge cases.

```
npm i -D playwright && npx playwright install chromium   # once
node tests/animate.test.js            # run everything
node tests/animate.test.js keyframe   # run only tests whose name matches
```

The export test also needs `ffmpeg`/`ffprobe` on your PATH (it is skipped otherwise).
The app exposes a test hook (`window.__an`) only when the address contains `?test`.
