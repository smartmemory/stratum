import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataClientProvider, GatesInbox, RunDetail, RunsList, type DataClient } from "../src";
import { fakeClient, fakeGate } from "./fixtures";

// Proof that no screen fetches: any network call fails the test.
const fetchSpy = vi.fn(() => { throw new Error("component called fetch"); });
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); fetchSpy.mockClear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); expect(fetchSpy).not.toHaveBeenCalled(); });

const mount = (client: DataClient, ui: React.ReactNode) => render(<DataClientProvider client={client}>{ui}</DataClientProvider>);

describe("RunsList", () => {
  it("renders rows from listRuns, filters, and opens a run through the callback", async () => {
    const { client, calls } = fakeClient();
    const onOpenRun = vi.fn();
    const { container } = mount(client, <RunsList onOpenRun={onOpenRun} />);
    await screen.findByText("review");
    expect(container.querySelectorAll("[data-run-id]")).toHaveLength(2);
    fireEvent.click(screen.getByRole("tab", { name: "awaiting gate" }));
    expect(container.querySelectorAll("[data-run-id]")).toHaveLength(1);
    fireEvent.click(container.querySelector('[data-run-id="run-aaaa1111"]')!);
    expect(onOpenRun).toHaveBeenCalledWith("run-aaaa1111");
    expect(calls.map((call) => call.method)).toEqual(["listRuns"]);
  });
});

describe("RunDetail", () => {
  it("draws the DAG coloured by status, focuses the waiting gate, and opens a step drawer", async () => {
    const { client } = fakeClient();
    const onBack = vi.fn();
    const { container } = mount(client, <RunDetail runId="run-aaaa1111" onBack={onBack} />);
    await screen.findByTestId("dag");
    const nodes = container.querySelectorAll("[data-step-id]");
    expect([...nodes].map((node) => `${node.getAttribute("data-step-id")}:${node.getAttribute("data-status")}`))
      .toEqual(["draft:succeeded", "critique:failed", "approve:waiting_gate"]);
    // edges: data ref draft→critique, after critique→approve, revise approve→draft
    expect([...container.querySelectorAll("[data-edge]")].map((edge) => edge.getAttribute("data-edge")).sort())
      .toEqual(["after:critique->approve", "data:draft->critique", "revise:approve->draft"]);
    expect(screen.getByTestId("step-drawer").getAttribute("aria-label")).toBe("step approve");
    fireEvent.click(container.querySelector('[data-step-id="critique"]')!);
    expect(screen.getByTestId("step-drawer").getAttribute("aria-label")).toBe("step critique");
    expect(screen.getAllByText("ensure failed").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("← runs"));
    expect(onBack).toHaveBeenCalled();
  });

  it("shows not-found for an unknown run", async () => {
    const { client } = fakeClient();
    mount(client, <RunDetail runId="nope" />);
    await screen.findByText(/No run with id nope/);
  });
});

describe("GatesInbox", () => {
  it("approves with the gate token the inbox showed, and requires a note to revise", async () => {
    const { client, resolved } = fakeClient();
    mount(client, <GatesInbox onOpenRun={vi.fn()} />);
    await screen.findByText("1 waiting");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(resolved).toHaveLength(1));
    expect(resolved[0]).toEqual({ runId: fakeGate.runId, stepId: "approve", action: "approve", note: undefined, gateToken: "tok-1" });
    await screen.findByText(/approve → complete/);

    fireEvent.click(screen.getByRole("button", { name: "Revise" }));
    const submit = screen.getByRole("button", { name: "Request revision" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/What should change/), { target: { value: "tighten scope" } });
    fireEvent.click(submit);
    await waitFor(() => expect(resolved).toHaveLength(2));
    expect(resolved[1]).toMatchObject({ action: "revise", note: "tighten scope", gateToken: "tok-1" });
  });

  it("a revise that opens a new gate round shows that round fresh, with its new token", async () => {
    let token = "tok-1";
    const { client, resolved } = fakeClient({
      async listGates() { return [{ ...fakeGate, gateToken: token }]; },
      async resolveGate(request) {
        resolved.push(request);
        token = "tok-2";
        return { ok: true, runId: request.runId, stepId: request.stepId, outcome: "revise", result: "execute_step" };
      },
    });
    mount(client, <GatesInbox />);
    await screen.findByText("1 waiting");
    fireEvent.click(screen.getByRole("button", { name: "Revise" }));
    fireEvent.change(screen.getByPlaceholderText(/What should change/), { target: { value: "tighten scope" } });
    fireEvent.click(screen.getByRole("button", { name: "Request revision" }));
    await screen.findByText(/revise → execute_step/);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(resolved).toHaveLength(2));
    expect(screen.queryByPlaceholderText(/What should change/)).toBeNull();
    expect(resolved.map((request) => `${request.action}:${request.gateToken}`)).toEqual(["revise:tok-1", "approve:tok-2"]);
  });

  it("reject needs a confirm, and a refusal is shown, not thrown", async () => {
    const { client, resolved } = fakeClient({
      async resolveGate(request) {
        resolved.push(request);
        return { ok: false, kind: "conflict", code: "CONFLICT", message: "Flow is already complete" };
      },
    });
    mount(client, <GatesInbox />);
    await screen.findByText("1 waiting");
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(resolved).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Confirm reject" }));
    await screen.findByText(/conflict \(CONFLICT\): Flow is already complete/);
    expect(resolved[0]!.action).toBe("reject");
  });
});
