import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { DataClientProvider, GatesInbox, NavProvider, RunDetail, RunsList, type DataClient, type Nav, type NavTarget } from "../src";

// Hash routes; the components never see them, they get callbacks and a NavProvider (the same seam Compose's
// activeView switch uses). Everything the user can pick is in the hash, so Back and reload restore it:
//   #/runs[?filter=stale]   #/runs/<id>[/<step>]   #/gates[?run=<id>]   #/builder[?run=<id>|?spec=<name>][&step=<id>]
export type Route =
  | { view: "runs"; filter?: string }
  | { view: "run"; runId: string; stepId?: string }
  | { view: "gates"; runId?: string }
  | { view: "builder"; runId?: string; spec?: string; stepId?: string };

export function parse(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(query);
  if (parts[0] === "runs" && parts[1]) return { view: "run", runId: parts[1], stepId: parts[2] };
  if (parts[0] === "gates") return { view: "gates", runId: params.get("run") ?? undefined };
  if (parts[0] === "builder") return { view: "builder", runId: params.get("run") ?? undefined, spec: params.get("spec") ?? undefined, stepId: params.get("step") ?? undefined };
  return { view: "runs", filter: params.get("filter") ?? undefined };
}

const enc = encodeURIComponent;
const query = (entries: Array<[string, string | null | undefined]>) => {
  const kept = entries.filter((entry): entry is [string, string] => !!entry[1]);
  return kept.length ? `?${kept.map(([key, value]) => `${key}=${enc(value)}`).join("&")}` : "";
};

/** The hash path for a target, or null when this shell has no page for it (a feature lives in the host app). */
export function pathFor(target: NavTarget): string | null {
  switch (target.kind) {
    case "run": return `/runs/${enc(target.id)}${target.stepId ? `/${enc(target.stepId)}` : ""}`;
    case "step": return target.runId ? `/runs/${enc(target.runId)}/${enc(target.stepId)}` : null;
    case "flow": return `/builder${query([["run", target.runId], ["step", target.stepId]])}`;
    case "gates": return `/gates${query([["run", target.runId]])}`;
    case "runs": return `/runs${query([["filter", target.filter]])}`;
    case "builder": return "/builder";
    case "feature": return null;
  }
}

const go = (path: string) => { window.location.hash = path; };
const nav: Nav = {
  href: (target) => { const path = pathFor(target); return path ? `#${path}` : null; },
  open: (target) => { const path = pathFor(target); if (path) go(path); },
};
const BuilderSlot = lazy(() => import("./BuilderSlot"));

export function App({ client }: { client: DataClient }) {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  const [waiting, setWaiting] = useState<number | null>(null);
  useEffect(() => {
    const onHash = () => setRoute(parse(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // The nav's gate count: refreshed on every route change and every 20 s. A failed read leaves the last count.
  const refresh = useCallback(() => { client.listGates().then((gates) => setWaiting(gates.length), () => undefined); }, [client]);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 20_000);
    return () => clearInterval(timer);
  }, [refresh, route.view]);

  const tab = route.view === "run" ? "runs" : route.view;
  const openRun = useMemo(() => (id: string, stepId?: string) => go(pathFor({ kind: "run", id, stepId })!), []);
  return (
    <DataClientProvider client={client}>
      <NavProvider nav={nav}>
        <div className="shell">
          <nav className="shell-nav" aria-label="stratum">
            <a className="shell-brand" href="#/runs">stratum</a>
            {(["runs", "gates", "builder"] as const).map((name) => (
              <a key={name} href={`#/${name}`} className={tab === name ? "shell-tab shell-tab-on" : "shell-tab"} aria-current={tab === name ? "page" : undefined}>
                {name}
                {name === "gates" && waiting !== null && waiting > 0 && <span className="shell-count" aria-label={`${waiting} waiting`}>{waiting}</span>}
              </a>
            ))}
          </nav>
          <main className="shell-main">
            {route.view === "runs" && (
              <RunsList
                onOpenRun={openRun}
                filter={route.filter}
                onFilterChange={(filter) => go(pathFor({ kind: "runs", filter: filter === "recent" ? undefined : filter })!)}
                onOpenGates={(runId) => go(pathFor({ kind: "gates", runId })!)}
                onOpenFlow={(runId) => go(pathFor({ kind: "flow", runId })!)}
                onOpenBuilder={() => go("/builder")}
              />
            )}
            {route.view === "run" && (
              <RunDetail
                runId={route.runId}
                stepId={route.stepId ?? null}
                onSelectStep={(stepId) => go(pathFor({ kind: "run", id: route.runId, stepId })!)}
                onBack={() => go("/runs")}
                onOpenRuns={() => go("/runs")}
                onOpenGates={(runId) => go(pathFor({ kind: "gates", runId })!)}
                onOpenFlow={(runId, stepId) => go(pathFor({ kind: "flow", runId, stepId })!)}
              />
            )}
            {route.view === "gates" && (
              <GatesInbox
                runId={route.runId}
                onOpenRun={openRun}
                onOpenRuns={() => go("/runs")}
                onOpenGates={(runId) => go(pathFor({ kind: "gates", runId })!)}
                onOpenFlow={(runId) => go(pathFor({ kind: "flow", runId })!)}
              />
            )}
            {route.view === "builder" && <Suspense fallback={null}><BuilderSlot runId={route.runId} specName={route.spec} stepId={route.stepId} /></Suspense>}
          </main>
        </div>
      </NavProvider>
    </DataClientProvider>
  );
}
