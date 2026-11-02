// COMP-SUBAPP-STRAT-AUTHOR-1: the saved-spec methods are OPTIONAL contract additions. A client
// without them (the standalone shell's) still satisfies DataClient, and CONTRACT_VERSION stays 1
// ("bump CONTRACT_VERSION on any breaking change", data-client.ts header). `tsc --noEmit` checks the types.
import { describe, expect, it } from "vitest";
import { CONTRACT_VERSION, type SaveSpecResult, type SavedSpecSummary } from "../src/data-client";
import { fakeClient } from "./fixtures";

describe("DataClient saved-spec methods", () => {
  it("are optional: a client without them is still a DataClient", () => {
    const { client } = fakeClient();
    expect(client.saveSpec).toBeUndefined();
    expect(client.listSpecs).toBeUndefined();
    expect(client.readSpec).toBeUndefined();
    expect(CONTRACT_VERSION).toBe(1);
  });

  it("a host client implementing them round-trips a spec by name", async () => {
    const store = new Map<string, unknown>();
    const { client } = fakeClient({
      listSpecs: async (): Promise<SavedSpecSummary[]> => [...store.keys()].map((name) => ({ name, updatedAt: "2026-11-02T00:00:00Z" })),
      readSpec: async (name: string) => store.get(name) ?? null,
      saveSpec: async (name: string, spec: unknown): Promise<SaveSpecResult> => {
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) return { ok: false, code: "BAD_NAME", message: "bad name" };
        const created = !store.has(name);
        store.set(name, spec);
        return { ok: true, name, created };
      },
    });
    const spec = { version: 1, flows: { entry: "main", main: { steps: [] } } };
    expect(await client.saveSpec!("demo", spec)).toEqual({ ok: true, name: "demo", created: true });
    expect(await client.saveSpec!("Bad Name", spec)).toMatchObject({ ok: false, code: "BAD_NAME" });
    expect(await client.listSpecs!()).toEqual([{ name: "demo", updatedAt: "2026-11-02T00:00:00Z" }]);
    expect(await client.readSpec!("demo")).toEqual(spec);
    expect(await client.readSpec!("nope")).toBeNull();
  });
});
