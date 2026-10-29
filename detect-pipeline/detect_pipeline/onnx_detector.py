# Copyright (c) 2026 OpenNVR
# SPDX-License-Identifier: AGPL-3.0-or-later
"""
ONNX object detector for Tier-0, with a **pluggable inference backend**.

The same YOLOv8/YOLO11-family ONNX model is run through one of two backends:

* ``cvdnn`` (default) — ``cv2.dnn`` from OpenCV, already a dependency, so it needs
  **nothing extra to install** and runs on any platform. The OpenCV 5 DNN engine
  is CPU-only but materially faster than 4.x. This is the zero-dependency floor.
* ``ort`` — ONNX Runtime with selectable **execution providers**. On the *same*
  ONNX file this is the on-ramp to accelerators: ``OpenVINOExecutionProvider``
  (Intel CPU / iGPU / NPU — the N100 win), ``TensorrtExecutionProvider`` /
  ``CUDAExecutionProvider`` (Nvidia / Jetson), ``CoreMLExecutionProvider`` (Mac).
  It's an optional dependency (``pip install 'detect-pipeline[onnxruntime]'``, or
  the matching accelerator wheel such as ``onnxruntime-openvino``).

Backends implement one method — ``infer(blob) -> output_tensor`` — so preprocessing
(``cv2.dnn.blobFromImage``) and the decode (``postprocess_yolo``) are shared and
backend-agnostic. Coral (EdgeTPU) and Hailo need their own model format + SDK, so
they are separate backends on this same seam, tracked as follow-ups / the KAI-C
accelerator adapter — not ORT execution providers.

The decode is a pure function tested against synthetic output tensors, and the
net/session is injectable, so nothing here requires a model file, a download, or
onnxruntime to be installed at test time — the real model only loads in deployment.

YOLOv8/YOLO11/YOLO26 detect output (exported with ``end2end`` off) is ``(1, 4+nc, N)`` (e.g. ``(1, 84, 8400)`` for COCO):
4 box params (cx, cy, w, h in input pixels) + ``nc`` class scores per anchor, no
objectness, no softmax. Transpose to ``(N, 4+nc)``, argmax the class scores,
threshold, then ``cv2.dnn.NMSBoxes``. (NMS-free families — YOLO26, RF-DETR — need
a different decode; that's a tracked follow-up, independent of the backend here.)
"""
from __future__ import annotations

import logging

import cv2
import numpy as np

from .detector import RawDetection

log = logging.getLogger("detect_pipeline.onnx_detector")

_CPU_EP = "CPUExecutionProvider"

# COCO-80 class names (the classes the default yolo26n.onnx predicts).
COCO_LABELS = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck",
    "boat", "traffic light", "fire hydrant", "stop sign", "parking meter", "bench",
    "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra",
    "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
    "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove",
    "skateboard", "surfboard", "tennis racket", "bottle", "wine glass", "cup",
    "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
    "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
    "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse",
    "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
    "refrigerator", "book", "clock", "vase", "scissors", "teddy bear",
    "hair drier", "toothbrush",
]


def _clamp01(v: float) -> float:
    return 0.0 if v < 0.0 else (1.0 if v > 1.0 else v)


