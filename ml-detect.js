/* Nhận diện 4 góc tài liệu bằng mô hình AI nhẹ (DocCornerNet, ONNX Runtime Web, chạy ngay trên máy, 1 luồng WASM).
   load() nạp runtime + mô hình một lần; detect(nguồn) → { q: [[x,y]×4 theo TL,TR,BR,BL, toạ độ 0–1], score: xác suất có tài liệu } */
const BASE = new URL('vendor/ml/', import.meta.url).href;
export const FILES = [['ort.min.js', 48514], ['ort-wasm-simd-threaded.mjs', 19531], ['ort-wasm-simd-threaded.wasm', 1523774], ['doccornernet_lean.ort', 1925824]].map(([n, s]) => [BASE + n, s]);
const SIZE = 224, MEAN = [.485, .456, .406], STD = [.229, .224, .225];
let loading = null;
export function load() {
  if (loading) return loading;
  return loading = (async () => {
    const ort = await import(BASE + 'ort.min.js');
    ort.env.wasm.wasmPaths = BASE; ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
    const model = new Uint8Array(await (await fetch(BASE + 'doccornernet_lean.ort')).arrayBuffer());
    const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    return { ort, session };
  })().catch(e => { loading = null; throw e; });
}
const cv = document.createElement('canvas'); cv.width = cv.height = SIZE;
const cx = cv.getContext('2d', { willReadFrequently: true });
export async function detect(src) {
  const { ort, session } = await load();
  cx.imageSmoothingQuality = 'medium'; cx.drawImage(src, 0, 0, SIZE, SIZE);
  const d = cx.getImageData(0, 0, SIZE, SIZE).data, f = new Float32Array(SIZE * SIZE * 3);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) for (let c = 0; c < 3; c++) f[j + c] = (d[i + c] / 255 - MEAN[c]) / STD[c];
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', f, [1, SIZE, SIZE, 3]) });
  let co = null, sc = null;
  for (const k in out) { const v = out[k].data; if (v.length === 8) co = v; else if (v.length === 1) sc = v[0]; }
  if (!co) return null;
  return { q: [0, 1, 2, 3].map(i => [co[2 * i], co[2 * i + 1]]), score: sc === null ? 1 : 1 / (1 + Math.exp(-sc)) };
}
