export type PredicateStakes = "cheap" | "default" | "paranoid";

export interface Source {
  record_id: string;
  memory_type: string;
  version: number;
  content_hash: string;
  chain_hash: string;
  workspace_id: string;
  decision_type?: string;
  domain?: string;
}

export type RuleBind =
  | { kind: "ensure"; step_selector?: string }
  | { kind: "guard_edge"; resource_selector?: string; edge?: string };

export type RulePredicate =
  | { judged: { statement: string; stakes: PredicateStakes } }
  | { expr: string }
  | { file_exists: string }
  | { file_contains: { path: string; text: string } };

export interface Rule {
  rule_id: string;
  source: Source;
  bind: RuleBind;
  predicate: RulePredicate;
  on_fail: "refuse" | "gate";
}

export interface PolicyBundle {
  bundle_id: string;
  workspace_id: string;
  compiled_at: string;
  selector: {
    workflow?: string;
    domain?: string;
    status: "active"[];
  };
  rules: Rule[];
}

export interface RuleVerdict {
  rule_id: string;
  source: Source;
  met: boolean;
  predicate_type: "deterministic" | "verified" | "judged";
  evidence_digest?: string;
}

export interface EnforcementEvent {
  event_id: string;
  kind: "guard_transition" | "gate_resolution" | "flow_terminal";
  run_id: string;
  bundle_id: string;
  runner: "local" | "hosted";
  occurred_at: string;
  resource_id?: string;
  from_state?: string;
  to_state?: string;
  outcome: string;
  resolved_by: "agent" | "human";
  resolved_by_user_id?: string;
  rationale?: string;
  ledger_ref?: string;
  entry_digest?: string;
  prev_digest?: string;
  payload_digest?: string;
  rules_evaluated: RuleVerdict[];
}

export interface PolicyRuleBinding {
  ensure_index: number;
  rule_id: string;
  source: Source;
  /** Glob (or conjunction of globs) that actually selected this bound step. */
  step_selector: string;
  /** Requested failure routing; P1 records gate intent but enforces it as refuse. */
  on_fail: "refuse" | "gate";
}

export type PolicyRuleMap = Record<string, PolicyRuleBinding[]>;
