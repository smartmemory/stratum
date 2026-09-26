export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/** Values accepted by @openai/codex-sdk ThreadOptions.approvalPolicy. */
export type CodexApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";

export interface SandboxPolicy {
  readonly filesystemMode: CodexSandboxMode;
  readonly networkAccess: boolean;
  readonly writableRoots: readonly string[];
  readonly approvalPolicy: CodexApprovalPolicy;
}

export type SandboxPolicyKey = keyof SandboxPolicy;
/**
 * "enforced" (STRAT-AGENT-DEVIN-1 D11): the value is a fact of the agent's
 * runtime that no config layer can change — e.g. devin's networkAccess is
 * always true and its approvalPolicy always "never" under
 * --permission-mode dangerous.
 */
export type ConfigLayer = "default" | "user" | "project" | "dispatch" | "env" | "enforced";

export interface ConfigProvenance {
  readonly layer: ConfigLayer;
  /** Human-readable origin: a path, dispatch surface, env var, or defaults. */
  readonly source: string;
}

/** Serializable evidence attached only when a run exceeds the safe defaults. */
export interface SandboxPolicyAudit {
  readonly policy: SandboxPolicy;
  readonly provenance: Readonly<Record<SandboxPolicyKey, ConfigProvenance>>;
  /** The separate fail-closed authorization required when policy selects full access. */
  readonly fullAccessAuthorization?: ConfigProvenance;
}
