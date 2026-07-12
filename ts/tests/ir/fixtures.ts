type Spec = Record<string, unknown>;

const clone = <T>(value: T): T => structuredClone(value);

export const designExample: Spec = {
  version: 1,
  contracts: {
    Review: { verdict: "pass|fail", notes: "string", items: "string[]", hint: "string?" },
    Fixup: { done: "boolean", path: "string" },
  },
  flows: {
    entry: "main",
    main: {
      input: { goal: "string" },
      output: { from: "${wrap.output}", contract: "Review" },
      budget: { usd: 5, dispatches: 20 },
      max_rounds: 3,
      steps: [
        {
          id: "build",
          do: "Implement ${input.goal}. Follow the design at docs/x.md.",
          agent: "codex",
          out: "Review",
          ensure: [
            { expr: "result.verdict == 'pass'" },
            { file_exists: "src/x.ts" },
            { judged: { statement: "No requirement in the design was dropped", stakes: "cheap" } },
          ],
          attempts: 2,
        },
        { id: "check", do: "Verify ${build.output.notes} against tests", out: "Review" },
        {
          id: "approve",
          after: ["check"],
          gate: { on_approve: "fixups", on_revise: "build", on_kill: null, max_rounds: 2 },
        },
        {
          id: "fixups",
          fanout: {
            over: "${check.output.items}",
            steps: [
              { do: "Fix ${item}", out: "Fixup", ensure: [{ expr: "result.done == true" }] },
            ],
            concurrency: 3,
            isolation: "worktree",
            require: "all",
            merge: "sequential",
            pre_merge: ["pnpm vitest run"],
          },
        },
        { id: "wrap", run: "summarize", with: { notes: "${fixups.output}" } },
      ],
    },
    summarize: {
      input: { notes: "array" },
      output: { from: "${digest.output}", contract: "Review" },
      steps: [{ id: "digest", do: "Summarize ${input.notes} as a Review", out: "Review" }],
    },
  },
};

const simple: Spec = {
  version: 1,
  contracts: { Result: { value: "string", tags: "(red|green)[]", note: "string?" } },
  flows: {
    entry: "main",
    main: {
      input: { prompt: "string" },
      output: { from: "${work.output}", contract: "Result" },
      steps: [{ id: "work", do: "Do ${input.prompt}", out: "Result" }],
    },
  },
};

const err = (code: string, path: string) => [{ code, path }];

export const REVIEW_REGRESSIONS = {
  agentNoneOnDoRejected: (() => { const s = clone(simple); (s.flows as any).main.steps[0].agent = "none"; return s; })(),
  nestedTypedArrayAccepted: (() => { const s = clone(simple); (s.contracts as any).Result.grid = "string[][]"; return s; })(),
  protoContractField: (() => { const s = clone(simple); (s.contracts as any).Result = JSON.parse('{"done": "boolean", "__proto__": "string"}'); return s; })(),
  multiUnknownFields: (() => { const s = clone(simple); Object.assign((s.flows as any).main.steps[0], { bogus_a: 1, bogus_b: 2 }); return s; })(),
};

export const validFixtures = [
  { name: "the design example", spec: designExample },
  { name: "a minimal task flow", spec: simple },
  {
    name: "a compute flow", spec: {
      version: 1, contracts: { Value: { result: "integer" } }, flows: {
        entry: "main", main: { input: { count: "integer" }, output: { from: "${calc.output}", contract: "Value" }, steps: [
          { id: "calc", set: { result: "input.count + 1" }, out: "Value" },
        ] },
      },
    },
  },
  {
    name: "an optional nested contract", spec: {
      version: 1, contracts: { Child: { name: "string" }, Parent: { child: "Child?", metadata: "object" } }, flows: {
        entry: "main", main: { input: { value: "string" }, output: { from: "${work.output}", contract: "Parent" }, steps: [
          { id: "work", do: "${input.value}", out: "Parent" },
        ] },
      },
    },
  },
  {
    name: "an indexed fanout output reference",
    spec: (() => { const s = clone(designExample); ((s.flows as any).main.steps[4].with as any).notes = "${fixups.output[0].path}"; return s; })(),
  },
  {
    name: "a one-level subflow gate",
    spec: (() => {
      const s = clone(simple);
      (s.flows as any).main.steps[0] = { id: "work", run: "child", with: { prompt: "${input.prompt}" } };
      (s.flows as any).child = {
        input: { prompt: "string" }, output: { from: "${done.output}", contract: "Result" },
        steps: [
          { id: "done", do: "done ${input.prompt}", out: "Result" },
          { id: "review", after: ["done"], gate: { on_approve: null, on_revise: null, on_kill: null } },
        ],
      };
      return s;
    })(),
  },
];

