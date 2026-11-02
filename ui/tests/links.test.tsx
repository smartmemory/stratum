// STRAT-UI-LINKS-1: every entity name with a screen is a link, new callbacks fire with the right ids, the shell's hash is the state.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DagView, DataClientProvider, GatesInbox, RunDetail, RunsList, StepDrawer, type DataClient } from "../src";
// @ts-expect-error untyped Base44 JSX (its model, lib/spec.ts, is typed)
import { FlowBuilder } from "../src/builder";
import { App, parse, pathFor } from "../shell/App";
import { fakeClient, fakeDetail, fakeGate, persistedRun } from "./fixtures";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ""; });

const NOW = Date.parse("2026-10-30T02:00:00Z");
const GATE_SPEC = JSON.parse(readFileSync(join(__dirname, "fixtures", "specs", "gate-5dc37b92-dd13-4486-91ca-636021d5ac9d.json"), "utf8"));
const mount = (client: DataClient, ui: React.ReactElement) => render(<DataClientProvider client={client}>{ui}</DataClientProvider>);
const withFeature = (): DataClient => {
  const { client } = fakeClient();
  return { ...client, async listRuns() { const [a, b] = await client.listRuns(); return [{ ...a!, featureCode: "FEAT-1" }, b!]; } };
};
const hashNow = () => window.location.hash;

