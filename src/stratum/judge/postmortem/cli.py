"""postmortem CLI: extract / sample / stats / inspect.

Usage:
    python -m stratum.judge.postmortem extract [--project DIR] [--out PATH]
    python -m stratum.judge.postmortem sample --n 20 [--label LABEL] [--in PATH]
    python -m stratum.judge.postmortem stats [--in PATH]
    python -m stratum.judge.postmortem inspect CANDIDATE_ID [--in PATH]

`--project` defaults to ~/.claude/projects/-Users-ruze-reg-my-forge
`--out` / `--in` default to .stratum/postmortem/candidates.jsonl in the project root
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import random
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

from stratum.judge.postmortem.loader import iter_sessions
from stratum.judge.postmortem.segmenter import Candidate, segment
from stratum.judge.postmortem.signals import CandidateLabel, label_candidate

DEFAULT_PROJECT = Path.home() / ".claude/projects/-Users-ruze-reg-my-forge"
DEFAULT_PROJECTS_ROOT = Path.home() / ".claude/projects"
DEFAULT_OUT = Path(".stratum/postmortem/candidates.jsonl")

SCHEMA_VERSION = "1.0"


def _event_to_dict(ev) -> dict[str, Any]:
    d = dataclasses.asdict(ev)
    # tool_input may be large; truncate for storage sanity
    if d.get("tool_input") is not None:
        try:
            s = json.dumps(d["tool_input"])
            if len(s) > 2000:
                d["tool_input"] = json.loads(s[:2000] + "\"...\"}")
        except Exception:
            d["tool_input"] = {"_truncated": True}
    if isinstance(d.get("text"), str) and len(d["text"]) > 4000:
        d["text"] = d["text"][:4000] + "…[truncated]"
    return d


def _candidate_to_dict(c: Candidate, lab: CandidateLabel, project: str = "") -> dict[str, Any]:
    return {
        "_schema_version": SCHEMA_VERSION,
        "candidate_id": c.candidate_id,
        "session_id": c.session_id,
        "project": project,
        "request_text": c.request_text,
        "request_line": c.request_line,
        "claim_kind": c.claim_kind,
        "claim_line": c.claim_marker.line_no,
        "claim_text": (c.claim_marker.text or "")[:1000],
        "work_span_size": len(c.work_span),
        "work_tool_uses": [
            {"name": ev.tool_name, "line": ev.line_no}
            for ev in c.work_span if ev.kind == "tool_use" and ev.tool_name
        ][:50],
        "post_claim_events": [_event_to_dict(ev) for ev in c.post_claim_events],
        "label": lab.label,
        "label_confidence": lab.confidence,
        "label_rationale": lab.rationale,
        "signal_hits": [dataclasses.asdict(h) for h in lab.hits],
    }


def _resolve_out(out: Path) -> Path:
    out = Path(out)
    if not out.is_absolute():
        # Default location is the project root .stratum/postmortem dir
        out = Path.cwd() / out
    out.parent.mkdir(parents=True, exist_ok=True)
    return out


def _project_dirs(args: argparse.Namespace) -> list[Path]:
    """Return the list of project directories to scan.

    `--all` walks every direct child of ~/.claude/projects (or --projects-root).
    Otherwise honour --project (single dir) or --projects (repeated dirs).
    """
    if args.all:
        root = Path(args.projects_root)
        return [p for p in sorted(root.iterdir()) if p.is_dir()]
    if args.projects:
        return [Path(p) for p in args.projects]
    return [Path(args.project)]


def cmd_extract(args: argparse.Namespace) -> int:
    project_dirs = _project_dirs(args)
    out_path = _resolve_out(args.out)
    total = 0
    sessions_seen = 0
    per_project: dict[str, int] = {}
    empties = 0
    with out_path.open("w", encoding="utf-8") as fh:
        for pdir in project_dirs:
            if not pdir.exists() or not pdir.is_dir():
                continue
            project_name = pdir.name
            project_count = 0
            for sess in iter_sessions(pdir):
                sessions_seen += 1
                cands = segment(sess)
                if not cands:
                    empties += 1
                for c in cands:
                    lab = label_candidate(c)
                    fh.write(
                        json.dumps(
                            _candidate_to_dict(c, lab, project=project_name),
                            ensure_ascii=False,
                        )
                        + "\n"
                    )
                    total += 1
                    project_count += 1
            per_project[project_name] = project_count
    print(f"extracted {total} candidates from {sessions_seen} sessions across {len(per_project)} projects")
    print(f"  per-session avg: {total / max(sessions_seen, 1):.2f}")
    print(f"  sessions with 0 candidates: {empties}")
    print(f"  written to: {out_path}")
    top = sorted(per_project.items(), key=lambda x: -x[1])[:10]
    if top and top[0][1] > 0:
        print("top projects by candidate count:")
        for name, n in top:
            if n == 0:
                break
            print(f"  {n:4d}  {name}")
    return 0


def _read_candidates(in_path: Path) -> Iterable[dict[str, Any]]:
    with in_path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def _print_candidate(rec: dict[str, Any], full: bool = False) -> None:
    print(f"--- {rec['candidate_id']} ---")
    print(f"label: {rec['label']} (conf {rec['label_confidence']:.2f}) — {rec['label_rationale']}")
    print(f"claim_kind: {rec['claim_kind']}  work_span: {rec['work_span_size']} events")
    print(f"request: {rec['request_text'][:300]}")
    print(f"claim  : {rec['claim_text'][:300]}")
    if rec.get("signal_hits"):
        print("signals:")
        for h in rec["signal_hits"]:
            print(f"  - {h['kind']} ({h['polarity']}, conf {h['confidence']:.2f}) L{h['line_no']}: {h['snippet']}")
    if full and rec.get("post_claim_events"):
        print("post-claim window:")
        for ev in rec["post_claim_events"][:10]:
            kind = ev["kind"]
            preview = (ev.get("text") or "")[:200]
            extra = f" [{ev.get('tool_name')}]" if ev.get("tool_name") else ""
            print(f"  L{ev['line_no']} {kind}{extra}: {preview}")
    print()


def cmd_sample(args: argparse.Namespace) -> int:
    in_path = _resolve_out(args.input)
    if not in_path.exists():
        print(f"no candidates file at {in_path}; run `extract` first", file=sys.stderr)
        return 2
    records = list(_read_candidates(in_path))
    if args.label:
        records = [r for r in records if r.get("label") == args.label]
    if not records:
        print("no matching candidates", file=sys.stderr)
        return 1
    n = min(args.n, len(records))
    random.seed(args.seed)
    sample = random.sample(records, n)
    for r in sample:
        _print_candidate(r, full=args.full)
    return 0


def cmd_stats(args: argparse.Namespace) -> int:
    in_path = _resolve_out(args.input)
    if not in_path.exists():
        print(f"no candidates file at {in_path}; run `extract` first", file=sys.stderr)
        return 2
    label_counts: Counter[str] = Counter()
    claim_counts: Counter[str] = Counter()
    signal_counts: Counter[str] = Counter()
    project_counts: Counter[str] = Counter()
    sessions: set[str] = set()
    total = 0
    for r in _read_candidates(in_path):
        total += 1
        label_counts[r["label"]] += 1
        claim_counts[r["claim_kind"]] += 1
        project_counts[r.get("project") or "(unknown)"] += 1
        sessions.add(r["session_id"])
        for h in r.get("signal_hits", []):
            signal_counts[h["kind"]] += 1
    print(f"candidates: {total} across {len(sessions)} sessions, {len(project_counts)} projects")
    print("labels:")
    for k, v in label_counts.most_common():
        pct = 100 * v / total if total else 0
        print(f"  {k:12s} {v:5d}  ({pct:.1f}%)")
    print("claim kinds:")
    for k, v in claim_counts.most_common():
        print(f"  {k:12s} {v:5d}")
    print("signal hits (across all candidates):")
    for k, v in signal_counts.most_common():
        print(f"  {k:20s} {v:5d}")
    print("top projects:")
    for k, v in project_counts.most_common(10):
        print(f"  {k:60s} {v:5d}")
    return 0


def cmd_inspect(args: argparse.Namespace) -> int:
    in_path = _resolve_out(args.input)
    if not in_path.exists():
        print(f"no candidates file at {in_path}; run `extract` first", file=sys.stderr)
        return 2
    for r in _read_candidates(in_path):
        if r["candidate_id"] == args.candidate_id:
            _print_candidate(r, full=True)
            return 0
    print(f"candidate {args.candidate_id} not found", file=sys.stderr)
    return 1


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m stratum.judge.postmortem",
        description="Retroactive judge-stack calibration from Claude Code transcripts.",
    )
    sub = p.add_subparsers(dest="command", required=True)

    pe = sub.add_parser("extract", help="Segment sessions into candidates and write JSONL.")
    pe.add_argument("--project", type=Path, default=DEFAULT_PROJECT,
                    help=f"Single Claude Code project dir (default: {DEFAULT_PROJECT})")
    pe.add_argument("--projects", nargs="*", default=None,
                    help="Explicit list of project dirs (overrides --project)")
    pe.add_argument("--all", action="store_true",
                    help="Scan every project under --projects-root")
    pe.add_argument("--projects-root", type=Path, default=DEFAULT_PROJECTS_ROOT,
                    help=f"Parent of project dirs when --all is used (default: {DEFAULT_PROJECTS_ROOT})")
    pe.add_argument("--out", type=Path, default=DEFAULT_OUT,
                    help=f"Output JSONL (default: {DEFAULT_OUT})")
    pe.set_defaults(func=cmd_extract)

    ps = sub.add_parser("sample", help="Print N random candidates for hand-review.")
    ps.add_argument("--n", type=int, default=20)
    ps.add_argument("--label", choices=["false_met", "true_met", "ambiguous"], default=None)
    ps.add_argument("--seed", type=int, default=0)
    ps.add_argument("--full", action="store_true", help="Include post-claim window")
    ps.add_argument("--input", type=Path, default=DEFAULT_OUT)
    ps.set_defaults(func=cmd_sample)

    pt = sub.add_parser("stats", help="Aggregate counts over the extracted corpus.")
    pt.add_argument("--input", type=Path, default=DEFAULT_OUT)
    pt.set_defaults(func=cmd_stats)

    pi = sub.add_parser("inspect", help="Full dump of one candidate.")
    pi.add_argument("candidate_id")
    pi.add_argument("--input", type=Path, default=DEFAULT_OUT)
    pi.set_defaults(func=cmd_inspect)

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
