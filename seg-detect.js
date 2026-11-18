/* Phân đoạn vật thể nổi bật (U²-Net-P, ONNX Runtime Web) → mặt nạ để trọng tài chọn tứ giác khớp nhất.
   Chạy ~1 giây/khung nên chỉ dùng khi chụp / dò lại, không chạy liên tục. mask(src, w, h) → Uint8Array(w*h), 255 = vật thể */
const BASE = new URL('vendor/seg/', import.meta.url).href;
export const FILES = [['ort.min.js', 446284], ['ort-wasm-simd-threaded.mjs', 24618], ['ort-wasm-simd-threaded.wasm', 11246032], ['u2netp.onnx', 4574861]].map(([n, s]) => [BASE + n, s]);
const S = 320, MEAN = [.485, .456, .406], STD = [.229, .224, .225];
let loading = null;
export function load() {
  if (loading) return loading;
  return loading = (async () => {
    const keep = window.ort;   /* ort.min.js gán biến toàn cục: giữ lại bản của bộ AI góc */
    await new Promise((ok, no) => { const s = document.createElement('script'); s.src = BASE + 'ort.min.js'; s.onload = ok; s.onerror = no; document.head.append(s); });
    const ort = window.ort; if (keep) window.ort = keep;
    ort.env.wasm.wasmPaths = BASE; ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
    const model = new Uint8Array(await (await fetch(BASE + 'u2netp.onnx')).arrayBuffer());
    return { ort, session: await ort.InferenceSession.create(model, { executionProviders: ['wasm'] }) };
  })().catch(e => { loading = null; throw e; });
}
const cv = document.createElement('canvas'); cv.width = cv.height = S;
const cx = cv.getContext('2d', { willReadFrequently: true });
export async function mask(src, w, h) {
  const { ort, session } = await load();
  cx.drawImage(src, 0, 0, S, S);
  const d = cx.getImageData(0, 0, S, S).data, f = new Float32Array(3 * S * S);
  for (let i = 0; i < S * S; i++) for (let k = 0; k < 3; k++) f[k * S * S + i] = (d[i * 4 + k] / 255 - MEAN[k]) / STD[k];
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', f, [1, 3, S, S]) });
  const o = out[session.outputNames[0]].data; let mn = 1e9, mx = -1e9; for (const v of o) { if (v < mn) mn = v; if (v > mx) mx = v; }
  const c = document.createElement('canvas'); c.width = c.height = S; const x = c.getContext('2d'), id = x.createImageData(S, S);
  for (let i = 0; i < S * S; i++) { const v = (o[i] - mn) / (mx - mn) * 255; id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
  x.putImageData(id, 0, 0);
  const c2 = document.createElement('canvas'); c2.width = w; c2.height = h; const x2 = c2.getContext('2d', { willReadFrequently: true }); x2.drawImage(c, 0, 0, w, h);
  const r = x2.getImageData(0, 0, w, h).data, m = new Uint8Array(w * h);
  /* Otsu trên kênh xám */
  const hist = new Uint32Array(256); for (let i = 0; i < w * h; i++) hist[r[i * 4]]++;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let wb = 0, sb = 0, best = 0, th = 128; for (let i = 0; i < 256; i++) { wb += hist[i]; if (!wb) continue; const wf = w * h - wb; if (!wf) break; sb += i * hist[i]; const v = wb * wf * (sb / wb - (sum - sb) / wf) ** 2; if (v > best) { best = v; th = i; } }
  for (let i = 0; i < w * h; i++) m[i] = r[i * 4] > th ? 255 : 0;
  return m;
}
