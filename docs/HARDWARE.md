# Hardware acceleration — OpenNVR Accelerate

> One codebase, one setting, per-hardware image flavours. The code is the
> same in every flavour; a build argument picks the inference runtime and the
> vendor user-space, and `OPENNVR_ACCEL` picks the flavour at run time.

Only two parts of OpenNVR touch hardware: the **detect-pipeline** (video
decode and the always-on Tier-0 detector) and the **AI adapters** behind
KAI-C. Apps never do — they consume events — so acceleration is never an
app concern.

## Support matrix

| Hardware | Flavour / tag | Decode | Tier-0 detector | Adapters | Status |
|---|---|---|---|---|---|
| Any x86-64 or arm64 CPU | `cpu` (plain tag) | software | onnxruntime CPU | onnxruntime CPU | shipped |
| Intel iGPU — N100, Core i, Core Ultra, Arc | `intel` (`-intel`) | VA-API on the iGPU | OpenVINO on the iGPU | CPU (adapter flavours: Phase 2) | shipped (decode), this release (detector) |
| Intel NPU — Core Ultra "AI Boost" | `intel` (`-intel`) | n/a (NPU does not decode) | OpenVINO on the NPU | CPU (Phase 2) | this release |
| NVIDIA — desktop GPU, Jetson | `nvidia` (`-nvidia`) | NVDEC (`DETECT_HWACCEL=nvidia`) | CUDA / TensorRT | CUDA (`onnxruntime-gpu`) | decode shipped; images Phase 3 |
| AMD — iGPU, Radeon | later (`-rocm`) | VA-API (shipped) | ROCm | ROCm | on demand |
| Raspberry Pi, Rockchip | `cpu` | `rpi` / `rkmpp` decode | CPU | CPU | decode shipped |
| Coral, Hailo | — | — | via the accelerator adapter (own model format) | | follow-up |

"Shipped" means in a released image and selectable from `.env`; "this
release" is the current main branch.

## Selecting a flavour

```dotenv
# .env
OPENNVR_ACCEL=auto      # auto (default) | cpu | intel
```

On `auto`, `start.sh` picks `intel` on a Linux host with an Intel render node
(`/sys/class/drm/renderD*`, vendor `0x8086`) and `cpu` everywhere else — the
macOS and Windows Docker VMs expose no devices. The intel choice:

- swaps detect-pipeline for the `-intel` image via `docker-compose.accel-intel.yml`
  (`${CORE_TAG}-intel`; override with `DETECT_PIPELINE_IMAGE`),
- passes `/dev/dri` through, and `/dev/accel` too when `/dev/accel/accel0`
  exists (`docker-compose.accel-intel-npu.yml` — a separate overlay because
  compose refuses to start when a listed device is absent, and N100-class
  boxes have the iGPU but no NPU),
- fills the defaults an `.env` leaves at the CPU value: `DETECT_HWACCEL=vaapi`,
  `DETECT_ONNX_BACKEND=ort`,
  `DETECT_ONNX_PROVIDERS=OpenVINOExecutionProvider:NPU` when `/dev/accel/accel0`
  exists, else `:GPU`.
  An explicit operator value (`qsv`, a pinned `:NPU`) always wins.

`start.sh` prints the decision on every start:

```
Accelerate: intel flavour — iGPU decode (vaapi), detector on OpenVINOExecutionProvider:NPU (NPU present)
```

Running compose by hand instead of `start.sh`: add the overlay(s) with `-f`
and export the three `DETECT_*` values, or set them in `.env`.

### Device shorthand

`DETECT_ONNX_PROVIDERS` is a comma-separated provider list; each provider takes
an optional `:device`, which becomes that provider's device option
(`device_type` for OpenVINO, `device_id` for CUDA/TensorRT):

| Setting | Runs on |
|---|---|
| `OpenVINOExecutionProvider:NPU` | the NPU, CPU fallback (default when the host has one) |
| `OpenVINOExecutionProvider:GPU` | the iGPU / Arc (default otherwise) |
| `OpenVINOExecutionProvider:AUTO:NPU,GPU,CPU` | OpenVINO's AUTO — **not recommended**: it starts on CPU while the accelerator compiles and can stay there; measured 17.0 ms/frame after 30 frames against 7.4 on the pinned NPU |
| `OpenVINOExecutionProvider:CPU` | OpenVINO's own CPU engine |
| `CUDAExecutionProvider:1` | the second NVIDIA GPU |

