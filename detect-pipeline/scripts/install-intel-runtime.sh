#!/bin/sh
# Copyright (c) 2026 OpenNVR
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Intel user-space runtime for the ``intel`` image flavour (ACCEL=intel):
#   - OpenCL compute runtime + graphics compiler  -> OpenVINO's GPU device (iGPU / Arc)
#   - Level Zero loader + NPU driver and compiler -> OpenVINO's NPU device (Core Ultra)
# Debian carries none of the compute runtime, so these come from Intel's own
# GitHub releases, pinned. amd64 only: there are no Intel iGPUs on arm64.
# The NPU *firmware* lives on the host (linux-firmware, loaded by the ivpu
# kernel driver), not here; the container only needs the user-space half.
set -eu
[ "$(dpkg --print-architecture)" = "amd64" ] || { echo "intel runtime: amd64 only, skipping"; exit 0; }

LEVEL_ZERO=1.34.0
GMM=22.10.0
IGC=2.42.6
IGC_BUILD=23070
NEO=26.35.39758.10
NPU=1.38.0.20260910-34487311128

GH=https://github.com
tmp=$(mktemp -d)
cd "$tmp"
get() { echo "  fetching $(basename "$2")"; curl -fsSL --retry 3 -o "$2" "$1"; }

get "$GH/oneapi-src/level-zero/releases/download/v$LEVEL_ZERO/libze1_${LEVEL_ZERO}%2Bu24.04_amd64.deb"      libze1.deb
get "$GH/intel/compute-runtime/releases/download/$NEO/libigdgmm12_${GMM}_amd64.deb"                             gmm.deb
get "$GH/intel/intel-graphics-compiler/releases/download/v$IGC/intel-igc-core-2_${IGC}%2B${IGC_BUILD}_amd64.deb"   igc-core.deb
get "$GH/intel/intel-graphics-compiler/releases/download/v$IGC/intel-igc-opencl-2_${IGC}%2B${IGC_BUILD}_amd64.deb" igc-opencl.deb
get "$GH/intel/compute-runtime/releases/download/$NEO/intel-opencl-icd_${NEO}-0_amd64.deb"                     opencl-icd.deb
get "$GH/intel/linux-npu-driver/releases/download/v${NPU%%.2*}/linux-npu-driver-v${NPU}-ubuntu2404.tar.gz"     npu.tar.gz
mkdir npu && tar -xzf npu.tar.gz -C npu

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ocl-icd-libopencl1 clinfo
# dpkg first, then let apt pull whatever Debian deps the Ubuntu-built packages
# declare (libtbb, libstdc++ ...); a second dpkg pass is never needed.
dpkg -i libze1.deb gmm.deb igc-core.deb igc-opencl.deb opencl-icd.deb || apt-get install -y -f --no-install-recommends
dpkg -i npu/intel-level-zero-npu_*.deb npu/intel-driver-compiler-npu_*.deb || apt-get install -y -f --no-install-recommends
rm -rf /var/lib/apt/lists/* "$tmp"
echo "intel runtime installed: level-zero $LEVEL_ZERO, compute-runtime $NEO, igc $IGC, npu $NPU"
