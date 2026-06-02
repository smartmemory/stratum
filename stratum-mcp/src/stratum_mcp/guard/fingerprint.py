"""Guard policy checksum (S2).

A guard's policy tuple ``(graph, edge_predicates, terminal, stakes)`` is hashed
with the same canonical-JSON + SHA-256 *technique* used by
``executor.compute_spec_checksum`` — but over an arbitrary policy dict, not an
``IRFlowDef``. Reusing ``canonical_json`` (sorted keys) makes the digest stable
across key ordering, so re-registering the *same* policy yields the same checksum
while any weakening (drop a predicate, relax an edge) changes it and is rejected.
"""

from __future__ import annotations

import hashlib
from typing import Any

from ..result_cache import canonical_json


def guard_checksum(
    graph: dict[str, list[str]],
    edge_predicates: dict[str, list[dict[str, Any]]],
    terminal: list[str],
    stakes: dict[str, str],
) -> str:
    """Return a hex SHA-256 over the canonicalized policy tuple.

    ``canonical_json`` sorts keys and uses compact separators, so two callers that
    pass semantically equal policies (regardless of dict/list insertion order for
    *mapping* keys) produce the same checksum. List order IS significant inside a
    predicate list / edge target list — that is intended: reordering predicates can
    change evaluation and should re-fingerprint.
    """
    policy = {
        "graph": {k: list(v) for k, v in graph.items()},
        "edge_predicates": edge_predicates,
        "terminal": sorted(terminal),
        "stakes": stakes,
    }
    canonical = canonical_json(policy)
    if canonical is None:  # non-serializable policy — refuse rather than hash junk
        raise ValueError("guard policy is not JSON-serializable")
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
