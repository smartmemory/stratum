import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/guard/canonical.js";
import { GUARD_ERROR_TYPES, GuardError, guardErrorEnvelope } from "../../src/guard/errors.js";

describe("guard canonical JSON Python golden parity", () => {
  it("matches the captured Python bytes for recursive sorting, Unicode, ints, and arrays", () => {
    const payload = {
      z: { "δ": "café", a: "汉字😀" },
      a: [{ beta: 2, alpha: 1 }, 0, -17],
      emoji: "😀",
      bmp: "\ue000",
      unicode_keys: { "😀": "astral", "\ue000": "bmp" },
    };

    expect(canonicalJson(payload)).toBe(
      '{"a":[{"alpha":1,"beta":2},0,-17],"bmp":"\\ue000","emoji":"\\ud83d\\ude00","unicode_keys":{"\\ue000":"bmp","\\ud83d\\ude00":"astral"},"z":{"a":"\\u6c49\\u5b57\\ud83d\\ude00","\\u03b4":"caf\\u00e9"}}',
    );
  });

  it("matches Python control-character bytes", () => {
    const payload = { controls: `line\n tab\t raw${String.fromCharCode(1)}${String.fromCharCode(0x7f)}`, z: 0, negative: -9 };

    expect(canonicalJson(payload)).toBe(
      '{"controls":"line\\n tab\\t raw\\u0001\\u007f","negative":-9,"z":0}',
    );
  });

  it("matches the captured Python guard_checksum policy input bytes", () => {
    const policy = {
      stakes: { review: "paranoid", draft: "cheap" },
      terminal: ["done", "abandoned"],
      edge_predicates: {
        "review->done": [{ type: "judged", statement: "looks good" }],
        "draft->review": [{ type: "deterministic", evidence: 'server_file_exists("docs/report.md")' }],
      },
      graph: { review: ["done"], draft: ["review"] },
    };

    expect(canonicalJson(policy)).toBe(
      '{"edge_predicates":{"draft->review":[{"evidence":"server_file_exists(\\\"docs/report.md\\\")","type":"deterministic"}],"review->done":[{"statement":"looks good","type":"judged"}]},"graph":{"draft":["review"],"review":["done"]},"stakes":{"draft":"cheap","review":"paranoid"},"terminal":["done","abandoned"]}',
    );
  });

  it("rejects floats and every other unsupported JSON-like value before hashing", () => {
    expect(() => canonicalJson({ value: 1.5 })).toThrow(/safe integer/);
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(/safe integer/);
    expect(() => canonicalJson({ value: Number.POSITIVE_INFINITY })).toThrow(/safe integer/);
    expect(() => canonicalJson({ value: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson({ value: () => undefined })).toThrow(/function/);
    expect(() => canonicalJson({ value: 1n })).toThrow(/bigint/);
  });

  it("rejects sparse arrays, cyclic values, and unsafe integers", () => {
    const sparse = [1, , 3];
    const prototypeIndexed: unknown[] = [];
    prototypeIndexed.length = 1;
    Object.setPrototypeOf(prototypeIndexed, { 0: 42 });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(() => canonicalJson(sparse)).toThrow(/sparse arrays/);
    expect(() => canonicalJson(prototypeIndexed)).toThrow(/sparse arrays/);
    expect(() => canonicalJson(cyclic)).toThrow(/cyclic values/);
    expect(() => canonicalJson(Number.MAX_SAFE_INTEGER + 1)).toThrow(/safe integer/);
  });

  it("encodes negative zero as Python does", () => {
    expect(canonicalJson(-0)).toBe("0");
  });
});

describe("guard error vocabulary", () => {
  it("ports every Python slug plus the TS ownership refusal and emits the canonical envelope", () => {
    expect(GUARD_ERROR_TYPES).toEqual([
      "guard_already_registered",
      "guard_not_found",
      "guard_tampered",
      "illegal_edge",
      "stale_from_state",
      "idempotency_conflict",
      "ledger_corrupt",
      "invalid_state_name",
      "invalid_workspace_root",
      "command_execution_disabled",
      "paranoid_edge_needs_trusted_evidence",
      "evidence_parse_error",
      "override_unavailable",
      "resource_id_mismatch",
      "guard_engine_owned",
    ]);
    expect(guardErrorEnvelope("guard_not_found", "missing")).toEqual({
      status: "error", error_type: "guard_not_found", message: "missing",
    });
    expect(new GuardError("guard_engine_owned", "handoff required").toEnvelope()).toEqual({
      status: "error", error_type: "guard_engine_owned", message: "handoff required",
    });
  });
});
