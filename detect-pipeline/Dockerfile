# Copyright (c) 2026 OpenNVR
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# OpenNVR Tier-0 detect-pipeline service.
FROM python:3.11-slim

# ffmpeg/ffprobe: hardware decode + resolution probe of the camera substream.
# intel-media-va-driver is the VA-API (iHD) driver for every Intel iGPU
# since Broadwell, from Debian main. Debian's ffmpeg pulls in Mesa's AMD
# driver by itself but NOT Intel's, so without it DETECT_HWACCEL=vaapi on an
# Intel box fails libva init and silently falls back to software decode —
# while core, reading the same setting, has already promoted the camera to
# the main stream. Verified on Arrow Lake (8086:7d67): H264/HEVC decode,
# no LIBVA_DRIVER_NAME needed. amd64 only — the package does not exist for
# arm64 (no Intel iGPUs there), and the multi-arch build must not fail on it.
# libglib2.0-0: opencv-python-headless runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libglib2.0-0 \
    && if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
         apt-get install -y --no-install-recommends intel-media-va-driver libva-drm2; \
       fi \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . /app
RUN pip install --no-cache-dir ".[service]"

# On by default; set DETECT_PIPELINE_ENABLED=false to disable without redeploy.
ENV DETECT_PIPELINE_ENABLED=true

# The service holds no ports open — it consumes MediaMTX and publishes to NATS.
CMD ["opennvr-tier0"]
