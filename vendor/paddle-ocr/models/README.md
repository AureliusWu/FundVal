# PP-OCRv6 tiny model provenance

These two browser ONNX archives are vendored so FundVal's production build never downloads a model at build time or falls back to a remote model at runtime.

Acquired and verified: 2026-08-12

| File | Official upstream URL | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `PP-OCRv6_tiny_det_onnx_infer.tar` | `https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_tiny_det_onnx_infer.tar` | 1,792,000 | `ff6ab415b0a6e0c488550f2fb5d5046f1719848df220b2dc21b56402a65bc05d` |
| `PP-OCRv6_tiny_rec_onnx_infer.tar` | `https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_tiny_rec_onnx_infer.tar` | 4,526,080 | `1e13b22717b1edd89d4cde4fda272b6c17d5b505c97c2baea99da1a3a2d54b29` |

The URLs are the official defaults declared by `@paddleocr/paddleocr-js@0.4.2`. PaddleOCR and the PP-OCR model family are distributed under Apache-2.0; the deployed license copy is `assets/ocr/licenses/paddleocr-APACHE-2.0.txt`. `scripts/build-paddle-ocr.mjs` rejects a missing file or any byte/hash mismatch before bundling.
