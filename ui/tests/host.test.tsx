// COMP-SUBAPP-HOST-1: a host's selection reaches RunsList through <DataClientProvider host>; no host, every run.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataClientProvider, RunsList, useHost, type DataClient, type SubappHost } from "../src";
import { fakeClient } from "./fixtures";

afterEach(cleanup);

const NOW = Date.parse("2026-10-30T02:00:00Z");
const withCodes = (): DataClient => {
  const { client } = fakeClient();
  return {
    ...client,
    async listRuns() {
      const [a, b] = await client.listRuns();
      return [{ ...a, featureCode: "FEAT-1" }, { ...b, featureCode: "FEAT-2" }];
    },
  };
};
const mount = (host: SubappHost | undefined, client: DataClient = withCodes()) =>
  render(<DataClientProvider client={client} host={host}><RunsList onOpenRun={vi.fn()} now={NOW} /></DataClientProvider>);

describe("DataClientProvider host", () => {
  it("useHost is null without a host and the host object with one", () => {
    const seen: Array<SubappHost | null> = [];
    const Probe = () => { seen.push(useHost()); return null; };
    const { client } = fakeClient();
    const host = { selection: { featureCode: "FEAT-1" } };
    render(<DataClientProvider client={client}><Probe /></DataClientProvider>);
    render(<DataClientProvider client={client} host={host}><Probe /></DataClientProvider>);
    expect(seen).toEqual([null, host]);
  });
});

describe("RunsList scoped by the host selection", () => {
  it("shows only the selected feature's runs", async () => {
    const { container } = mount({ selection: { featureCode: "FEAT-1" } });
    await screen.findByText("review the draft");
    expect([...container.querySelectorAll("[data-run-id]")].map((el) => el.getAttribute("data-run-id"))).toEqual(["run-aaaa1111"]);
  });

  it("shows every run with no host (the standalone shell) and with an empty selection", async () => {
    for (const host of [undefined, { selection: {} }]) {
      const { container, unmount } = mount(host);
      await screen.findByText("build the thing");
      expect(container.querySelectorAll("[data-run-id]")).toHaveLength(2);
      unmount();
    }
  });

  it("says no run carries the feature, not that the engine never ran", async () => {
    mount({ selection: { featureCode: "FEAT-NONE" } });
    expect(await screen.findByText("No run carries FEAT-NONE.")).toBeTruthy();
  });
});
