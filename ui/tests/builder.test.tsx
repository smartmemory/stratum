import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DataClientProvider, type DataClient } from "../src";
// @ts-expect-error untyped Base44 JSX (its model, lib/spec.ts, is typed)
import { FlowBuilder } from "../src/builder";
import { stepKind, KINDS } from "../src/builder/lib/spec";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const GATE_SPEC = JSON.parse(readFileSync(join(__dirname, "fixtures", "specs", "gate-5dc37b92-dd13-4486-91ca-636021d5ac9d.json"), "utf8"));

function fakeClient(overrides: Partial<DataClient> = {}): DataClient {
  return {
    listRuns: vi.fn(async () => []),
    getRun: vi.fn(async () => null),
    listGates: vi.fn(async () => []),
    resolveGate: vi.fn(async () => ({ ok: false as const, kind: "error" as const, code: "NO", message: "no" })),
    ...overrides,
  };
}

function noFetch() {
  const spy = vi.fn(() => { throw new Error("builder called fetch"); });
  vi.stubGlobal("fetch", spy);
  return spy;
}

it("renders a real spec with every edge kind and no fetch; validate/plan are disabled without a host client", () => {
  const fetchSpy = noFetch();
  const { container } = render(<FlowBuilder initialSpec={GATE_SPEC} />);
  expect(container.querySelectorAll("[data-step-id]").length).toBe(6);
  // after arrows, gate approve route and the on_revise back-edge (compose `new`: review_gate → roadmap / ↺ brainstorm)
  expect(container.querySelector('[data-edge="after:research->brainstorm"]')).not.toBeNull();
  expect(container.querySelector('[data-edge="approve:review_gate->roadmap"]')).not.toBeNull();
  expect(container.querySelector('[data-edge="revise:review_gate->brainstorm"]')).not.toBeNull();
  expect((screen.getByRole("button", { name: /Validate/ }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: /Dry plan/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("button", { name: /^Run/ })).toBeNull();
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("validate goes through the DataClient and pins each error to the node its path names", async () => {
  noFetch();
  const validateSpec = vi.fn(async () => ({
    status: "invalid" as const,
    errors: [{ code: "ROUTING_UNKNOWN_TARGET", path: "flows.new.steps[2].gate.on_approve", message: "unknown step nowhere" }],
  }));
  const { container } = render(
    <DataClientProvider client={fakeClient({ validateSpec, planFlow: vi.fn() })}>
      <FlowBuilder initialSpec={GATE_SPEC} />
    </DataClientProvider>,
  );
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Validate/ })); });
  expect(validateSpec).toHaveBeenCalledWith(GATE_SPEC);
  const flagged = [...container.querySelectorAll("[data-error]")].map((node) => node.getAttribute("data-step-id"));
  expect(flagged).toEqual(["review_gate"]);
  expect(container.querySelector('[data-step-id="review_gate"]')!.getAttribute("data-error")).toBe("ROUTING_UNKNOWN_TARGET");
  // clicking the error row selects the node and shows the error in its panel
  fireEvent.click(screen.getByText("new/review_gate"));
  expect(screen.getByTestId("step-errors").textContent).toContain("ROUTING_UNKNOWN_TARGET");
});

it("palette steps are emitted with exactly one kind key, placed after the selected step", async () => {
  noFetch();
  const onChange = vi.fn();
  const { container } = render(<FlowBuilder onChange={onChange} />);
  for (const kind of KINDS) fireEvent.click(screen.getByRole("button", { name: `add ${kind} step` }));
  expect(container.querySelectorAll("[data-step-id]").length).toBe(KINDS.length);
  await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2000 });
  const spec = onChange.mock.calls.at(-1)![0];
  const steps = spec.flows.main.steps as Array<Record<string, unknown>>;
  expect(steps.map((step) => stepKind(step))).toEqual([...KINDS]);
  expect(steps.every((step) => !("kind" in step))).toBe(true);
  // each new step chains after the previously selected one
  expect(steps.slice(1).map((step) => step.after)).toEqual(steps.slice(0, -1).map((step) => [step.id]));
});

it("dry plan sends the exported spec and the entry input to planFlow and shows the response", async () => {
  noFetch();
  const planFlow = vi.fn(async () => ({ status: "planned" as const, response: { status: "execute_step", step_id: "research" } }));
  render(
    <DataClientProvider client={fakeClient({ validateSpec: vi.fn(), planFlow })}>
      <FlowBuilder initialSpec={GATE_SPEC} />
    </DataClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /Dry plan/ }));
  const input = screen.getByLabelText("plan input") as HTMLTextAreaElement;
  expect(JSON.parse(input.value)).toEqual({ projectName: "", intent: "" });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Plan \(dry\)/ })); });
  expect(planFlow).toHaveBeenCalledWith(GATE_SPEC, { projectName: "", intent: "" });
  expect(screen.getByTestId("plan-result").textContent).toContain("execute_step");
});
