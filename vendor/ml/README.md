# Mô hình nhận diện góc tài liệu (AI)

Bộ này lấy từ gói npm [`scanic-ml`](https://www.npmjs.com/package/scanic-ml) 0.2.0 (MIT) và bản ONNX Runtime Web đóng gói trong [`scanic`](https://github.com/marquaye/scanic) 1.8.0 (MIT).

| Tệp | Vai trò |
| --- | --- |
| `doccornernet_lean.ort` | Mô hình DocCornerNet (MobileNetV2 + SimCC, ~1,9 MB), nhận ảnh 224×224 → 4 góc + điểm tin cậy |
| `ort.min.js` | ONNX Runtime Web (đã đóng gói) |
| `ort-wasm-simd-threaded.{mjs,wasm}` | Runtime WASM tối giản (~1,5 MB), chạy 1 luồng |
| `MODEL_CARD.md`, `LICENSE-scanic` | Thẻ mô hình và giấy phép gốc |

Dùng bởi `ml-detect.js`. Chỉ tải khi vào Quét → Tài liệu.
