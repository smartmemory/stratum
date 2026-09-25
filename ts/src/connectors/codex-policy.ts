import { modelIdentity } from "./base.js";
import type { SandboxPolicy } from "../config/types.js";
import type { ThreadStartParams } from "./codex-appserver-protocol/v2/ThreadStartParams.js";
import type { TurnStartParams } from "./codex-appserver-protocol/v2/TurnStartParams.js";

export interface AppServerPolicy {
  thread: Pick<ThreadStartParams, "model" | "cwd" | "approvalPolicy" | "sandbox" | "config">;
  turn: Pick<TurnStartParams, "effort">;
}

/** Encoding only: full-access authorization remains at the dispatch boundary. */
export function encodeCodexPolicy(modelId: string, cwd: string, policy: SandboxPolicy, target: "exec"): string[];
export function encodeCodexPolicy(modelId: string, cwd: string, policy: SandboxPolicy, target: "app-server"): AppServerPolicy;
export function encodeCodexPolicy(
  modelId: string, cwd: string, policy: SandboxPolicy, target: "exec" | "app-server",
): string[] | AppServerPolicy {
  const { model, effort } = modelIdentity(modelId);
  // One source for exec overrides and thread config. Omit temp exclusions so
  // both transports inherit the user's ambient values.
  const workspaceConfig = {
    "sandbox_workspace_write.network_access": policy.networkAccess,
    "sandbox_workspace_write.writable_roots": [...policy.writableRoots],
  } satisfies NonNullable<ThreadStartParams["config"]>;
  if (target === "exec") {
    const args = [
      "exec", "--json", "--skip-git-repo-check", "--sandbox", policy.filesystemMode,
      ...Object.entries(workspaceConfig).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]),
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
  return {
    thread: {
      model, cwd, approvalPolicy: policy.approvalPolicy, sandbox: policy.filesystemMode,
      ...(policy.filesystemMode === "workspace-write" ? { config: workspaceConfig } : {}),
    },
    turn: effort ? { effort } : {},
  };
}
