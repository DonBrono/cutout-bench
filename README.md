# Cutout Bench

Two browser tools in one page:

- **Remove background**: AI cutout of any photo, with erase, restore and magic-eraser touch-ups. Saves PNG or JPG.
- **Resize video**: reframe videos for YouTube Shorts (9:16) or long-form (16:9) at YouTube's recommended resolutions and bitrates.

Everything runs in the visitor's browser. No server, no uploads, no build step.

## Files

- `index.html`: the whole app
- `model/part0-3.wasm`: the IS-Net cutout model, split into four parts (loaded on first use)
- `ort/ort-wasm-simd.wasm`: ONNX Runtime Web engine that runs the model

## Run locally

Opening `index.html` by double-clicking won't load the model. Serve the folder instead:

    npx serve .

## Credits and license

The background-removal model comes from @imgly/background-removal
(https://github.com/imgly/background-removal-js), licensed under AGPL-3.0.
ONNX Runtime Web is MIT-licensed by Microsoft.
Because the model is AGPL-3.0, keep this repository public and keep this notice.
