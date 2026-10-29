import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error untyped Base44 JSX (STRAT-UI-BUILDER-1 types it)
import { FlowBuilder } from "../src/builder";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("builder slot renders the Base44 canvas from sample data without fetching", async () => {
  const fetchSpy = vi.fn(() => { throw new Error("builder called fetch"); });
  vi.stubGlobal("fetch", fetchSpy);
  const { container } = render(<FlowBuilder />);
  await vi.waitFor(() => expect(container.querySelectorAll("[data-step-id]").length).toBeGreaterThan(0));
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(screen.getAllByText(/gate/i).length).toBeGreaterThan(0);
});
