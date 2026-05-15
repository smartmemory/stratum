"""Allow `python -m stratum.judge.postmortem ...`."""

from stratum.judge.postmortem.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
