#!/usr/bin/env python3
# Copyright (c) 2026 OpenNVR
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Live-eval harness for the camera-agent: does the model pick the right
tool, with the right arguments, and answer from what the tool returned?

The live tier of the eval strategy in AGENT_DESIGN.md (Discussion #607).
The deterministic tier is tests/test_agent_evals.py; this one needs a real
model, so like tools/latency_harness.py it runs against a LIVE agent and
not in CI. The pure parts (case loading, scoring, aggregation) are
unit-tested in tests/test_eval_harness.py.

    python tools/eval_harness.py --url http://localhost:9100 \\
        --camera front_door --repeat 5 --throwaway --out run.json

RUN IT ONLY AGAINST A THROWAWAY AGENT. Cases arm real alarms and monitors
(the harness deletes the ones it created, but a monitor or alarm can fire
a real notification while it exists), queue background tasks it cannot
delete, and every case clears the agent's shared chat history (/reset).
--throwaway is required to say you read this.

How a run works, per case and repeat, strictly one at a time (the agent
keeps one chat history, so cases cannot run in parallel):

1. POST /reset (chat history only), then snapshot the ids in /alarms,
   /monitors, /tasks and /reports.
2. Send each turn to POST /ask and keep the reply and the trace.
3. Diff the snapshot: what is new is what the turn created. Score it,
   then delete the alarms and monitors the case created.

Scoring is deterministic, no LLM judge. Each tool step in the trace says
who chose it (`by`: model / router / forced) and the arguments as asked;
a final `reply` step says where the answer came from. Arguments are
checked twice, as Varun asked in #607: in the trace (what the model
asked for) and in the state read back (what the agent made of it after
its own normalisation).

Two columns per case:
  pass   the agent as a whole did the right thing (any chooser)
  model  the MODEL chose the right tool itself; a forced grounding or a
         router (tier 0) call does not count. "-" for tier-0 turns,
         where the model never chose.

Results are grouped by the router tier of the scored turn (tier 0 =
router decided, tier 1 = model was hinted, tier 2 = model alone). To
measure the model on its own, run the agent with router_tier0: false
and router_hints: false; the report records which way it was run.

Cases are YAML (PyYAML is already an agent dependency) or JSON; see
tools/eval_cases.yml for the format.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import math
import pathlib
import re
import statistics
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Callable

# Collections the harness snapshots before a case and diffs after it.
# value = (GET path, key in the response, DELETE path template or None).
STATE = {
    "alarms": ("/alarms", "alarms", "/alarms/{id}"),
    "monitors": ("/monitors", "monitors", "/monitors/{id}"),
    "tasks": ("/tasks", "tasks", None),          # no delete route
    "reports": ("/reports", "schedules", "/reports/{id}"),
}

_EXPECT_KEYS = {"tool", "args", "no_tool", "state", "reply_contains", "reply_source"}
_TURN_KEYS = {"ask", "camera", "expect"}
_CASE_KEYS = {"id", "ask", "camera", "expect", "turns", "note"}


class CaseError(ValueError):
    """A case file that cannot be run as written."""


# ── cases ──────────────────────────────────────────────────────────────

def load_cases(path: str | pathlib.Path) -> list[dict[str, Any]]:
    """Read and validate a YAML or JSON case file into normalised cases:
    ``{"id", "turns": [{"ask", "camera", "expect"}]}``."""
    p = pathlib.Path(path)
    text = p.read_text(encoding="utf-8")
    if p.suffix.lower() == ".json":
        raw = json.loads(text)
    else:
        import yaml  # an agent dependency; imported here so JSON needs none
        raw = yaml.safe_load(text)
    return normalise_cases(raw)