describe("RunsList links", () => {
  it("fires each callback with the right ids: flow, current step, gates, feature, builder", async () => {
    const cb = { onOpenRun: vi.fn(), onOpenFlow: vi.fn(), onOpenGates: vi.fn(), onOpenFeature: vi.fn() };
    const { container } = mount(withFeature(), <RunsList {...cb} now={NOW} />);
    await screen.findByText("review the draft");
    const row = container.querySelector('[data-run-id="run-aaaa1111"]') as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "FEAT-1" }));
    expect(cb.onOpenFeature).toHaveBeenCalledWith("FEAT-1");
    fireEvent.click(within(row).getByRole("button", { name: "review" }));
    expect(cb.onOpenFlow).toHaveBeenCalledWith("run-aaaa1111");
    fireEvent.click(within(row).getByRole("button", { name: "approve" }));
    expect(cb.onOpenRun).toHaveBeenCalledWith("run-aaaa1111", "approve");
    fireEvent.click(within(row).getByRole("button", { name: "1 gate" }));
    expect(cb.onOpenGates).toHaveBeenCalledWith("run-aaaa1111");
    expect(cb.onOpenRun).toHaveBeenCalledTimes(1); // none of the above also opened the row
    fireEvent.click(screen.getByRole("button", { name: "1 waiting in Gates" }));
    expect(cb.onOpenGates).toHaveBeenLastCalledWith();
  });

  it("the label is a keyboard-reachable button that opens the run, and ArrowDown moves to the next row", async () => {
    const onOpenRun = vi.fn();
    const { container } = mount(fakeClient().client, <RunsList onOpenRun={onOpenRun} now={NOW} />);
    await screen.findByText("review the draft");
    const links = [...container.querySelectorAll<HTMLElement>(".sui-runs-open")];
    expect(links).toHaveLength(2);
    links[0]!.focus();
    fireEvent.keyDown(links[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(links[1]);
    fireEvent.click(links[1]!);
    expect(onOpenRun).toHaveBeenCalledWith("run-bbbb2222");
  });

  it("a controlled filter reports changes, and the empty state offers the builder", async () => {
    const onFilterChange = vi.fn();
    mount(fakeClient().client, <RunsList onOpenRun={vi.fn()} filter="failed" onFilterChange={onFilterChange} now={NOW} />);
    await screen.findByText("build the thing");
    expect(screen.getByRole("tab", { name: "failed" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "stale" }));
    expect(onFilterChange).toHaveBeenCalledWith("stale");
    cleanup();
    const onOpenBuilder = vi.fn();
    mount({ ...fakeClient().client, listRuns: async () => [] }, <RunsList onOpenRun={vi.fn()} onOpenBuilder={onOpenBuilder} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open the builder" }));
    expect(onOpenBuilder).toHaveBeenCalled();
  });
});

describe("RunDetail + StepDrawer links", () => {
  it("DAG edge click selects its target; Enter on an edge does too; legend entries hide edge kinds", () => {
    const onSelect = vi.fn();
    const { container } = render(<DagView steps={fakeDetail.steps} states={fakeDetail.stepStates} selectedId={null} onSelect={onSelect} />);
    fireEvent.click(container.querySelector('[data-edge="after:critique->approve"]')!);
    expect(onSelect).toHaveBeenLastCalledWith("approve");
    fireEvent.keyDown(container.querySelector('[data-edge="revise:approve->draft"]')!, { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith("draft");
    const legend = screen.getByRole("button", { name: "revise (back-edge)" });
    fireEvent.click(legend);
    expect(container.querySelector('[data-edge="revise:approve->draft"]')).toBeNull();
    expect(legend.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(legend);
    expect(container.querySelector('[data-edge="revise:approve->draft"]')).not.toBeNull();
  });

  it("drawer ids select that step, a waiting gate offers Gates, and the builder link names the step", () => {
    const onSelectStep = vi.fn();
    const onOpenGates = vi.fn();
    const onOpenFlow = vi.fn();
    const approve = fakeDetail.steps[2]!;
    render(<StepDrawer step={approve} state={fakeDetail.stepStates.approve} events={fakeDetail.events} runId="run-aaaa1111" onSelectStep={onSelectStep} onOpenGates={onOpenGates} onOpenFlow={onOpenFlow} />);
    fireEvent.click(screen.getByRole("button", { name: "critique" })); // after
    expect(onSelectStep).toHaveBeenLastCalledWith("critique");
    fireEvent.click(screen.getByRole("button", { name: "draft" })); // revise route
    expect(onSelectStep).toHaveBeenLastCalledWith("draft");
    fireEvent.click(screen.getByRole("button", { name: "open in Gates" }));
    expect(onOpenGates).toHaveBeenCalledWith("run-aaaa1111", "approve");
    fireEvent.click(screen.getByRole("button", { name: "builder" }));
    expect(onOpenFlow).toHaveBeenCalledWith("approve");
  });

  it("drawer: on_fail and data-ref ids link; attempts and events expand to the full text", () => {
    const onSelectStep = vi.fn();
    const long = "x".repeat(300);
    const step = { id: "later", kind: "do" as const, after: ["draft"], on_fail: "critique", do: "use ${draft.output.text} and ${critique.output}" };
    render(
      <StepDrawer
        step={step}
        state={{ status: "failed", attempts: [{ attempt: 1, at: "2026-10-30T01:00:05Z", failure: { attempt: 1, reason: long } }] }}
        events={[{ at: "2026-10-30T01:00:05Z", type: "failed", stepId: "later", detail: { reason: long } }]}
        onSelectStep={onSelectStep}
      />,
    );
    const links = screen.getAllByRole("button", { name: "critique" }); // data ref + on_fail
    expect(links.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(links[links.length - 1]!);
    expect(onSelectStep).toHaveBeenLastCalledWith("critique");
    const toggles = screen.getAllByRole("button", { expanded: false });
    expect(toggles.length).toBe(2); // the attempt and the event
    for (const toggle of toggles) fireEvent.click(toggle);
    expect(document.querySelectorAll("pre.sui-pre").length).toBeGreaterThanOrEqual(2);
    expect(document.body.textContent).toContain(long);
  });

  it("fanout items expand to their output", () => {
    const step = { id: "each", kind: "fanout" as const };
    const state = { status: "running" as const, attempts: [], fanout: { items: [{ index: 0, status: "succeeded" as const, attempts: [], output: { found: "needle" } }] } };
    render(<StepDrawer step={step} state={state as never} events={[]} />);
    expect(screen.queryByText(/needle/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /#0/ }));
    expect(screen.getByText(/needle/)).toBeTruthy();
  });

  it("RunDetail: banner gate id selects the step, 'open gates' names the run and step, flow opens the builder, failure links the failing step", async () => {
    const cb = { onSelectStep: vi.fn(), onOpenGates: vi.fn(), onOpenFlow: vi.fn() };
    mount(fakeClient().client, <RunDetail runId="run-aaaa1111" onBack={vi.fn()} {...cb} />);
    const banner = (await screen.findByText(/Waiting on gate/)).closest("[role=status]") as HTMLElement;
    fireEvent.click(within(banner).getByRole("button", { name: "approve" }));
    expect(cb.onSelectStep).toHaveBeenLastCalledWith("approve");
    fireEvent.click(within(banner).getByRole("button", { name: "open gates" }));
    expect(cb.onOpenGates).toHaveBeenCalledWith("run-aaaa1111", "approve");
    fireEvent.click(screen.getByRole("button", { name: "review" }));
    expect(cb.onOpenFlow).toHaveBeenCalledWith("run-aaaa1111");
    fireEvent.click(screen.getByRole("button", { name: "builder" })); // the drawer's: this step
    expect(cb.onOpenFlow).toHaveBeenLastCalledWith("run-aaaa1111", "approve");
  });

  it("RunDetail with a host-held stepId follows it, and the not-found state links back without onBack", async () => {
    const { client } = fakeClient();
    const view = mount(client, <RunDetail runId="run-aaaa1111" stepId="draft" />);
    expect((await screen.findByTestId("step-drawer")).getAttribute("aria-label")).toBe("step draft");
    view.rerender(<DataClientProvider client={client}><RunDetail runId="run-aaaa1111" stepId="critique" /></DataClientProvider>);
    await waitFor(() => expect(screen.getByTestId("step-drawer").getAttribute("aria-label")).toBe("step critique"));
    cleanup();
    const onOpenRuns = vi.fn();
    mount(client, <RunDetail runId="nope" onOpenRuns={onOpenRuns} />);
    fireEvent.click(await screen.findByRole("button", { name: "Back to runs" }));
    expect(onOpenRuns).toHaveBeenCalled();
  });
});

describe("GatesInbox links", () => {
  it("header ids, route targets and results link; inspect run stays in revise mode; empty state links to runs", async () => {
    const cb = { onOpenRun: vi.fn(), onOpenFlow: vi.fn(), onOpenRuns: vi.fn(), onOpenGates: vi.fn() };
    const { client } = fakeClient();
    mount(client, <GatesInbox {...cb} />);
    const card = (await screen.findByRole("article")) as HTMLElement;
    fireEvent.click(within(card).getAllByRole("button", { name: "approve" })[0]!);
    expect(cb.onOpenRun).toHaveBeenLastCalledWith("run-aaaa1111", "approve");
    fireEvent.click(within(card).getByRole("button", { name: "draft" })); // revise → draft
    expect(cb.onOpenRun).toHaveBeenLastCalledWith("run-aaaa1111", "draft");
    fireEvent.click(within(card).getByRole("button", { name: "review" }));
    expect(cb.onOpenFlow).toHaveBeenCalledWith("run-aaaa1111");
    fireEvent.click(within(card).getByRole("button", { name: "Revise" }));
    fireEvent.click(within(card).getByRole("button", { name: "inspect run" }));
    expect(cb.onOpenRun).toHaveBeenLastCalledWith("run-aaaa1111");
    fireEvent.click(within(card).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    const results = await screen.findByRole("list", { name: "gate results" });
    fireEvent.click(within(results).getByRole("button", { name: "open run" }));
    expect(cb.onOpenRun).toHaveBeenLastCalledWith("run-aaaa1111");
    fireEvent.click(within(results).getByRole("button", { name: "clear" }));
    expect(screen.queryByRole("list", { name: "gate results" })).toBeNull();
    cleanup();
    mount({ ...client, listGates: async () => [] }, <GatesInbox {...cb} />);
    fireEvent.click(await screen.findByRole("button", { name: "See all runs" }));
    expect(cb.onOpenRuns).toHaveBeenCalled();
  });

  it("runId narrows the inbox and a clear link asks the host for the unfiltered one", async () => {
    const onOpenGates = vi.fn();
    const { client } = fakeClient();
    mount(client, <GatesInbox runId="run-zzzz9999" onOpenGates={onOpenGates} onOpenRun={vi.fn()} />);
    await screen.findByText(/No gate is waiting on run run-zzzz/);
    expect(screen.queryByRole("article")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "× clear" }));
    expect(onOpenGates).toHaveBeenCalledWith();
  });
});

describe("shell hash routes", () => {
  const run = persistedRun();
  const shell = (extra: Partial<DataClient> = {}) => render(<App client={{ ...fakeClient().client, ...extra }} />);

  it("parse and pathFor round-trip every route", () => {
    for (const hash of ["#/runs", "#/runs?filter=stale", "#/runs/r1", "#/runs/r1/draft", "#/gates", "#/gates?run=r1", "#/builder", "#/builder?run=r1", "#/builder?run=r1&step=draft", "#/builder?spec=my%20flow"]) {
      const route = parse(hash);
      const back = route.view === "run" ? pathFor({ kind: "run", id: route.runId, stepId: route.stepId })
        : route.view === "gates" ? pathFor({ kind: "gates", runId: route.runId })
        : route.view === "builder" ? (route.spec ? `/builder?spec=${encodeURIComponent(route.spec)}` : route.runId ? pathFor({ kind: "flow", runId: route.runId, stepId: route.stepId }) : "/builder")
        : pathFor({ kind: "runs", filter: route.filter });
      expect(`#${back}`).toBe(hash);
    }
    expect(parse("#/nonsense")).toEqual({ view: "runs", filter: undefined });
  });

  it("run + step: a deep link restores the step, clicking a step puts it in the hash, Back returns", async () => {
    window.location.hash = "#/runs/run-aaaa1111/critique";
    const view = shell();
    expect((await screen.findByTestId("step-drawer")).getAttribute("aria-label")).toBe("step critique");
    fireEvent.click(view.container.querySelector('[data-step-id="draft"]')!);
    await waitFor(() => expect(hashNow()).toBe("#/runs/run-aaaa1111/draft"));
    await waitFor(() => expect(screen.getByTestId("step-drawer").getAttribute("aria-label")).toBe("step draft"));
    act(() => { window.history.back(); });
    await waitFor(() => expect(hashNow()).toBe("#/runs/run-aaaa1111/critique"));
    await waitFor(() => expect(screen.getByTestId("step-drawer").getAttribute("aria-label")).toBe("step critique"));
    // reload = a fresh mount on the same hash
    view.unmount();
    shell();
    expect((await screen.findByTestId("step-drawer")).getAttribute("aria-label")).toBe("step critique");
  });

  it("a quick Back right after a click still restores the earlier step (the two hashchange events coalesce)", async () => {
    window.location.hash = "#/runs/run-aaaa1111/draft";
    const view = shell();
    await screen.findByTestId("step-drawer");
    fireEvent.click(view.container.querySelector('[data-step-id="critique"]')!);
    act(() => { window.history.back(); }); // before the shell's hashchange for the click has run
    await waitFor(() => expect(hashNow()).toBe("#/runs/run-aaaa1111/draft"));
    await waitFor(() => expect(screen.getByTestId("step-drawer").getAttribute("aria-label")).toBe("step draft"));
  });

  it("runs filter: the tab is in the hash, a reload keeps it, the default leaves it out", async () => {
    window.location.hash = "#/runs?filter=gates";
    const view = shell();
    expect((await screen.findByRole("tab", { name: "awaiting gate" })).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "failed" }));
    await waitFor(() => expect(hashNow()).toBe("#/runs?filter=failed"));
    expect(screen.getByRole("tab", { name: "failed" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "active, last 7 d" }));
    await waitFor(() => expect(hashNow()).toBe("#/runs"));
    view.unmount();
    window.location.hash = "#/runs?filter=stale";
    shell();
    expect((await screen.findByRole("tab", { name: "stale" })).getAttribute("aria-selected")).toBe("true");
  });

  it("gates filter by run: a run's gate link carries the run, the inbox narrows, clear goes back", async () => {
    window.location.hash = "#/runs/run-aaaa1111";
    shell();
    const banner = (await screen.findByText(/Waiting on gate/)).closest("[role=status]") as HTMLElement;
    fireEvent.click(within(banner).getByRole("link", { name: "open gates" }));
    await waitFor(() => expect(hashNow()).toBe("#/gates?run=run-aaaa1111"));
    expect(await screen.findByRole("article")).toBeTruthy();
    expect(screen.getByText(/run run-aaaa/)).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "× clear" }));
    await waitFor(() => expect(hashNow()).toBe("#/gates"));
  });

  it("a feature has no page in the shell, so its chip is text, not a dead button", async () => {
    window.location.hash = "#/runs";
    shell({ listRuns: withFeature().listRuns });
    const chip = await screen.findByTitle("feature FEAT-1");
    expect(chip.tagName).toBe("SPAN");
  });

  it("nav: the brand is a link home, the gates tab counts and aria-current marks the tab", async () => {
    window.location.hash = "#/gates";
    shell();
    expect((screen.getByRole("link", { name: "stratum" }) as HTMLAnchorElement).getAttribute("href")).toBe("#/runs");
    const tab = screen.getByRole("link", { name: /^gates/ });
    expect(tab.getAttribute("aria-current")).toBe("page");
    await waitFor(() => expect(within(tab).getByLabelText("1 waiting")).toBeTruthy());
    expect(screen.getByRole("link", { name: "runs" }).getAttribute("aria-current")).toBeNull();
  });

  it("builder deep link opens the run's own spec with the step selected; entity names are real anchors", async () => {
    const getRunSpec = vi.fn(async () => run.spec);
    window.location.hash = "#/builder?run=run-aaaa1111&step=draft";
    shell({ getRunSpec });
    const builder = await screen.findByTestId("flow-builder");
    expect(getRunSpec).toHaveBeenCalledWith("run-aaaa1111");
    expect(builder.querySelectorAll("[data-step-id]")).toHaveLength(3);
    expect(builder.querySelector('[data-step-id="draft"]')!.getAttribute("aria-pressed")).toBe("true");
    act(() => { window.location.hash = "#/runs"; });
    const flow = await screen.findByRole("link", { name: "review" });
    expect(flow.getAttribute("href")).toBe("#/builder?run=run-aaaa1111");
    expect(screen.getByRole("link", { name: "approve" }).getAttribute("href")).toBe("#/runs/run-aaaa1111/approve");
  });

  it("builder says so when the host cannot serve a run's spec", async () => {
    window.location.hash = "#/builder?run=run-aaaa1111";
    shell();
    expect((await screen.findByRole("alert")).textContent).toMatch(/cannot serve a run's spec/);
  });
});

describe("builder keyboard and links", () => {
  const nodeOf = (container: HTMLElement, id: string) => container.querySelector(`[data-step-id="${id}"]`) as HTMLElement;

  it("Enter selects a node, arrows nudge it, Delete removes it", () => {
    const { container } = render(<FlowBuilder initialSpec={GATE_SPEC} />);
    const node = nodeOf(container, "roadmap_gate");
    expect(node.getAttribute("tabindex")).toBe("0");
    expect(node.getAttribute("role")).toBe("button");
    node.focus();
    fireEvent.keyDown(node, { key: "Enter" });
    expect(node.getAttribute("aria-pressed")).toBe("true");
    const left = parseFloat(node.style.left);
    fireEvent.keyDown(node, { key: "ArrowRight" });
    expect(parseFloat(nodeOf(container, "roadmap_gate").style.left)).toBe(left + 10);
    fireEvent.keyDown(node, { key: "Delete" });
    expect(nodeOf(container, "roadmap_gate")).toBeNull();
    expect(container.querySelectorAll("[data-step-id]")).toHaveLength(5);
  });

  it("an edge can be chosen (click or Enter) and Delete disconnects it; a route edge selects its owner step", () => {
    const { container } = render(<FlowBuilder initialSpec={GATE_SPEC} />);
    const edge = () => container.querySelector('[data-edge="after:research->brainstorm"]') as SVGElement;
    expect(edge().getAttribute("role")).toBe("button");
    expect(edge().querySelector("title")!.textContent).toBe("after edge research to brainstorm");
    fireEvent.click(edge());
    expect(edge().getAttribute("data-selected")).toBe("true");
    fireEvent.keyDown(edge(), { key: "Delete" });
    expect(container.querySelector('[data-edge="after:research->brainstorm"]')).toBeNull();
    expect(nodeOf(container, "brainstorm").textContent).toContain("root");
    fireEvent.keyDown(container.querySelector('[data-edge="approve:review_gate->roadmap"]')!, { key: "Enter" });
    expect(nodeOf(container, "review_gate").getAttribute("aria-pressed")).toBe("true");
  });

  it("a node's after ids select that step; the error badge selects its step", async () => {
    const validateSpec = vi.fn(async () => ({ status: "invalid" as const, errors: [{ code: "ROUTING_UNKNOWN_TARGET", path: "flows.new.steps[2].gate.on_approve", message: "unknown step nowhere" }] }));
    const { container } = render(<DataClientProvider client={{ ...fakeClient().client, validateSpec }}><FlowBuilder initialSpec={GATE_SPEC} /></DataClientProvider>);
    fireEvent.click(container.querySelector('[data-after-link="research"]')!);
    expect(nodeOf(container, "research").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Validate/ }));
    const badge = await waitFor(() => { const b = container.querySelector("[data-error-badge]"); expect(b).not.toBeNull(); return b as HTMLElement; });
    fireEvent.click(nodeOf(container, "roadmap"));
    fireEvent.keyDown(badge, { key: "Enter" });
    expect(nodeOf(container, "review_gate").getAttribute("aria-pressed")).toBe("true");
  });

  it("validation rows with no step target select the flow settings, and Enter works on any row", async () => {
    const validateSpec = vi.fn(async () => ({ status: "invalid" as const, errors: [{ code: "FLOW_OUTPUT", path: "flows.new.output", message: "output.from is not a step" }] }));
    const { container } = render(<DataClientProvider client={{ ...fakeClient().client, validateSpec }}><FlowBuilder initialSpec={GATE_SPEC} /></DataClientProvider>);
    fireEvent.click(nodeOf(container, "research"));
    expect(screen.queryByLabelText("flow picker")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Validate/ }));
    const row = await screen.findByRole("button", { name: /select flow settings/ });
    expect(row.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(row, { key: "Enter" });
    expect(screen.getByLabelText("flow picker")).toBeTruthy();
  });

  it("'go to' beside a target picker selects that step, and beside a flow picker switches flow; the toolbar names the flows", () => {
    const { container } = render(<FlowBuilder initialSpec={GATE_SPEC} />);
    fireEvent.click(nodeOf(container, "review_gate"));
    fireEvent.click(screen.getByRole("button", { name: "go to step roadmap" }));
    expect(nodeOf(container, "roadmap").getAttribute("aria-pressed")).toBe("true");
    cleanup();
    const two = { ...GATE_SPEC, flows: { ...GATE_SPEC.flows, sub: { input: {}, output: { from: "a", contract: "Result" }, steps: [{ id: "a", do: "x" }] } } };
    two.flows.new = { ...two.flows.new, steps: [...two.flows.new.steps, { id: "call", run: "sub", with: {}, after: ["scaffold"] }] };
    const built = render(<FlowBuilder initialSpec={two} />);
    expect(screen.getByLabelText("switch flow")).toBeTruthy();
    fireEvent.click(nodeOf(built.container, "call"));
    const go = screen.queryByRole("button", { name: "go to flow sub" });
    expect(go).not.toBeNull();
    fireEvent.click(go!);
    expect(built.container.querySelectorAll("[data-step-id]")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("switch flow"), { target: { value: "new" } });
    expect(built.container.querySelectorAll("[data-step-id]")).toHaveLength(7);
  });

  it("export copy blocked by the browser says so instead of rejecting unhandled", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });
    render(<FlowBuilder initialSpec={GATE_SPEC} />);
    fireEvent.click(screen.getByRole("button", { name: /Export/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Copy JSON/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/blocked by the browser \(denied\)/);
  });

  it("step ids in a dry-plan result select that step", async () => {
    const planFlow = vi.fn(async () => ({ status: "planned", response: { step_id: "brainstorm", flow: "new" } }));
    const { container } = render(<DataClientProvider client={{ ...fakeClient().client, planFlow: planFlow as never }}><FlowBuilder initialSpec={GATE_SPEC} /></DataClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Dry plan" }));
    fireEvent.click(await screen.findByRole("button", { name: "Plan (dry)" }));
    const steps = await screen.findByTestId("plan-steps");
    fireEvent.click(within(steps).getByRole("button", { name: "brainstorm" }));
    await waitFor(() => expect(nodeOf(container, "brainstorm").getAttribute("aria-pressed")).toBe("true"));
  });
});

