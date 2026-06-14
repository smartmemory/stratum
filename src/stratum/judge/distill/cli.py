"""STRAT-DISTILL CLI — `distill extract|top|stats`.

Mirrors the postmortem CLI shell (build_parser / _project_dirs / _resolve_out).
"""
from __future__ import annotations

import argparse
from pathlib import Path
from typing import Optional, Sequence

from stratum.judge.distill.detector import detect
from stratum.judge.distill.runner import load_sessions, run_distill

DEFAULT_PROJECT = Path.home() / ".claude/projects/-Users-ruze-reg-my-forge"
DEFAULT_PROJECTS_ROOT = Path.home() / ".claude/projects"
DEFAULT_OUT = Path(".stratum/postmortem/distill_candidates.jsonl")


def _project_dirs(args: argparse.Namespace) -> list[Path]:
    if getattr(args, "all", False):
        root = Path(getattr(args, "projects_root", None) or DEFAULT_PROJECTS_ROOT)
        if not root.exists():
            return []
        return [d for d in sorted(root.iterdir()) if d.is_dir()]
    return [Path(args.project)]


def _resolve_out(out: Path | str) -> Path:
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    return out


def _gather_sessions(args: argparse.Namespace):
    sessions = []
    for d in _project_dirs(args):
        sessions.extend(load_sessions(d, window_days=args.window_days))
    return sessions


def cmd_extract(args: argparse.Namespace) -> int:
    out = _resolve_out(args.out)
    total = 0
    evaluated = 0
    for d in _project_dirs(args):
        res = run_distill(
            d,
            out_path=out,
            min_count=args.min_count,
            window_days=args.window_days,
            project=d.name,
        )
        total += res["written"]
        evaluated += res["evaluated"]
    if total:
        print(f"distill: {total} candidate(s) staged → {out}")
    else:
        print(f"distill: nothing to distill — no repeated workflow worth packaging (evaluated {evaluated})")
    return 0


def cmd_top(args: argparse.Namespace) -> int:
    workflows = detect(_gather_sessions(args), min_count=args.min_count)
    if not workflows:
        print("distill: nothing repeated above the bar")
        return 0
    for wf in workflows[: args.n]:
        print(f"{wf.count:4d}  {wf.kind:8s}  {wf.signature}")
    return 0


def cmd_stats(args: argparse.Namespace) -> int:
    sessions = _gather_sessions(args)
    workflows = detect(sessions, min_count=args.min_count)
    singles = sum(1 for w in workflows if w.kind == "single")
    seqs = sum(1 for w in workflows if w.kind == "sequence")
    print(
        f"distill: {len(sessions)} session(s), {len(workflows)} candidate(s) "
        f"({singles} single, {seqs} sequence)"
    )
    return 0


def _add_common(sp: argparse.ArgumentParser) -> None:
    sp.add_argument("--project", default=str(DEFAULT_PROJECT))
    sp.add_argument("--all", action="store_true", help="walk every project under --projects-root")
    sp.add_argument("--projects-root", default=str(DEFAULT_PROJECTS_ROOT), dest="projects_root")
    sp.add_argument("--min-count", type=int, default=2, dest="min_count")
    sp.add_argument("--window-days", type=int, default=30, dest="window_days")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="distill",
        description="STRAT-DISTILL: mine repeated workflows into staged asset candidates.",
    )
    sub = p.add_subparsers(dest="command", required=True)

    e = sub.add_parser("extract", help="detect + synthesize + write staged candidates to the sidecar")
    _add_common(e)
    e.add_argument("--out", default=str(DEFAULT_OUT))
    e.set_defaults(func=cmd_extract)

    t = sub.add_parser("top", help="print the top repeated workflows (no write)")
    _add_common(t)
    t.add_argument("--n", type=int, default=50)
    t.set_defaults(func=cmd_top)

    s = sub.add_parser("stats", help="summarize repeated-workflow counts (no write)")
    _add_common(s)
    s.set_defaults(func=cmd_stats)

    return p


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
