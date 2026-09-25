import { modelIdentity } from "./base.js";
import type { SandboxPolicy } from "../config/types.js";
import type { ThreadStartParams } from "./codex-appserver-protocol/v2/ThreadStartParams.js";
import type { TurnStartParams } from "./codex-appserver-protocol/v2/TurnStartParams.js";

export interface AppServerPolicy {
  thread: Pick<ThreadStartParams, "model" | "cwd" | "approvalPolicy">;
  turn: Pick<TurnStartParams, "effort" | "sandboxPolicy">;
}

/** Encoding only: full-access authorization remains at the dispatch boundary. */
export function encodeCodexPolicy(modelId: string, cwd: string, policy: SandboxPolicy, target: "exec"): string[];
export function encodeCodexPolicy(modelId: string, cwd: string, policy: SandboxPolicy, target: "app-server"): AppServerPolicy;
export function encodeCodexPolicy(
  modelId: string, cwd: string, policy: SandboxPolicy, target: "exec" | "app-server",
): string[] | AppServerPolicy {
  const { model, effort } = modelIdentity(modelId);
  if (target === "exec") {
    const args = [
      "exec", "--json", "--skip-git-repo-check", "--sandbox", policy.filesystemMode,
      "-c", `sandbox_workspace_write.network_access=${policy.networkAccess}`,
      "-c", `sandbox_workspace_write.writable_roots=${JSON.stringify([...policy.writableRoots])}`,
      "-c", `approval_policy=${JSON.stringify(policy.approvalPolicy)}`,
      "-m", model, "-C", cwd,
    ];
    if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
    args.push("-");
    return args;
  }
  if (policy.approvalPolicy === "on-failure") {
    throw new Error('Codex app-server does not support approval policy "on-failure"');
  }
  const sandboxPolicy: NonNullable<TurnStartParams["sandboxPolicy"]> =
    policy.filesystemMode === "read-only" ? { type: "readOnly", networkAccess: false } :
    policy.filesystemMode === "danger-full-access" ? { type: "dangerFullAccess" } : {
      type: "workspaceWrite", writableRoots: [...policy.writableRoots], networkAccess: policy.networkAccess,
      // Proposed exec defaults; live sandbox parity is a later slice's gate.
      excludeTmpdirEnvVar: false, excludeSlashTmp: false,
    };
  return {
    thread: { model, cwd, approvalPolicy: policy.approvalPolicy },
    turn: { sandboxPolicy, ...(effort ? { effort } : {}) },
  };
}