describe("SUBAPP-UI-LINKS-FU-1", () => {
  const label = () => screen.getByTestId("step-drawer").getAttribute("aria-label");
  /** A client whose `subscribe` hands the test the push function (a run changing on the engine). */
  const pushing = () => {
    let push: ((run: typeof fakeDetail | null) => void) | undefined;
    const client: DataClient = { ...fakeClient().client, subscribe: (_id, cb) => { push = cb as never; return () => undefined; } };
    return { client, push: () => act(() => { push!({ ...fakeDetail }); }) };
  };

  it("shell: close at #/runs/<id>/<step> closes the drawer for good, the URL names no step, a run push keeps it closed", async () => {
    window.location.hash = "#/runs/run-aaaa1111/draft";
    const { client, push } = pushing();
    render(<App client={client} />);
    await screen.findByTestId("step-drawer");
    fireEvent.click(screen.getByRole("button", { name: "close step" }));
    await waitFor(() => expect(hashNow()).toBe("#/runs/run-aaaa1111"));
    await waitFor(() => expect(screen.queryByTestId("step-drawer")).toBeNull());
    push();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(screen.queryByTestId("step-drawer")).toBeNull();
    // choosing a step opens it again
    fireEvent.click(document.querySelector('[data-step-id="critique"]')!);
    await waitFor(() => expect(label()).toBe("step critique"));
  });

  it("uncontrolled RunDetail: close stays closed across a run push (the e1ca769 behaviour)", async () => {
    const { client, push } = pushing();
    mount(client, <RunDetail runId="run-aaaa1111" />);
    await screen.findByTestId("step-drawer");
    fireEvent.click(screen.getByRole("button", { name: "close step" }));
    expect(screen.queryByTestId("step-drawer")).toBeNull();
    push();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(screen.queryByTestId("step-drawer")).toBeNull();
  });

  it("Back to the default #/runs shows the default filter", async () => {
    window.location.hash = "#/runs";
    render(<App client={fakeClient().client} />);
    fireEvent.click(await screen.findByRole("tab", { name: "awaiting gate" }));
    await waitFor(() => expect(hashNow()).toBe("#/runs?filter=gates"));
    act(() => { window.history.back(); });
    await waitFor(() => expect(hashNow()).toBe("#/runs"));
    await waitFor(() => expect(screen.getByRole("tab", { name: "active, last 7 d" }).getAttribute("aria-selected")).toBe("true"));
  });

  it("RunDetail with no host and no nav renders no open-gates, open-in-Gates or builder control", async () => {
    mount(fakeClient().client, <RunDetail runId="run-aaaa1111" />);
    const drawer = await screen.findByTestId("step-drawer");
    expect(screen.getByText(/Waiting on gate/)).toBeTruthy();
    expect(screen.queryByText("open gates")).toBeNull();
    expect(screen.queryByText("open in Gates")).toBeNull();
    expect(within(drawer).queryByText("builder")).toBeNull();
  });
});

