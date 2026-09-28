#!/usr/bin/env bash
# Regression tests for the installer's hardware-aware model sizing.
#
# The field bug: the installer suggested `qwen3:1.7b` + `gemma3:4b` on every
# machine an operator tried, including low-end Windows and Linux boxes, and
# the camera agent then failed to run. The vision model was gated on
# `RAM >= 8` ALONE, so an 8 GB machine was handed 5 GB of models on top of a
# ~3 GB stack — the whole machine — and thrashed.
#
# The rule these tests defend: both Ollama models are RESIDENT AT ONCE
# (OLLAMA_KEEP_ALIVE=-1 in the shipped compose) and share the box with the
# OpenNVR stack, so they must be budgeted TOGETHER, never independently.
set -u

. "$(dirname "$0")/_lib.sh"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT" || exit 1

TESTS_RUN=0
TESTS_FAILED=0
start_test() { TESTS_RUN=$((TESTS_RUN + 1)); printf "  [%2d] %s ... " "$TESTS_RUN" "$1"; }
pass() { echo "PASS"; }
fail() { echo "FAIL"; echo "      $1"; TESTS_FAILED=$((TESTS_FAILED + 1)); }

echo "Running installer model-sizing tests"
echo ""

# Pull just the sizing block out of install.sh and run it in this shell, so
# the tests exercise the REAL logic rather than a copy that can drift.
SIZING=$(awk '/^OPENNVR_STACK_GB=/,/^# ── Catalog-driven model menu/' scripts/install.sh | sed '$d')
if [[ -z "$SIZING" ]]; then
    echo "✗ could not extract the sizing block from scripts/install.sh" >&2
    exit 1
fi
eval "$SIZING"

# size <ram_gb> <cores> <accel> → "LLM|VLM|adapter|whisper"
size() {
    HW_RAM_GB="$1"; HW_CORES="$2"; HW_ACCEL="$3"
    suggest_models
    printf '%s|%s|%s|%s' "$SUGGEST_LLM" "$SUGGEST_VLM" \
        "$SUGGEST_CAPTION_ADAPTER" "$(suggest_whisper_model)"
}

# ── 1. the reported failure ──
start_test "8 GB / 4 cores does not get a 4 GB vision model"
got=$(size 8 4 cpu)
vlm=$(cut -d'|' -f2 <<<"$got")
if [[ -z "$vlm" ]]; then
    pass
else
    fail "8 GB box was handed Ollama vision model '${vlm}' (got: ${got})"
fi

start_test "8 GB / 4 cores falls back to the small in-container adapter"
adapter=$(cut -d'|' -f3 <<<"$(size 8 4 cpu)")
[[ "$adapter" == "moondream" ]] && pass \
    || fail "expected the moondream adapter, got '${adapter}'"