export const invalidFixtures = [
  {
    name: "unknown step field", spec: (() => { const s = clone(simple); (s.flows as any).main.steps[0].extra = true; return s; })(),
    errors: err("E2_UNKNOWN_FIELD", "flows.main.steps[0].extra"),
  },
  {
    name: "mixed constructs", spec: (() => { const s = clone(simple); (s.flows as any).main.steps[0].set = { value: "1" }; return s; })(),
    errors: err("E2_CONSTRUCT_MIX", "flows.main.steps[0]"),
  },
  {
    name: "invalid agent", spec: (() => { const s = clone(simple); (s.flows as any).main.steps[0].agent = "gpt"; return s; })(),
    errors: err("SCHEMA_INVALID", "flows.main.steps[0].agent"),
  },
  {
    name: "invalid contract type", spec: (() => { const s = clone(simple); (s.contracts as any).Result.value = "date"; return s; })(),
    errors: err("CONTRACT_INVALID_TYPE", "contracts.Result.value"),
  },
  {
    name: "unknown contract reference", spec: (() => { const s = clone(simple); (s.flows as any).main.steps[0].out = "Missing"; return s; })(),
    errors: err("CONTRACT_UNKNOWN_REF", "flows.main.steps[0].out"),
  },
  {
    name: "recursive contract reference", spec: (() => { const s = clone(simple); (s.contracts as any).Result.value = "Other"; (s.contracts as any).Other = { parent: "Result" }; return s; })(),
    errors: err("CONTRACT_RECURSIVE_REF", "contracts.Other.parent"),
  },
  {
    name: "malformed reference", spec: (() => { const s = clone(simple); (s.flows as any).main.steps[0].do = "${input.bad-name}"; return s; })(),
    errors: err("REF_INVALID", "flows.main.steps[0].do"),
  },
  {
    name: "unknown input path", spec: (() => { const s = clone(simple); (s.flows as any).main.steps[0].do = "${input.missing}"; return s; })(),
    errors: err("REF_UNKNOWN_PATH", "flows.main.steps[0].do"),
  },
  {
    name: "unknown source step", spec: (() => { const s = clone(simple); (s.flows as any).main.steps[0].do = "${other.output}"; return s; })(),
    errors: err("REF_UNKNOWN_STEP", "flows.main.steps[0].do"),
  },
  {
    name: "source output missing contract", spec: (() => { const s = clone(simple); (s.flows as any).main.steps.unshift({ id: "seed", do: "seed" }); (s.flows as any).main.steps[1].do = "${seed.output}"; return s; })(),
    errors: err("REF_OUTPUT_CONTRACT_REQUIRED", "flows.main.steps[1].do"),
  },
  {
    name: "unknown source output path", spec: (() => { const s = clone(simple); (s.flows as any).main.steps[0].do = "${work.output.missing}"; return s; })(),
    errors: err("REF_UNKNOWN_PATH", "flows.main.steps[0].do"),
  },
  {
    name: "reference cycle", spec: (() => { const s = clone(simple); (s.flows as any).main.steps = [{ id: "one", do: "${two.output}", out: "Result" }, { id: "two", do: "${one.output}", out: "Result" }]; return s; })(),
    errors: err("ROUTING_CYCLE", "flows.main.steps[1].do"),
  },
  {
    name: "unknown after target", spec: (() => { const s = clone(simple); (s.flows as any).main.steps[0].after = ["missing"]; return s; })(),
    errors: err("ROUTING_UNKNOWN_TARGET", "flows.main.steps[0].after[0]"),
  },
  {
    name: "self after target", spec: (() => { const s = clone(simple); (s.flows as any).main.steps[0].after = ["work"]; return s; })(),
    errors: err("ROUTING_SELF_TARGET", "flows.main.steps[0].after[0]"),
  },
  {
    name: "on-fail cycle", spec: (() => { const s = clone(simple); (s.flows as any).main.steps = [{ id: "one", do: "one", out: "Result", on_fail: "two" }, { id: "two", do: "two", out: "Result", on_fail: "one" }]; return s; })(),
    errors: err("ROUTING_CYCLE", "flows.main.steps[1].on_fail"),
  },
  {
    name: "gate route cycle", spec: (() => { const s = clone(simple); (s.flows as any).main.steps = [{ id: "one", do: "one", out: "Result" }, { id: "gate", after: ["one"], gate: { on_approve: "one", on_revise: null, on_kill: null } }]; return s; })(),
    errors: err("ROUTING_CYCLE", "flows.main.steps[1].gate.on_approve"),
  },
  {
    name: "gate revise requires flow max rounds", spec: (() => { const s = clone(simple); (s.flows as any).main.steps = [{ id: "one", do: "one", out: "Result" }, { id: "gate", after: ["one"], gate: { on_approve: null, on_revise: "one", on_kill: null } }]; return s; })(),
    errors: err("GATE_REVISE_REQUIRES_MAX_ROUNDS", "flows.main.steps[1].gate.on_revise"),
  },
  {
    name: "gate revise must target ancestor", spec: (() => { const s = clone(simple); (s.flows as any).main.max_rounds = 2; (s.flows as any).main.steps = [{ id: "one", do: "one", out: "Result" }, { id: "gate", gate: { on_approve: "one", on_revise: "one", on_kill: null } }]; return s; })(),
    errors: err("GATE_REVISE_NOT_ANCESTOR", "flows.main.steps[1].gate.on_revise"),
  },
  {
    name: "gate revise cannot target itself", spec: (() => { const s = clone(simple); (s.flows as any).main.max_rounds = 2; (s.flows as any).main.steps = [{ id: "gate", gate: { on_approve: null, on_revise: "gate", on_kill: null } }]; return s; })(),
    errors: err("ROUTING_SELF_TARGET", "flows.main.steps[0].gate.on_revise"),
  },
  {
    name: "fanout output requires final out", spec: (() => { const s = clone(simple); (s.flows as any).main.steps = [{ id: "items", do: "items", out: "Result" }, { id: "fan", fanout: { over: "${items.output.tags}", steps: [{ do: "${item}" }], concurrency: 1, isolation: "none", require: "all", merge: "sequential" } }, { id: "use", do: "${fan.output}", out: "Result" }]; return s; })(),
    errors: err("FANOUT_OUTPUT_REQUIRES_FINAL_OUT", "flows.main.steps[1].fanout.steps[0].out"),
  },
  {
    name: "flow output also requires fanout final out", spec: (() => { const s = clone(simple); (s.flows as any).main.output.from = "${fan.output}"; (s.flows as any).main.steps = [{ id: "items", do: "items", out: "Result" }, { id: "fan", fanout: { over: "${items.output.tags}", steps: [{ do: "${item}" }], concurrency: 1, isolation: "none", require: "all", merge: "sequential" } }]; return s; })(),
    errors: err("FANOUT_OUTPUT_REQUIRES_FINAL_OUT", "flows.main.steps[1].fanout.steps[0].out"),
  },
  {
    name: "item reference outside fanout", spec: (() => { const s = clone(simple); (s.flows as any).main.steps[0].do = "${item}"; return s; })(),
    errors: err("REF_INVALID_SCOPE", "flows.main.steps[0].do"),
  },
  {
    name: "prev reference outside fanout", spec: (() => { const s = clone(simple); (s.flows as any).main.steps[0].do = "${prev}"; return s; })(),
    errors: err("REF_INVALID_SCOPE", "flows.main.steps[0].do"),
  },
  {
    name: "missing entry flow", spec: (() => { const s = clone(simple); (s.flows as any).entry = "missing"; return s; })(),
    errors: err("FLOW_UNKNOWN_ENTRY", "flows.entry"),
  },
  {
    name: "unknown subflow", spec: (() => { const s = clone(simple); (s.flows as any).main.steps[0] = { id: "work", run: "missing", with: {} }; return s; })(),
    errors: err("SUBFLOW_UNKNOWN", "flows.main.steps[0].run"),
  },
  {
    name: "subflow with keys mismatch", spec: (() => { const s = clone(designExample); (s.flows as any).main.steps[4].with = { wrong: "${fixups.output}" }; return s; })(),
    errors: err("SUBFLOW_WITH_MISMATCH", "flows.main.steps[4].with"),
  },
  {
    name: "direct recursive subflow", spec: (() => { const s = clone(simple); (s.flows as any).main.steps[0] = { id: "work", run: "main", with: { prompt: "x" } }; return s; })(),
    errors: err("SUBFLOW_RECURSIVE", "flows.main.steps[0].run"),
  },
  {
    name: "transitive recursive subflow", spec: (() => { const s = clone(simple); (s.flows as any).other = { input: { prompt: "string" }, output: { from: "${again.output}", contract: "Result" }, steps: [{ id: "again", run: "main", with: { prompt: "x" } }] }; (s.flows as any).main.steps[0] = { id: "work", run: "other", with: { prompt: "x" } }; return s; })(),
    errors: err("SUBFLOW_RECURSIVE", "flows.other.steps[0].run"),
  },
  ...(["fanout", "run"] as const).map((kind) => ({
    name: `reachable subflow rejects ${kind}`,
    spec: (() => {
      const s = clone(simple);
      (s.flows as any).main.steps[0] = { id: "work", run: "child", with: { prompt: "${input.prompt}" } };
      const forbidden = kind === "fanout"
          ? { id: "bad", fanout: { over: "${input.prompt}", steps: [{ do: "${item}", out: "Result" }], concurrency: 1, isolation: "none", require: "all", merge: "sequential" } }
          : { id: "bad", run: "unused", with: { prompt: "${input.prompt}" } };
      (s.flows as any).child = { input: { prompt: "string" }, output: { from: "${done.output}", contract: "Result" }, steps: [forbidden, { id: "done", do: "done", out: "Result" }] };
      if (kind === "run") (s.flows as any).unused = { input: { prompt: "string" }, output: { from: "${done.output}", contract: "Result" }, steps: [{ id: "done", do: "done", out: "Result" }] };
      return s;
    })(),
    errors: err("SUBFLOW_BODY_RESTRICTED", `flows.child.steps[0].${kind}`),
  })),
  {
    name: "fanout output field access without an index",
    spec: (() => { const s = clone(designExample); ((s.flows as any).main.steps[4].with as any).notes = "${fixups.output.done}"; return s; })(),
    errors: err("REF_UNKNOWN_PATH", "flows.main.steps[4].with.notes"),
  },
  {
    name: "unindexed fanout output as flow output",
    spec: (() => {
      const s = clone(designExample);
      (s.flows as any).main.output = { from: "${fixups.output}", contract: "Fixup" };
      ((s.flows as any).main.steps as any[]).splice(4, 1); // drop wrap so fixups is the sink
      delete (s.flows as any).summarize;
      return s;
    })(),
    errors: err("REF_UNKNOWN_PATH", "flows.main.output.from"),
  },
  {
    name: "empty budget", spec: (() => { const s = clone(simple); (s.flows as any).main.budget = {}; return s; })(),
    errors: err("SCHEMA_INVALID", "flows.main.budget"),
  },
  {
    name: "unrecognized flow field", spec: (() => { const s = clone(simple); (s.flows as any).main.extra = true; return s; })(),
    errors: err("E2_UNKNOWN_FIELD", "flows.main.extra"),
  },
];