def postprocess_yolo(
    output: np.ndarray,
    *,
    input_size: int,
    conf_threshold: float = 0.25,
    iou_threshold: float = 0.45,
    labels: list[str] | None = None,
) -> list[RawDetection]:
    """Decode a YOLOv8/YOLO11 ONNX output tensor into normalized detections.

    ``output`` may be ``(1, 4+nc, N)``, ``(4+nc, N)``, or ``(N, 4+nc)``. Boxes are
    returned normalized to ``[0, 1]`` of the model input (which equals the crop).
    """
    labels = labels or COCO_LABELS
    arr = np.squeeze(np.asarray(output))
    if arr.ndim != 2:
        return []
    # Orient to (N, 4+nc): detections are the long axis.
    if arr.shape[0] < arr.shape[1]:
        arr = arr.T
    if arr.shape[1] < 5:
        return []

    boxes_xywh = arr[:, :4].astype(np.float32)
    class_scores = arr[:, 4:]
    class_ids = np.argmax(class_scores, axis=1)
    confidences = class_scores[np.arange(class_scores.shape[0]), class_ids]

    keep = confidences >= conf_threshold
    if not np.any(keep):
        return []
    boxes_xywh, class_ids, confidences = boxes_xywh[keep], class_ids[keep], confidences[keep]

    cx, cy, w, h = boxes_xywh[:, 0], boxes_xywh[:, 1], boxes_xywh[:, 2], boxes_xywh[:, 3]
    x1, y1 = cx - w / 2.0, cy - h / 2.0
    rects = np.stack([x1, y1, w, h], axis=1).tolist()  # NMSBoxes wants [x, y, w, h]

    idxs = cv2.dnn.NMSBoxes(rects, confidences.tolist(), conf_threshold, iou_threshold)
    if idxs is None or len(idxs) == 0:
        return []

    out: list[RawDetection] = []
    for i in np.asarray(idxs).reshape(-1):
        cid = int(class_ids[i])
        label = labels[cid] if 0 <= cid < len(labels) else str(cid)
        out.append(
            RawDetection(
                label,
                float(confidences[i]),
                (
                    _clamp01(x1[i] / input_size),
                    _clamp01(y1[i] / input_size),
                    _clamp01((x1[i] + w[i]) / input_size),
                    _clamp01((y1[i] + h[i]) / input_size),
                ),
            )
        )
    return out


# ─────────────────────────── inference backends ───────────────────────────
# A backend takes a preprocessed NCHW float32 blob and returns the raw model
# output tensor. Preprocessing + decode live in the detector, so a backend is
# tiny and the two are interchangeable.


class CvDnnBackend:
    """Run the ONNX model through ``cv2.dnn`` (default; zero extra dependency, CPU)."""

    name = "cvdnn"

    def __init__(self, model_path: str | None = None, *, net=None) -> None:
        # ``net`` is injectable for tests (an object with .setInput()/.forward()).
        if net is not None:
            self._net = net
        else:
            if not model_path:
                raise ValueError("CvDnnBackend needs a model_path or an injected net")
            self._net = cv2.dnn.readNetFromONNX(model_path)

    def infer(self, blob: np.ndarray) -> np.ndarray:
        self._net.setInput(blob)
        return self._net.forward()

    def infer_all(self, blob: np.ndarray) -> list[np.ndarray]:
        """All output tensors (multi-head models, e.g. DETR's dets+labels)."""
        self._net.setInput(blob)
        names = self._net.getUnconnectedOutLayersNames()
        outs = self._net.forward(names) if names else [self._net.forward()]
        return list(outs)


# Device option each execution provider takes, keyed by provider name. The
# ``Name:device`` shorthand in DETECT_ONNX_PROVIDERS maps onto it:
#   OpenVINOExecutionProvider:NPU             -> {"device_type": "NPU"}
#   OpenVINOExecutionProvider:AUTO:NPU,GPU    -> {"device_type": "AUTO:NPU,GPU"}
#   CUDAExecutionProvider:1                   -> {"device_id": "1"}
# Providers not listed here take no device and the shorthand is refused.
_DEVICE_OPTION = {
    "OpenVINOExecutionProvider": "device_type",
    "CUDAExecutionProvider": "device_id",
    "TensorrtExecutionProvider": "device_id",
    "ROCMExecutionProvider": "device_id",
    "MIGraphXExecutionProvider": "device_id",
}


def parse_provider_specs(requested) -> list[tuple[str, str | None]]:
    """Split a provider setting into ``(name, device)`` pairs.

    ``requested`` is a comma-separated string or a list. A token that is not
    a provider name (does not end in ``ExecutionProvider``) continues the
    previous token's device, so the OpenVINO multi-device forms survive the
    comma split: ``OpenVINOExecutionProvider:AUTO:NPU,GPU,CPUExecutionProvider``
    is ``[("OpenVINOExecutionProvider", "AUTO:NPU,GPU"), ("CPUExecutionProvider", None)]``.
    """
    if requested is None:
        return []
    if isinstance(requested, str):
        tokens = [t.strip() for t in requested.split(",") if t.strip()]
    else:
        tokens = []
        for item in requested:
            if isinstance(item, tuple):
                name, opts = item
                dev = (opts or {}).get(_DEVICE_OPTION.get(name, ""), None) if isinstance(opts, dict) else None
                tokens.append(f"{name}:{dev}" if dev else name)
            else:
                tokens.append(str(item).strip())
    specs: list[tuple[str, str | None]] = []
    for tok in tokens:
        if not tok:
            continue
        name, _, device = tok.partition(":")
        if name.endswith("ExecutionProvider") or not specs:
            specs.append((name, device or None))
        else:
            prev_name, prev_dev = specs[-1]
            specs[-1] = (prev_name, f"{prev_dev},{tok}" if prev_dev else tok)
    return specs


