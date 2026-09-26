import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { validateShape } from "../../src/mcp/contracts.js";
import { createToolDispatcher } from "../../src/mcp/server.js";
import { corpus } from "../distill/fixtures.js";

// Literal copies of the step-0 contract, before the S4 description amendment.
const REQUEST = {
  "workspace_root": "string",
  "project_dir?": "string",
  "min_count?": "number",
  "window_days?": "number",
  "write?": "boolean"
};
const RESPONSES = {
  "ok": {
    "candidates": {
      "$array": {
        "clusterId": "string",
        "revisionId": "string",
        "schemaVersion": "string",
        "targetKind": "string",
        "targetPath": "string",
        "scope": {
          "sourceMode": "string",
          "workspaceRoot": "string",
          "transcriptProjectDir": "string",
          "observedCwds": {
            "$array": "string"
          }
        },
        "claim": "string",
        "rendered": {
          "content": "string",
          "templateId": "string",
          "templateVersion": "string",
          "insertion": {
            "mode": "string"
          }
        },
        "evidence": {
          "$array": {
            "id": "string",
            "sourceKind": "string",
            "projectDir": "string",
            "sessionId": "string",
            "transcriptFile": "string",
            "cwd": "string|null",
            "steps": {
              "$array": {
                "toolName": "string",
                "canonicalInput": "string",
                "lineNo": "number",
                "blockIndex": "number",
                "toolUseId": "string|null",
                "cwd": "string|null",
                "lineDigest": "string"
              }
            }
          }
        },
        "recurrence": {
          "records": "number",
          "distinctSessions": "number"
        },
        "authoringInputsDigest": "string",
        "poolSnapshot": {
          "$array": {
            "assetId": "string",
            "contentDigest": "string"
          }
        },
        "assetName": "string",
        "workflow": {
          "$oneOf": [
            {
              "kind": "string",
              "signature": "string",
              "step": {
                "toolName": "string",
                "canonicalInput": "string"
              }
            },
            {
              "kind": "string",
              "signature": "string",
              "tools": {
                "$array": "string"
              }
            }
          ]
        },
        "rationale": "string",
        "confidence": "number",
        "sourceHandle": {
          "projectDir": "string",
          "sessionId": "string",
          "transcriptFile": "string",
          "lineNo": "number",
          "blockIndex": "number"
        },
        "authoring": {
          "detectorVersion": "string",
          "canonicalizerVersion": "string",
          "formSelectorVersion": "string",
          "minCount": "number",
          "minSessions": "number",
          "ngramRange": {
            "$array": "number"
          },
          "selectedBy": "string",
          "poolRead": "boolean"
        }
      }
    },
    "evaluated": "number",
    "written": "number",
    "reason": "string",
    "out_path": "string",
    "workspace_root": "string",
    "project_dirs": {
      "$array": "string"
    },
    "applied": "boolean",
    "diagnostics": {
      "sessions": "number",
      "skippedFiles": "number",
      "droppedLines": "number",
      "droppedEvents": "number",
      "mtimeFailures": "number",
      "malformedRows": "number",
      "unsupportedRows": "number",
      "authoringSkipped": "number"
    }
  },
  "error": {
    "error_type": "string",
    "message": "string"
  }
};
const DESCRIPTION = "Extract recurring workflows from Claude transcripts into immutable distill-2.1 asset drafts for review. Requires an explicit workspace_root; project_dir selects the transcript source. Defaults: window_days=30, min_count=2, write=true. Use write=false to preview. Stages only to .stratum/distill/candidates.jsonl; never applies drafts; applied is always false. Applying, reverting, and reconciling assets are CLI-only operations.";

afterEach(() => vi.unstubAllEnvs());

it("pins surface 24, the sourceMode declaration and the staging-only distill contract", async () => {
  const contract = JSON.parse(await readFile(new URL("../../contracts/mcp-surface.json", import.meta.url), "utf8"));
  const tool = contract.tools.stratum_distill;
  expect(contract.surface).toBe(25);
  expect(tool.description).toBe(DESCRIPTION);
  expect(tool.request).toEqual(REQUEST);
  expect(tool.responses).toEqual(RESPONSES);
  expect(tool.responses.ok.applied).toBe("boolean");
  expect(tool.responses.ok.candidates.$array.scope.sourceMode).toBe("string");
  validateShape(tool.responses.ok);
  validateShape(tool.responses.error);
  expect(Object.keys(contract.tools).filter(name => name.startsWith("stratum_distill"))).toEqual(["stratum_distill"]);
});

it("returns applied === false for preview and staging with both apply flags enabled", async () => {
  vi.stubEnv("STRATUM_LEARN_APPLY_ENABLED", "1");
  vi.stubEnv("STRATUM_DISTILL_APPLY_ENABLED", "1");
  const { root, project } = await corpus();
  const dispatcher = createToolDispatcher();
  for (const write of [false, true]) {
    const result = await dispatcher.call("stratum_distill", { workspace_root: root, project_dir: project, write });
    expect(result.status).toBe("ok");
    expect(result.applied).toBe(false);
    expect(result.written).toBe(write ? 3 : 0);
  }
});