OpenVINO's multi-device forms keep their commas — a token that is not a
provider name continues the previous device.

## What each flavour carries

| Flavour | Base | Inference wheel | Vendor user-space | Arch |
|---|---|---|---|---|
| `cpu` | `python:3.11-slim` | `onnxruntime` | Intel VA-API driver (iHD) for decode | amd64, arm64 |
| `intel` | same | `onnxruntime-openvino` (bundles OpenVINO) | + Intel OpenCL compute runtime and graphics compiler, Level Zero loader, NPU driver and compiler — pinned in `detect-pipeline/scripts/install-intel-runtime.sh` | amd64 |

The NPU **firmware** is the host's job (`linux-firmware`, loaded by the `ivpu`
kernel driver — kernel 6.8 or newer); the container only needs the user-space
half. Check the host with `ls /dev/accel/accel0` and `journalctl -k | grep intel_vpu`.

## Is it really accelerated? (no silent fallbacks)

Every accelerator path degrades to CPU rather than failing, so each one also
tells you when it did:

| Question | Where to look |
|---|---|
| Is this camera decoding on the GPU? | `tier0_decode_config{camera,hwaccel="vaapi"}` — the **effective** backend; `cpu` next to a `vaapi` request means the render node was not reachable |
| Did core promote cameras to the main stream for a GPU that is not there? | `tier0_mainstream_fallback{camera}` |
| Is the detector on the NPU? | `tier0_detector_backend{requested,effective}` — `effective="CPUExecutionProvider"` beside an OpenVINO request means the device or its driver is missing; the log says the same once at startup |
| Is the iGPU busy at all? | `intel_gpu_top` on the host (`Video` engine = decode, `Render/3D` / `Compute` = inference) |

The two classic mistakes, both now visible: setting `DETECT_HWACCEL=vaapi`
without passing `/dev/dri` (decode stays in software while core hands the
pipeline the full-resolution stream), and requesting OpenVINO on a box whose
image has no Intel compute runtime (the detector quietly runs on CPU).

## Benchmark protocol

The same recipe on every hardware class, so rows compare:

1. Fake cameras from the rig (`docker-compose.fakecams.yml`), 720p H264 in
   copy mode so the rig itself costs no CPU.
2. `DETECT_FPS` at 2 and at 5.
3. Add cameras until the host sits at 70% CPU.
4. Report: cameras per box, host cores used, detector ms/frame, iGPU Video
   engine and NPU utilisation.

### First results — Intel Core Ultra 9 285K (Arrow Lake, 24 cores, iGPU + NPU)

| Measure | cpu flavour | intel flavour |
|---|---|---|
| H264 720p decode | software | VA-API on the iGPU, ~45× real time per stream |
| Tier-0 detector, yolo26n @ 640, ms/frame (single stream, 30-frame average) | 10 (onnxruntime CPU, all cores) | **7.4 NPU**, 7.7 iGPU, 15.5 OpenVINO CPU, 17.0 AUTO |
| Cameras per box at 70% CPU | pending | pending |

The detector row is latency on an otherwise idle box; the number that matters
for an NVR is CPU *freed*: the service caps each CPU detector at
`DETECT_CV_THREADS` (2 by default) so its per-frame cost is far above the
all-cores 10 ms, while the NPU figure costs almost no CPU at all and leaves
the iGPU to decode. The cameras-per-box rows capture that.

Rows fill in as the benchmark runs; the raw harness is `tools/usecase_eval.py`
and the rig is documented in `docs/FAKE_CAMERAS.md`.

## Roadmap

- **Phase 1 (this release):** `intel` flavour for the detect-pipeline, `OPENNVR_ACCEL`, this page.
- **Phase 2:** the ONNX adapters (YOLO, pose, InsightFace, plate OCR, package detection) on the same shared provider resolver, with `-intel` / `-nvidia` flavours.
- **Phase 3:** the `nvidia` flavour, a Hardware panel under Settings → AI, benchmark rows per hardware class.
- Later: ROCm, torch-based adapters per flavour, Coral / Hailo through the accelerator adapter.