def provider_entry(name: str, device: str | None):
    """What ``onnxruntime.InferenceSession(providers=...)`` takes for one spec:
    the bare name, or ``(name, {option: device})`` when a device was asked for."""
    if not device:
        return name
    option = _DEVICE_OPTION.get(name)
    if option is None:
        log.warning("ORT provider %s takes no device; ignoring %r", name, device)
        return name
    return (name, {option: device})


def provider_name(entry) -> str:
    return entry[0] if isinstance(entry, tuple) else entry


def resolve_providers(requested, available) -> list:
    """Pick ORT execution providers: ``requested ∩ available``, CPU always last.

    Pure + testable. ``requested`` may be a list or a comma string; ``None`` means
    "let ORT use whatever it has, by its own priority order". CPU is always kept as
    a final fallback so a missing accelerator EP degrades instead of failing.

    Entries carry their device when one was requested (``Name:device``, see
    :func:`parse_provider_specs`), as the ``(name, options)`` tuples ORT takes.
    """
    available = list(available) if available else []
    specs = parse_provider_specs(requested)
    if not specs:
        provs: list = list(available) if available else [_CPU_EP]
    else:
        provs = []
        for name, device in specs:
            if available and name not in available:
                log.warning("ORT provider %s not available; skipping", name)
                continue
            provs.append(provider_entry(name, device))
    if _CPU_EP not in [provider_name(p) for p in provs]:
        provs.append(_CPU_EP)
    return provs


def describe_providers(entries) -> str:
    """``OpenVINOExecutionProvider(NPU), CPUExecutionProvider`` — for logs and the UI."""
    parts = []
    for e in entries:
        if isinstance(e, tuple):
            name, opts = e
            dev = next(iter((opts or {}).values()), None)
            parts.append(f"{name}({dev})" if dev else name)
        else:
            parts.append(str(e))
    return ", ".join(parts)


def _ort_session_options(ort):
    """Bound an ORT session's own thread pools to DETECT_CV_THREADS.

    ``cv2.setNumThreads`` caps OpenCV ONLY. An InferenceSession built with no
    options defaults ``intra_op_num_threads`` to the machine's core count and
    allocates its own pool, so the ``ort`` and ``rfdetr`` paths escaped the
    service's only CPU governor entirely — several sessions on one box then
    each believed they owned every core. The detector pool caps how many
    sessions exist; this caps how wide each one is.

    An EXPLICIT 0 means "let ORT decide". Unset/empty pins 2 instead —
    deliberately conservative, because this path has no equivalent of the
    OpenCV governor: WorkerManager._tune_inference_threads only ever calls
    cv2.setNumThreads, so an unset value here would leave every session
    claiming the whole box. That asymmetry is a real gap (the ort/rfdetr
    paths never widen on an idle host the way the cvdnn path does), but it
    is a safe default rather than an accidental one.
    """
    import os as _os

    opts = ort.SessionOptions()
    try:
        threads = int((_os.environ.get("DETECT_CV_THREADS") or "2").strip() or 0)
    except ValueError:
        threads = 2
    if threads > 0:
        opts.intra_op_num_threads = threads
        opts.inter_op_num_threads = 1     # one session, one request at a time
    return opts