# ── 2. the models are budgeted together, not independently ──
start_test "LLM + vision never exceed the machine's model budget"
catalog="examples/camera-agent/model_catalog.txt"
ram_of() {  # model name → its catalog min_ram_gb (0 if absent/empty)
    [[ -n "$1" ]] || { echo 0; return; }
    awk -F'|' -v m="$1" '$2 == m { print $3; found=1 } END { if (!found) print 0 }' \
        <(grep -v '^#' "$catalog")
}
# Smallest tested LLM in the catalog — the floor the installer may fall back
# to on a machine too small for anything, because suggesting NOTHING is not a
# usable install. That fallback is the one permitted overshoot.
FLOOR_RAM=$(awk -F'|' '$1 == "llm" && $4 == "yes" { if (min == "" || $3 < min) min = $3 }
                       END { print min + 0 }' <(grep -v '^#' "$catalog"))
over=""
for spec in "4 2 cpu" "8 4 cpu" "8 8 cpu" "16 8 cpu" "16 4 cpu" \
            "32 16 cpu" "8 8 cuda" "16 8 cuda" "32 12 metal"; do
    read -r ram cores accel <<<"$spec"
    got=$(size "$ram" "$cores" "$accel")
    HW_RAM_GB="$ram"; compute_model_budget
    total=$(( $(ram_of "$(cut -d'|' -f1 <<<"$got")") \
            + $(ram_of "$(cut -d'|' -f2 <<<"$got")") ))
    if (( HW_MODEL_BUDGET_GB < FLOOR_RAM )); then
        # Too small for even the floor: the only acceptable answer is that
        # floor alone, with vision pushed to the small container adapter.
        (( total > FLOOR_RAM )) && over="${over} [${spec}: ${total}GB where only the ${FLOOR_RAM}GB floor is allowed]"
    elif (( total > HW_MODEL_BUDGET_GB )); then
        over="${over} [${spec}: ${total}GB of models vs ${HW_MODEL_BUDGET_GB}GB budget]"
    fi
done
[[ -z "$over" ]] && pass || fail "over budget:${over}"

# ── 3. capability actually changes the answer ──
start_test "a weak machine and a strong one get different models"
weak=$(size 4 2 cpu)
strong=$(size 32 16 cpu)
[[ "$weak" != "$strong" ]] && pass \
    || fail "same suggestion for a 4 GB mini PC and a 32 GB server: ${weak}"

start_test "cores matter on CPU-only, not just RAM"
a=$(cut -d'|' -f1 <<<"$(size 16 4 cpu)")
b=$(cut -d'|' -f1 <<<"$(size 16 8 cpu)")
[[ "$a" != "$b" ]] && pass \
    || fail "4-core and 8-core 16 GB boxes both got '${a}'"

start_test "a GPU lifts the tier above the CPU-only answer"
cpu=$(cut -d'|' -f1 <<<"$(size 16 8 cpu)")
gpu=$(cut -d'|' -f1 <<<"$(size 16 8 cuda)")
[[ "$cpu" != "$gpu" ]] && pass \
    || fail "GPU and CPU-only 16 GB boxes both got '${cpu}'"

# ── the second field report: "LLM is machine specific now, but the VLM is
# still gemma on every machine". It was — the LLM got a speed ceiling and the
# vision model only got a RAM one, so every box with room landed on the same
# 4B model. It fits, so it won, even CPU-only where a caption costs ~25 s
# against ~1-2 s on a GPU.
start_test "the vision model varies with hardware, not just the LLM"
seen=$(for spec in "8 4 cpu" "16 8 cpu" "32 16 cpu" "16 8 cuda" "32 12 metal"; do
           read -r ram cores accel <<<"$spec"
           cut -d'|' -f2 <<<"$(size "$ram" "$cores" "$accel")"
       done | sort -u | wc -l | tr -d ' ')
(( seen > 1 )) && pass \
    || fail "every machine got the same vision answer across CPU, GPU and Metal"

start_test "a heavyweight vision model is not suggested on a CPU-only box"
catalog="examples/camera-agent/model_catalog.txt"
speed_of() { awk -F'|' -v m="$1" '$2 == m { print $5 }' <(grep -v '^#' "$catalog"); }
slow=""
for spec in "16 8 cpu" "32 16 cpu" "64 32 cpu"; do
    read -r ram cores accel <<<"$spec"
    vlm=$(cut -d'|' -f2 <<<"$(size "$ram" "$cores" "$accel")")
    [[ -n "$vlm" ]] || continue
    sp=$(speed_of "$vlm")
    [[ "$sp" == "fastest" || "$sp" == "fast" ]] \
        || slow="${slow} [${spec} → ${vlm} (${sp})]"
done
[[ -z "$slow" ]] && pass || fail "slow vision model on CPU-only:${slow}"

start_test "a GPU still gets the better vision model"
gpu_vlm=$(cut -d'|' -f2 <<<"$(size 16 8 cuda)")
cpu_vlm=$(cut -d'|' -f2 <<<"$(size 16 8 cpu)")
[[ -n "$gpu_vlm" && "$gpu_vlm" != "$cpu_vlm" ]] && pass \
    || fail "GPU box got '${gpu_vlm:-nothing}', same as CPU-only — the speed ceiling should only bind on CPU"

# ── 4. failing to detect must size DOWN, never up ──
start_test "undetectable hardware is treated as a small machine"
got=$(size 0 0 cpu)
llm=$(cut -d'|' -f1 <<<"$got"); vlm=$(cut -d'|' -f2 <<<"$got")
if [[ "$llm" == "qwen2.5:0.5b" && -z "$vlm" ]]; then
    pass
else
    fail "detection failure should size down, got: ${got}"
fi

# A machine smaller than the stack itself drives the budget NEGATIVE. It must
# clamp to zero and pick the floor — not wrap, and not be read as "unlimited".
# Plenty of threads here on purpose, so the core tier cannot mask the bug.
start_test "a machine smaller than the stack clamps to the floor"
HW_RAM_GB=2; compute_model_budget
if (( HW_MODEL_BUDGET_GB != 0 )); then
    fail "2 GB machine reported a ${HW_MODEL_BUDGET_GB} GB model budget"
else
    got=$(size 2 8 cpu)
    llm=$(cut -d'|' -f1 <<<"$got"); vlm=$(cut -d'|' -f2 <<<"$got")
    if [[ "$llm" == "qwen2.5:0.5b" && -z "$vlm" ]]; then
        pass
    else
        fail "2 GB / 8 threads should get the floor and no Ollama vision, got: ${got}"
    fi
fi

# ── 5. never suggest past the tested envelope ──
start_test "suggestions stay inside the tested set"
bad=""
for spec in "4 2 cpu" "8 4 cpu" "16 8 cpu" "32 16 cpu" "32 12 metal" "64 32 cuda"; do
    read -r ram cores accel <<<"$spec"
    got=$(size "$ram" "$cores" "$accel")
    for m in "$(cut -d'|' -f1 <<<"$got")" "$(cut -d'|' -f2 <<<"$got")"; do
        [[ -n "$m" ]] || continue
        tested=$(awk -F'|' -v m="$m" '$2 == m { print $4 }' <(grep -v '^#' "$catalog"))
        [[ "$tested" == "yes" ]] || bad="${bad} [${spec} → ${m} is '${tested:-not in catalog}']"
    done
done
[[ -z "$bad" ]] && pass || fail "untested model suggested:${bad}"

# ── 6. the two installers must not drift apart ──
# ── the machine one reboot away from a GPU ──
# Field report: Ollama's installer put a CUDA driver on a 30 GB box and
# asked for a reboot. nvidia-smi could not answer until that reboot, so
# the installer read the machine as CPU-only and suggested qwen3:1.7b for
# a GPU box. detect_llm_hardware has to treat a pending driver reboot as
# the CUDA it is about to be.
DETECT=$(awk '/^detect_llm_hardware\(\) \{/,/^\}/' scripts/install.sh)
start_test "detect_llm_hardware is still extractable"
[[ -n "$DETECT" ]] && pass || fail "could not extract detect_llm_hardware"

# accel_with_pending <yes|""> → HW_ACCEL, on a box where nvidia-smi does
# not answer (exactly the pre-reboot state).
accel_with_pending() {
    bash -u -c '
        PLATFORM="Linux"; NVIDIA_REBOOT_PENDING="'"$1"'"
        HW_RAM_GB=0; HW_CORES=0; HW_ACCEL=""
        command() {
            [[ "$1" == "-v" && "$2" == "nvidia-smi" ]] && return 1
            builtin command "$@"
        }
        nproc() { echo 8; }
        '"$DETECT"'
        detect_llm_hardware host
        printf "%s" "$HW_ACCEL"
    ' 2>/dev/null
}

start_test "a pending NVIDIA driver reboot is sized as CUDA, not CPU"
got=$(accel_with_pending yes)
[[ "$got" == "cuda" ]] && pass \
    || fail "pre-reboot CUDA box detected as '${got}' — it would be sized for CPU"

start_test "no pending reboot and no nvidia-smi is still plain CPU"
got=$(accel_with_pending "")
[[ "$got" == "cpu" ]] && pass \
    || fail "a CPU box must not claim a GPU, got '${got}'"

start_test "the pending-reboot flag actually changes the suggestion"
# The consequence the operator sees: same 30 GB machine, the only
# difference is whether the driver has loaded yet.
cpu_llm=$(cut -d"|" -f1 <<<"$(size 30 8 cpu)")
gpu_llm=$(cut -d"|" -f1 <<<"$(size 30 8 cuda)")
[[ "$cpu_llm" != "$gpu_llm" ]] && pass \
    || fail "pre/post reboot suggest the same model (${cpu_llm}) — the flag buys nothing"

# ── Vision through Ollama is a GPU path (#583) ──
# The field box: CAPTION_ADAPTER=ollamavlm on an 8-core CPU, Ollama's 1.8B
# moondream at 30 s+ a frame, core timing out at 15 s, two cores burnt for
# zero captions saved. A strong CPU used to be handed ollamavlm because a
# "fast tier" vision model fit its RAM; fitting and keeping up differ.
start_test "a strong CPU box is never handed ollamavlm"
got=$(size 32 16 cpu)
adapter=$(cut -d'|' -f3 <<<"$got"); vlm=$(cut -d'|' -f2 <<<"$got")
[[ "$adapter" == "moondream" && -z "$vlm" ]] && pass \
    || fail "32 GB / 16-core CPU got '${adapter}' with VLM '${vlm}' (got: ${got})"

start_test "Apple Silicon (Metal) is on the CPU side of the vision line"
# The LLM runs on the host GPU, but the adapter container runs in the
# Docker VM with no GPU either way — Varun's call: native moondream on M2
# until there is a real GPU.
adapter=$(cut -d'|' -f3 <<<"$(size 32 12 metal)")
[[ "$adapter" == "moondream" ]] && pass \
    || fail "Metal box got '${adapter}' — the caption adapter has no Metal to use"

start_test "a CUDA box with RAM still gets ollamavlm"
got=$(size 32 12 cuda)
adapter=$(cut -d'|' -f3 <<<"$got"); vlm=$(cut -d'|' -f2 <<<"$got")
[[ "$adapter" == "ollamavlm" && -n "$vlm" ]] && pass \
    || fail "CUDA box lost the Ollama vision path (got: ${got})"

start_test "every suggestion carries a reason the operator is shown"
missing=""
for spec in "8 4 cpu" "32 16 cpu" "32 12 metal" "8 8 cuda" "32 12 cuda"; do
    unset SUGGEST_CAPTION_REASON            # a stale one from the last spec must not count
    size $spec >/dev/null
    [[ -n "${SUGGEST_CAPTION_REASON:-}" ]] || missing="${missing} ${spec};"
done
[[ -z "$missing" ]] && pass || fail "no SUGGEST_CAPTION_REASON for:${missing}"

# ── Background visit descriptions default by hardware (#583) ──
start_test "visit descriptions default ON only for a GPU captioner"
HW_ACCEL=cuda
[[ "$(suggest_enrichment_default ollamavlm)" == "true" ]] && pass \
    || fail "ollamavlm on a CUDA Ollama keeps up; enrichment should stay on"

start_test "a CUDA box whose captioner runs on CPU gets the CPU answer"
# Too little RAM beside the LLM → the in-container moondream (onnxruntime,
# no GPU); or the operator typed blip. Either way the GPU is not what
# captions, so "a GPU keeps up" would be false — and it was said.
HW_ACCEL=cuda
a=$(suggest_enrichment_default moondream); b=$(suggest_enrichment_default blip)
[[ "$a" == "false" && "$b" == "false" ]] && pass \
    || fail "CUDA+moondream='${a}' CUDA+blip='${b}' — those captioners run on CPU"

start_test "visit descriptions default OFF on CPU and Metal"
HW_ACCEL=cpu;   a=$(suggest_enrichment_default moondream)
HW_ACCEL=metal; b=$(suggest_enrichment_default moondream)
[[ "$a" == "false" && "$b" == "false" ]] && pass \
    || fail "CPU='${a}' Metal='${b}' — the captioner cannot keep up with a busy camera there"

# ── configure_enrichment_flags against a .env ──
# Stub the installer's I/O so the REAL function runs: env_get/env_set on
# an in-memory .env, explain silenced, ask_yes_no answering "Enter" (the
# default). The field bug this defends: on a fresh install .env has just
# been copied from .env.example, whose EVENTS_CAPTION_ENRICHMENT=true then
# looked like "the operator's last answer" and the CPU default never ran.
# (Plain variables through indirection, not an associative array: the
# macOS bash is 3.2 and this test runs there too.)
env_get() { local v="FAKE_$1"; printf '%s' "${!v:-}"; }
env_set() { printf -v "FAKE_$1" '%s' "$2"; }
explain() { :; }
ok() { :; }
ask_yes_no() { [[ "${2:-n}" == "y" ]]; }
flags_after() {   # <fresh> <accel> <adapter> <caption> <descriptor> → "caption|descriptor"
    FAKE_CAPTION_ADAPTER="$3"
    FAKE_EVENTS_CAPTION_ENRICHMENT="$4"
    FAKE_EVENTS_DESCRIPTOR_ENRICHMENT="$5"
    FRESH_ENV="$1"; HW_ACCEL="$2"
    configure_enrichment_flags >/dev/null
    printf '%s|%s' "$FAKE_EVENTS_CAPTION_ENRICHMENT" "$FAKE_EVENTS_DESCRIPTOR_ENRICHMENT"
}

start_test "fresh CPU install: the example's 'true' is not the operator's answer"
got=$(flags_after true cpu moondream true true)
[[ "$got" == "false|false" ]] && pass \
    || fail "fresh CPU install pressing Enter left enrichment '${got}' — the #583 configuration"

start_test "fresh CUDA install with ollamavlm: on, unasked"
got=$(flags_after true cuda ollamavlm true true)
[[ "$got" == "true|true" ]] && pass || fail "got '${got}'"

start_test "fresh CUDA install that fell back to the CPU moondream: off by default"
got=$(flags_after true cuda moondream true true)
[[ "$got" == "false|false" ]] && pass || fail "got '${got}'"

start_test "reconfigure keeps the operator's previous yes"
got=$(flags_after false cpu moondream true true)
[[ "$got" == "true|true" ]] && pass || fail "a reconfigure flattened a deliberate 'on' to '${got}'"

start_test "reconfigure never flattens a split pair it cannot ask about"
got=$(flags_after false cuda ollamavlm true false)
[[ "$got" == "true|false" ]] && pass || fail "captions-on/descriptors-off became '${got}'"
unset -f env_get env_set explain ok ask_yes_no

start_test "install.ps1 mirrors the GPU-captioner rule"
if grep -q "accel -eq 'cuda' -and \$pick" scripts/install.ps1 \
   && grep -q "enrichSuggest = if (\$accel -eq 'cuda' -and \$captionAdapter -eq 'ollamavlm')" scripts/install.ps1 \
   && grep -q 'if ($script:FreshEnv) { $enrichCurrent = ' scripts/install.ps1; then
    pass
else
    fail "install.ps1 no longer mirrors: CUDA-only ollamavlm, enrichment on only for a GPU captioner, fresh .env ignored"
fi

start_test "install.ps1 probes NVIDIA whichever way the LLM runs"
if grep -q "nvidia-smi -L" scripts/install.ps1 \
   && ! grep -B3 "nvidia-smi -L" scripts/install.ps1 | grep -q "llmWhere -eq 'host'"; then
    pass
else
    fail "install.ps1 only detects CUDA when the LLM runs on the host — an RTX box on the bundled container is sized as CPU"
fi

start_test "install.ps1 carries the same budget arithmetic"
if grep -q 'stackGb = 3; \$osHeadroomGb = 2' scripts/install.ps1 \
   && grep -q 'budgetGb = \[math\]::Max(0, \$ramGb - \$stackGb - \$osHeadroomGb)' scripts/install.ps1; then
    pass
else
    fail "install.ps1's budget no longer matches install.sh's"
fi

start_test "install.ps1 gates the Ollama vision path on the budget"
grep -q 'captionSuggest -eq .ollamavlm.' scripts/install.ps1 && pass \
    || fail "install.ps1 no longer lets the budget veto CAPTION_ADAPTER=ollamavlm"

echo ""
if (( TESTS_FAILED > 0 )); then
    echo "✗ ${TESTS_FAILED} of ${TESTS_RUN} tests failed"
    exit 1
fi
echo "✓ all ${TESTS_RUN} tests passed"
