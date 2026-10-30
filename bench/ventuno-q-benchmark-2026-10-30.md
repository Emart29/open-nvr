# Ventuno Q — OpenNVR tier-0 CPU baseline (measured 2026-10-30)

Board: Arduino Ventuno Q, Qualcomm QCS8275 (8× ARM, Hexagon V73 NPU unused), 14 GB RAM, Ubuntu 24.04, kernel 6.8 qcom.
Stack: open-nvr main @ 012147e6, images 0.1.8, HW_ACCEL=cpu, detector yolo26n ONNX (CPU EP, fp32), enrichment off,
camera-agent installed but idle (Ollama granite4:micro resident, 0% CPU). Sources: 10 looping clips via the fakecams rig
(same box: ~0.7–1.1 cores of overhead that a real deployment would not pay). Decode: software, 2 threads/camera.

## 10 cameras — four consecutive 60 s windows (all identical within noise)
| metric | value |
|---|---|
| inferences/s, whole pipeline | 8.5–8.6 |
| wall latency per inference (under contention) | 1.05–1.13 s |
| frames processed per camera | ~0.9 fps |
| frames dropped per camera | ~1.1 fps (pipeline asks ~2 fps/camera) |
| detect-pipeline CPU | 600–630 % (of 800) |
| detect-pipeline RSS | ~975 MiB |
| host CPU | ~82 % user, ~12 % sys, ~4 % idle |
| mediamtx CPU | 45–55 % |
| fakecams rig CPU (test overhead) | 60–110 % |

The pipeline reports "detection exceeds this box's capacity" for every camera at this load; detector regions were cut to 1 of 8.

## Scaling — 60 s windows after a 100 s settle, all ten cameras restored afterwards
| active cameras | frames/s per cam (asked ~2) | dropped/s per cam | inferences/s total | wall ms per inference | detect-pipeline CPU | host idle |
|---|---|---|---|---|---|---|
| 1  | 1.98 | 0    | 1.8  | 164   | 330 % | 46 % |
| 2  | 1.99 | 0.01 | 4.0  | 286   | 447 % | 24 % |
| 4  | 2.01 | 0.01 | 7.9  | 284   | 439 % | 21 % |
| 10 | 0.93 | 1.07 | 8.6  | 1047–1127 | 600–630 % | 4 % |

Reading: the CPU ceiling is ~8–8.6 yolo26n inferences/s on this SoC. At the pipeline's ~2 fps per camera that is
four cameras with no drops; ten cameras get under half their frames detected on. Single-camera inference is 164 ms wall
with ORT intra-op threads uncapped (detect-pipeline still burns 3.3 cores for one camera: thread cap worth testing).
All numbers include the fakecams rig (~0.5 core) and software decode on the same box.

## Hexagon HTP probe (same yolo26n.onnx, fp32 model run at fp16 on the NPU via onnxruntime-qnn 2.7.0 / ORT 1.31.1, QAIRT 2.51 bundled)
| run | per inference |
|---|---|
| ORT CPU EP, 8 threads, probe container | 609 ms median (443 min) |
| QNN HTP, sustained_high_performance, fp16 | **8.6 ms median, 7.2 min, 11.8 p90** |
| HTP session build (graph finalisation mode 3) | 6.3 s |
Output agreement on a real parking-lot frame: same detections (cars), scores within 0.01, boxes within 0.5 px; mean |diff| 0.026 on raw outputs.
Host requirements found the hard way: /dev/fastrpc-cdsp AND /dev/dma_heap/{system,qcom,system}, libcdsprpc.so by its UNVERSIONED name (the wheel's HTP stub dlopens it), libdmabufheap.so.0; groups fastrpc (125) and dmaheap (989). Without the dma_heap nodes: QNN_DEVICE_ERROR_INVALID_CONFIG at device creation, silent fallback to CPU.

## In-stack on the NPU (qualcomm flavour, pool 1/2/4 identical), 16 cameras, 60 s windows
| pool | frames/s total | dropped | inferences/s | wall ms/inference (median per cam) | detect-pipeline CPU | host idle |
|---|---|---|---|---|---|---|
| 1 | 32.1 | 0 | 24.1 | 35 (26) | 294 % | 39 % |
| 2 | 32.1 | 0 | 24.1 | 25 (28) | 301 % | 37 % |
| 4 (auto) | 32.2 | 0 | 24.1 | 25 (25) | 281 % | 42 % |
Caveats recorded: the first NPU "run" (12 ms, 239 % CPU at 10 cams) was the STUB detector after `SessionOptions.add_provider` by name was refused — discarded. vehicles/tamper folders are transcoded by the rig (a core each) and were parked for these windows.