class OrtBackend:
    """Run the ONNX model through ONNX Runtime with selectable execution providers.

    This is the accelerator on-ramp: install the matching wheel
    (``onnxruntime``, ``onnxruntime-openvino``, ``onnxruntime-gpu``) and pass
    ``providers`` (e.g. ``["OpenVINOExecutionProvider"]`` on an Intel N100, or
    ``["TensorrtExecutionProvider"]`` on Nvidia). The *same* ONNX model is used.
    """

    name = "ort"

    def __init__(
        self,
        model_path: str | None = None,
        *,
        providers=None,
        session=None,  # injectable for tests (obj with .get_inputs()/.run())
    ) -> None:
        if session is not None:
            self._sess = session
        else:
            if not model_path:
                raise ValueError("OrtBackend needs a model_path or an injected session")
            import onnxruntime as ort  # lazy: optional dependency

            provs = resolve_providers(providers, ort.get_available_providers())
            log.info("ONNX Runtime backend requesting providers: %s", describe_providers(provs))
            self._sess = ort.InferenceSession(
                model_path, sess_options=_ort_session_options(ort), providers=provs
            )
            self.requested = provs
        self._input = self._sess.get_inputs()[0].name
        self.effective = self._effective_providers()

    def _effective_providers(self) -> list[str]:
        """What the session actually runs on. ORT drops a provider it cannot
        initialise (no OpenVINO device, no CUDA libs) and carries on with the
        next one *silently* — the "declared an accelerator, running on CPU"
        failure. Surface it: log once, and expose it for metrics and the UI."""
        try:
            effective = list(self._sess.get_providers())
        except Exception:
            return []
        requested = getattr(self, "requested", None)
        if requested:
            wanted = provider_name(requested[0])
            if wanted != _CPU_EP and (not effective or effective[0] != wanted):
                log.warning(
                    "ONNX Runtime could not use %s — running on %s. Check the "
                    "accelerator's user-space driver is in the image and its "
                    "device is passed through to the container.",
                    describe_providers(requested[:1]), ", ".join(effective) or "nothing",
                )
            else:
                log.info("ONNX Runtime backend running on %s", describe_providers(requested[:1]))
        return effective

    def infer(self, blob: np.ndarray) -> np.ndarray:
        return self._sess.run(None, {self._input: blob})[0]

    def infer_all(self, blob: np.ndarray) -> list[np.ndarray]:
        """All output tensors (multi-head models, e.g. DETR's dets+labels)."""
        return list(self._sess.run(None, {self._input: blob}))


def build_backend(name: str, model_path: str | None = None, *, providers=None,
                  net=None, session=None):
    """Construct an inference backend by name: ``cvdnn`` (default) or ``ort``."""
    name = (name or "cvdnn").lower()
    if name in ("cvdnn", "opencv", "dnn"):
        return CvDnnBackend(model_path, net=net)
    if name in ("ort", "onnxruntime", "onnx-runtime"):
        return OrtBackend(model_path, providers=providers, session=session)
    raise ValueError(f"unknown ONNX backend {name!r} (use 'cvdnn' or 'ort')")


class OnnxYoloDetector:
    """YOLOv8/YOLO11 ONNX detector over a pluggable backend (``cvdnn`` or ``ort``)."""

    def __init__(
        self,
        model_path: str | None = None,
        *,
        input_size: int = 640,
        conf_threshold: float = 0.25,
        iou_threshold: float = 0.45,
        labels: list[str] | None = None,
        backend: str = "cvdnn",
        providers=None,
        net=None,      # injects a cv2.dnn net  -> cvdnn backend (also back-compat)
        session=None,  # injects an ORT session -> ort backend
        backend_impl=None,  # inject a fully-built backend
    ) -> None:
        self.input_size = input_size
        self.conf_threshold = conf_threshold
        self.iou_threshold = iou_threshold
        self.labels = labels or COCO_LABELS
        if backend_impl is not None:
            self._backend = backend_impl
        elif net is not None:
            self._backend = CvDnnBackend(net=net)
        elif session is not None:
            self._backend = OrtBackend(session=session)
        elif model_path:
            self._backend = build_backend(backend, model_path, providers=providers)
        else:
            raise ValueError(
                "OnnxYoloDetector needs a model_path, or an injected net/session/backend_impl"
            )
        self.backend_name = getattr(self._backend, "name", "custom")
        # Settle the input size against the real graph ONCE, rather than
        # raising per region per frame (which killed the worker). Only the
        # cv2.dnn path can be probed cheaply; ORT reports its own shapes.
        if model_path:
            from .detector import resolve_input_size
            self.input_size = resolve_input_size(self, self.input_size)

    def detect(self, crop: np.ndarray) -> list[RawDetection]:
        blob = cv2.dnn.blobFromImage(
            crop, scalefactor=1 / 255.0,
            size=(self.input_size, self.input_size), swapRB=True, crop=False,
        )
        output = self._backend.infer(blob)
        return postprocess_yolo(
            output, input_size=self.input_size,
            conf_threshold=self.conf_threshold, iou_threshold=self.iou_threshold,
            labels=self.labels,
        )