def normalise_cases(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or not raw:
        raise CaseError("the case file must be a non-empty list of cases")
    cases, seen = [], set()
    for i, c in enumerate(raw):
        if not isinstance(c, dict):
            raise CaseError(f"case #{i + 1} is not a mapping")
        cid = str(c.get("id") or "").strip()
        if not cid:
            raise CaseError(f"case #{i + 1} has no id")
        if cid in seen:
            raise CaseError(f"duplicate case id {cid!r}")
        seen.add(cid)
        unknown = set(c) - _CASE_KEYS
        if unknown:
            raise CaseError(f"{cid}: unknown keys {sorted(unknown)}")
        if ("turns" in c) == ("ask" in c):
            raise CaseError(f"{cid}: give either 'ask' or 'turns', not both or neither")
        turns = c["turns"] if "turns" in c else [
            {k: c[k] for k in ("ask", "camera", "expect") if k in c}]
        if not isinstance(turns, list) or not turns:
            raise CaseError(f"{cid}: 'turns' must be a non-empty list")
        norm = []
        for j, t in enumerate(turns):
            if not isinstance(t, dict) or not str(t.get("ask") or "").strip():
                raise CaseError(f"{cid}: turn {j + 1} needs an 'ask'")
            unknown = set(t) - _TURN_KEYS
            if unknown:
                raise CaseError(f"{cid}: turn {j + 1}: unknown keys {sorted(unknown)}")
            expect = t.get("expect")
            if expect is not None:
                _check_expect(cid, j, expect)
            norm.append({"ask": str(t["ask"]), "camera": t.get("camera"),
                         "expect": expect})
        if not any(t["expect"] for t in norm):
            raise CaseError(f"{cid}: no turn has an 'expect', so nothing is scored")
        cases.append({"id": cid, "turns": norm})
    return cases


def _check_expect(cid: str, j: int, expect: Any) -> None:
    where = f"{cid}: turn {j + 1}: expect"
    if not isinstance(expect, dict) or not expect:
        raise CaseError(f"{where} must be a non-empty mapping")
    unknown = set(expect) - _EXPECT_KEYS
    if unknown:
        raise CaseError(f"{where}: unknown keys {sorted(unknown)}")
    if expect.get("no_tool") and ("tool" in expect or "args" in expect):
        raise CaseError(f"{where}: 'no_tool' cannot be combined with 'tool'/'args'")
    if "args" in expect and "tool" not in expect:
        raise CaseError(f"{where}: 'args' needs a 'tool'")
    for key in ("args", "state"):
        if key in expect and not isinstance(expect[key], dict):
            raise CaseError(f"{where}: '{key}' must be a mapping")
    for coll, want in (expect.get("state") or {}).items():
        if coll not in STATE:
            raise CaseError(f"{where}: state '{coll}' is not one of {sorted(STATE)}")
        if not isinstance(want, dict):
            raise CaseError(f"{where}: state '{coll}' must be a mapping of fields")


def uses_camera_placeholder(cases: list[dict[str, Any]]) -> bool:
    return "{camera}" in json.dumps(cases)


def fill_camera(value: Any, camera: str) -> Any:
    """Replace ``{camera}`` in every string of a case with the real id."""
    if isinstance(value, str):
        return value.replace("{camera}", camera)
    if isinstance(value, list):
        return [fill_camera(v, camera) for v in value]
    if isinstance(value, dict):
        return {k: fill_camera(v, camera) for k, v in value.items()}
    return value


# ── scoring (pure) ─────────────────────────────────────────────────────

_LABEL_STEPS = {"route", "llm", "compose", "reply"}


def tier_of(trace: list[dict[str, Any]]) -> int | None:
    """The router tier from the trace's ``route`` step; None when the turn
    never reached the router (a roster question answers before it)."""
    for step in trace or ():
        if step.get("step") == "route":
            m = re.match(r"tier(\d)", str(step.get("detail") or ""))
            return int(m.group(1)) if m else None
    return None


def tool_steps(trace: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [s for s in trace or () if s.get("step") not in _LABEL_STEPS]


def reply_source(trace: list[dict[str, Any]]) -> str | None:
    for step in reversed(trace or []):
        if step.get("step") == "reply":
            return step.get("detail")
    return None


def _norm(v: Any) -> Any:
    return v.strip().casefold() if isinstance(v, str) else v


def match_value(expected: Any, actual: Any) -> bool:
    """Case-insensitive equality. An expected LIST means any of its values;
    an actual list (camera_ids) matches when it contains the value."""
    if isinstance(expected, list):
        return any(match_value(e, actual) for e in expected)
    if isinstance(actual, list):
        return any(match_value(expected, a) for a in actual)
    if isinstance(expected, bool) or isinstance(actual, bool):
        return expected is actual
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        return float(expected) == float(actual)
    return str(_norm(expected)) == str(_norm(actual)) if actual is not None else False


def match_fields(expected: dict[str, Any], actual: dict[str, Any]) -> list[str]:
    """The fields of ``expected`` that ``actual`` gets wrong (empty = match)."""
    return [f"{k}: wanted {v!r}, got {actual.get(k)!r}"
            for k, v in expected.items() if not match_value(v, actual.get(k))]


def score_turn(expect: dict[str, Any], trace: list[dict[str, Any]], reply: str,
               created: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    """Score one turn. ``created`` holds the items new in each STATE
    collection since the case started. Returns the checks, ``pass`` (the
    agent did the right thing) and ``model`` (the model chose it; None
    when the router decided the turn)."""
    tier = tier_of(trace)
    steps = tool_steps(trace)
    checks: dict[str, dict[str, Any]] = {}
    model_ok = True

    if expect.get("no_tool"):
        ok = not steps
        checks["no_tool"] = {"ok": ok, "got": [s.get("step") for s in steps]}
        model_ok = ok

    if "tool" in expect:
        names = expect["tool"] if isinstance(expect["tool"], list) else [expect["tool"]]
        names = {str(n) for n in names}
        want_args = expect.get("args") or {}
        candidates = [s for s in steps if s.get("step") in names]
        good = [s for s in candidates if not match_fields(want_args, s.get("args") or {})]
        by = sorted({str(s.get("by") or "model") for s in good})
        detail: dict[str, Any] = {"ok": bool(good), "by": by,
                                  "got": [(s.get("step"), s.get("by")) for s in steps]}
        if candidates and not good:
            detail["args"] = match_fields(want_args, candidates[0].get("args") or {})
        checks["tool"] = detail
        model_ok = any((s.get("by") or "model") == "model" for s in good)

    for coll, want in (expect.get("state") or {}).items():
        items = created.get(coll) or []
        hit = any(not match_fields(want, it) for it in items)
        d: dict[str, Any] = {"ok": hit, "new": len(items)}
        if items and not hit:
            d["fields"] = match_fields(want, items[0])
        checks[f"state.{coll}"] = d

    if not expect.get("state") and expect.get("no_tool"):
        # Nothing should have been created by a turn that calls no tool.
        n = sum(len(v) for v in created.values())
        checks["state.unchanged"] = {"ok": n == 0, "new": n}

    if "reply_contains" in expect:
        words = expect["reply_contains"]
        words = words if isinstance(words, list) else [words]
        low = (reply or "").casefold()
        checks["reply_contains"] = {"ok": any(str(w).casefold() in low for w in words)}

    if "reply_source" in expect:
        src = reply_source(trace)
        checks["reply_source"] = {"ok": match_value(expect["reply_source"], src), "got": src}

    passed = all(c["ok"] for c in checks.values())
    return {"tier": tier, "checks": checks, "pass": passed,
            "model": None if tier == 0 else (passed and model_ok)}


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """95% Wilson score interval for k successes in n trials."""
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    den = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return (max(0.0, centre - half), min(1.0, centre + half))


def aggregate(runs: list[dict[str, Any]]) -> dict[str, Any]:
    """Per-case and per-tier pass rates from the raw run records."""
    by_case: dict[str, list[dict[str, Any]]] = {}
    for r in runs:
        by_case.setdefault(r["case"], []).append(r)
    cases = {}
    for cid, rs in by_case.items():
        ok = [r for r in rs if r.get("error") is None]
        k = sum(1 for r in ok if r["pass"])
        modelled = [r for r in ok if r["model"] is not None]
        mk = sum(1 for r in modelled if r["model"])
        tiers = [r["tier"] for r in ok]
        lat = [r["latency_ms"] for r in ok if r.get("latency_ms") is not None]
        cases[cid] = {
            "n": len(ok), "errors": len(rs) - len(ok),
            "pass": k, "pass_ci": wilson(k, len(ok)),
            "model": mk if modelled else None, "model_n": len(modelled),
            "tier": statistics.mode(tiers) if tiers else None,
            "tiers": sorted(set(tiers), key=lambda t: (t is None, t)),
            "latency_ms_p50": statistics.median(lat) if lat else None,
        }
    tiers: dict[str, dict[str, Any]] = {}
    for r in runs:
        if r.get("error") is not None:
            continue
        key = "none" if r["tier"] is None else f"tier{r['tier']}"
        t = tiers.setdefault(key, {"n": 0, "pass": 0, "model": 0, "model_n": 0})
        t["n"] += 1
        t["pass"] += int(bool(r["pass"]))
        if r["model"] is not None:
            t["model_n"] += 1
            t["model"] += int(bool(r["model"]))
    for t in tiers.values():
        t["pass_ci"] = wilson(t["pass"], t["n"])
    return {"cases": cases, "tiers": dict(sorted(tiers.items()))}


# ── talking to the agent ───────────────────────────────────────────────

Requester = Callable[[str, str, Any], tuple[int, Any]]


def http_requester(base: str, token: str | None = None,
                   timeout: float = 300.0) -> Requester:
    base = base.rstrip("/")

    def request(method: str, path: str, body: Any = None) -> tuple[int, Any]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(base + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                status = r.status
        except urllib.error.HTTPError as exc:
            raw, status = exc.read(), exc.code
        try:
            return status, json.loads(raw.decode() or "null")
        except ValueError:
            return status, None
    return request


def snapshot(request: Requester) -> dict[str, dict[Any, dict[str, Any]]]:
    out = {}
    for coll, (path, key, _delete) in STATE.items():
        status, body = request("GET", path, None)
        items = (body or {}).get(key) if status == 200 and isinstance(body, dict) else None
        out[coll] = {it.get("id"): it for it in (items or []) if isinstance(it, dict)}
    return out


def diff_created(before: dict[str, dict], after: dict[str, dict]) -> dict[str, list[dict]]:
    return {coll: [it for i, it in after.get(coll, {}).items()
                   if i not in before.get(coll, {})]
            for coll in STATE}


def cleanup(request: Requester, created: dict[str, list[dict]]) -> list[str]:
    """Delete what a case created; return what could not be deleted."""
    left = []
    for coll, items in created.items():
        template = STATE[coll][2]
        for it in items:
            if template is None:
                left.append(f"{coll}#{it.get('id')}")
                continue
            status, _ = request("DELETE", template.format(id=it.get("id")), None)
            if status >= 400:
                left.append(f"{coll}#{it.get('id')}")
    return left


def run_case(request: Requester, case: dict[str, Any]) -> dict[str, Any]:
    """One repeat of one case. Never raises: a failure is recorded."""
    record: dict[str, Any] = {"case": case["id"], "turns": [], "error": None,
                              "leftovers": []}
    created_all: dict[str, list[dict]] = {c: [] for c in STATE}
    try:
        status, body = request("POST", "/reset", None)
        if status >= 400:
            raise RuntimeError(f"/reset answered {status}")
        before = snapshot(request)
        scored = []
        total_ms = 0
        for turn in case["turns"]:
            body_in: dict[str, Any] = {"text": turn["ask"]}
            if turn.get("camera"):
                body_in["camera"] = turn["camera"]
            t0 = time.perf_counter()
            status, resp = request("POST", "/ask", body_in)
            wall = int((time.perf_counter() - t0) * 1000)
            if status >= 400 or not isinstance(resp, dict):
                err = (resp or {}).get("error") if isinstance(resp, dict) else None
                raise RuntimeError(f"/ask answered {status}: {err or resp!r}")
            trace = resp.get("trace") or []
            reply = str(resp.get("reply") or "")
            after = snapshot(request)
            created = diff_created(before, after)
            for coll, items in created.items():
                created_all[coll].extend(items)
            before = after
            total_ms += int(resp.get("latency_ms") or wall)
            t_rec: dict[str, Any] = {"ask": turn["ask"], "reply": reply, "trace": trace,
                                     "latency_ms": resp.get("latency_ms"), "wall_ms": wall}
            if turn.get("expect"):
                t_rec["score"] = score_turn(turn["expect"], trace, reply, created)
                scored.append(t_rec["score"])
            record["turns"].append(t_rec)
        last = scored[-1]
        record.update({
            "pass": all(s["pass"] for s in scored),
            "model": (None if any(s["model"] is None for s in scored)
                      else all(s["model"] for s in scored)),
            "tier": last["tier"], "latency_ms": total_ms,
        })
    except Exception as exc:  # noqa: BLE001 — one bad case must not end the run
        record["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        try:
            record["leftovers"] = cleanup(request, created_all)
        except Exception as exc:  # noqa: BLE001
            record["leftovers"] = [f"cleanup failed: {exc}"]
    return record


def run(request: Requester, cases: list[dict[str, Any]], repeat: int,
        log: Callable[[str], None] = print) -> list[dict[str, Any]]:
    runs = []
    for case in cases:
        for i in range(repeat):
            r = run_case(request, case)
            runs.append(r)
            mark = ("ERROR " + r["error"]) if r["error"] else (
                ("pass" if r["pass"] else "FAIL")
                + f"  model={'-' if r['model'] is None else ('yes' if r['model'] else 'no')}"
                + f"  tier={r['tier']}  {r['latency_ms']}ms")
            log(f"  {case['id']} [{i + 1}/{repeat}] {mark}")
            if r["leftovers"]:
                log(f"    left behind (remove by hand): {', '.join(r['leftovers'])}")
    return runs


# ── report ─────────────────────────────────────────────────────────────

def _rate(k: int | None, n: int, ci: tuple[float, float] | None = None) -> str:
    if k is None or n == 0:
        return "-"
    s = f"{k}/{n}"
    if ci is not None:
        s += f" [{ci[0] * 100:.0f}-{ci[1] * 100:.0f}%]"
    return s


def format_report(summary: dict[str, Any], meta: dict[str, Any]) -> str:
    lines = [f"model {meta.get('llm_model')}  temperature {meta.get('llm_temperature')}"
             f"  router {meta.get('router')}  repeat {meta.get('repeat')}", ""]
    w = max([len(c) for c in summary["cases"]] + [4])
    lines.append(f"{'case':<{w}}  tier  {'pass [95% CI]':<17}  {'model':<6}  p50 ms")
    for cid, c in summary["cases"].items():
        tier = "-" if c["tier"] is None else str(c["tier"])
        if len(c["tiers"]) > 1:
            tier += "*"
        lat = "-" if c["latency_ms_p50"] is None else f"{c['latency_ms_p50']:.0f}"
        err = f"  ({c['errors']} errored)" if c["errors"] else ""
        lines.append(f"{cid:<{w}}  {tier:<4}  {_rate(c['pass'], c['n'], c['pass_ci']):<17}"
                     f"  {_rate(c['model'], c['model_n']):<6}  {lat}{err}")
    lines.append("")
    lines.append("by tier (0 = router decided, 1 = model hinted, 2 = model alone):")
    for key, t in summary["tiers"].items():
        lines.append(f"  {key:<5}  pass {_rate(t['pass'], t['n'], t['pass_ci'])}"
                     f"  model {_rate(t['model'], t['model_n'])}")
    if any(len(c["tiers"]) > 1 for c in summary["cases"].values()):
        lines.append("  * the router put this case's repeats in different tiers")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    here = pathlib.Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(
        description="Live-eval harness for the camera-agent (see the module docstring).")
    ap.add_argument("--url", default="http://localhost:9100")
    ap.add_argument("--cases", default=str(here / "eval_cases.yml"))
    ap.add_argument("--camera", help="camera id substituted for {camera} in the cases")
    ap.add_argument("--repeat", type=int, default=5)
    ap.add_argument("--only", action="append", default=[],
                    help="run only this case id (repeatable)")
    ap.add_argument("--token", help="bearer token, when the agent runs auth_mode: opennvr")
    ap.add_argument("--timeout", type=float, default=300.0, help="seconds per request")
    ap.add_argument("--out", help="write the full run (meta, raw turns, summary) as JSON")
    ap.add_argument("--throwaway", action="store_true",
                    help="confirm the agent is a throwaway/demo instance (required)")
    args = ap.parse_args(argv)

    if not args.throwaway:
        print("Refusing to run without --throwaway. The cases arm real alarms and\n"
              "monitors, queue background tasks and clear the agent's chat history;\n"
              "run this only against a demo or throwaway agent.", file=sys.stderr)
        return 2
    if args.repeat < 1:
        ap.error("--repeat must be at least 1")

    try:
        cases = load_cases(args.cases)
    except (OSError, ValueError) as exc:
        print(f"cases: {exc}", file=sys.stderr)
        return 2
    if args.only:
        cases = [c for c in cases if c["id"] in set(args.only)]
        if not cases:
            print(f"no case matches --only {args.only}", file=sys.stderr)
            return 2
    if uses_camera_placeholder(cases):
        if not args.camera:
            print("these cases use {camera}; pass --camera <id>", file=sys.stderr)
            return 2
        cases = fill_camera(cases, args.camera)

    request = http_requester(args.url, args.token, args.timeout)
    status, health = request("GET", "/health", None)
    if status != 200 or not isinstance(health, dict):
        print(f"{args.url}/health answered {status}; is the agent up?", file=sys.stderr)
        return 2
    meta = {
        "url": args.url, "started": datetime.datetime.now().astimezone().isoformat(),
        "llm_model": health.get("llm_model"),
        "llm_temperature": health.get("llm_temperature"),
        "llm_max_tokens": health.get("llm_max_tokens"),
        # None on an agent that predates the /health router field: the run
        # cannot then say whether it measured the model alone.
        "router": health.get("router"),
        "tools": health.get("tools"),
        "repeat": args.repeat, "camera": args.camera,
        "cases_file": str(args.cases),
        "cases_sha256": hashlib.sha256(
            pathlib.Path(args.cases).read_bytes()).hexdigest(),
    }
    print(f"{len(cases)} case(s) x {args.repeat} against {args.url} "
          f"({meta['llm_model']}, router {meta['router']})")
    runs = run(request, cases, args.repeat)
    summary = aggregate(runs)
    print()
    print(format_report(summary, meta))
    if args.out:
        pathlib.Path(args.out).write_text(
            json.dumps({"meta": meta, "summary": summary, "runs": runs}, indent=2),
            encoding="utf-8")
        print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
