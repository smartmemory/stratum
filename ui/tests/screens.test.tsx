import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataClientProvider, GatesInbox, RunDetail, RunsList, type DataClient } from "../src";
import type { RunDetail as RunDetailData, RunSummary } from "../src/data-client";
import { fakeClient, fakeDetail, fakeGate } from "./fixtures";

// Proof that no screen fetches: any network call fails the test.
const fetchSpy = vi.fn(() => { throw new Error("component called fetch"); });
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); fetchSpy.mockClear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); expect(fetchSpy).not.toHaveBeenCalled(); });

const mount = (client: DataClient, ui: React.ReactNode) => render(<DataClientProvider client={client}>{ui}</DataClientProvider>);

describe("RunsList", () => {
  it("renders rows from listRuns, filters, and opens a run through the callback", async () => {
    const { client, calls } = fakeClient();
    const onOpenRun = vi.fn();
    const { container } = mount(client, <RunsList onOpenRun={onOpenRun} now={Date.parse("2026-10-30T02:00:00Z")} />); // setup change: the default tab is time-based, so pin the clock to the fixtures
    await screen.findByText("review");
    expect(container.querySelectorAll("[data-run-id]")).toHaveLength(2);
    fireEvent.click(screen.getByRole("tab", { name: "awaiting gate" }));
    expect(container.querySelectorAll("[data-run-id]")).toHaveLength(1);
    fireEvent.click(container.querySelector('[data-run-id="run-aaaa1111"]')!);
    expect(onOpenRun).toHaveBeenCalledWith("run-aaaa1111");
    expect(calls.map((call) => call.method)).toEqual(["listRuns"]);
  });
});

describe("RunsList stale and recent filters", () => {
  const NOW = Date.parse("2026-10-31T00:00:00Z");
  const day = 86400e3;
  const at = (ms: number) => new Date(ms).toISOString();
  const runs = (base: RunSummary): RunSummary[] => [
    { ...base, id: "run-fresh0001", flowName: "fresh", displayStatus: "running", stale: false, lastEventAt: at(NOW - 3600e3) },
    { ...base, id: "run-stale0001", flowName: "abandoned", displayStatus: "running", stale: true, lastEventAt: at(NOW - 38 * day) },
    { ...base, id: "run-done00001", flowName: "finished", displayStatus: "complete", stale: false, lastEventAt: at(NOW - 2 * day) },
    { ...base, id: "run-olddone01", flowName: "ancient", displayStatus: "complete", stale: false, lastEventAt: at(NOW - 30 * day) },
  ];
  // tab label | run ids shown (the tab's count equals their number)
  const TABS: Array<[string, string[]]> = [
    ["active, last 7 d", ["run-fresh0001", "run-done00001"]],
    ["stale", ["run-stale0001"]],
    ["all", ["run-fresh0001", "run-stale0001", "run-done00001", "run-olddone01"]],
  ];
  it("opens on active, last 7 d, and each tab lists its runs with counts; stale rows read stale with the age", async () => {
    const { client } = fakeClient();
    const base = (await client.listRuns())[0];
    const { container } = mount({ ...client, listRuns: async () => runs(base) }, <RunsList onOpenRun={vi.fn()} now={NOW} />);
    await screen.findByText("fresh");
    const ids = () => [...container.querySelectorAll("[data-run-id]")].map((node) => node.getAttribute("data-run-id"));
    expect(screen.getByRole("tab", { name: "active, last 7 d" }).getAttribute("aria-selected")).toBe("true");
    for (const [label, expected] of TABS) {
      const tab = screen.getByRole("tab", { name: label });
      fireEvent.click(tab);
      expect(ids()).toEqual(expected);
      expect(tab.textContent).toBe(`${label} ${expected.length}`);
    }
    const cell = container.querySelector('[data-run-id="run-stale0001"] [data-stale]')!;
    expect(cell.textContent).toMatch(/^stale · no event since .+ \(38 d\)$/);
    expect(cell.getAttribute("title")).toBe("No run event for more than 6 h. Stratum stores no heartbeat; this is the time of the last run event.");
    expect(container.querySelector('[data-run-id="run-fresh0001"] [data-status="running"]')).not.toBeNull();
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
    expect((await screen.findByTestId("step-drawer")).getAttribute("aria-label")).toBe("step approve"); // focus is set in an effect after the first paint
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

describe("RunDetail live updates", () => {
  it("uses the client's subscribe when it has one, renders pushes, never polls, and unsubscribes on unmount", async () => {
    let push: (run: RunDetailData | null) => void = () => {};
    let unsubscribed = 0;
    const { client, calls } = fakeClient({
      subscribe(runId, cb) { push = cb; calls.push({ method: "subscribe", args: [runId] }); return () => { unsubscribed += 1; }; },
    });
    const view = mount(client, <RunDetail runId={fakeDetail.id} pollMs={30} />);
    await screen.findByText(/waiting on gate/i);
    await new Promise((done) => setTimeout(done, 120)); // several poll periods
    expect(calls.filter((call) => call.method === "getRun")).toHaveLength(1);
    act(() => push({ ...fakeDetail, displayStatus: "complete", status: "completed", waitingGates: 0, stepStates: { ...fakeDetail.stepStates, approve: { status: "succeeded", attempts: [] } } }));
    await waitFor(() => expect(screen.queryByText(/waiting on gate/i)).toBeNull());
    view.unmount();
    expect(unsubscribed).toBe(1);
  });

  it("polls getRun on the interval when the client has no subscribe", async () => {
    const { client, calls } = fakeClient();
    mount(client, <RunDetail runId={fakeDetail.id} pollMs={30} />);
    await waitFor(() => expect(calls.filter((call) => call.method === "getRun").length).toBeGreaterThanOrEqual(3));
  });
});
