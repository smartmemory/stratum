import { lazy, Suspense, useEffect, useState } from "react";
import { DataClientProvider, GatesInbox, RunDetail, RunsList, type DataClient } from "../src";

// Hash routes; the components never see them, they get callbacks (the same seam Compose's
// activeView switch uses).
type Route = { view: "runs" } | { view: "run"; runId: string } | { view: "gates" } | { view: "builder" };

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "runs" && parts[1]) return { view: "run", runId: parts[1] };
  if (parts[0] === "gates") return { view: "gates" };
  if (parts[0] === "builder") return { view: "builder" };
  return { view: "runs" };
}

const go = (path: string) => { window.location.hash = path; };
const BuilderSlot = lazy(() => import("./BuilderSlot"));

export function App({ client }: { client: DataClient }) {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parse(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const tab = route.view === "run" ? "runs" : route.view;
  return (
    <DataClientProvider client={client}>
      <div className="shell">
        <nav className="shell-nav" aria-label="stratum">
          <span className="shell-brand">stratum</span>
          {(["runs", "gates", "builder"] as const).map((name) => (
            <a key={name} href={`#/${name}`} className={tab === name ? "shell-tab shell-tab-on" : "shell-tab"}>{name}</a>
          ))}
        </nav>
        <main className="shell-main">
          {route.view === "runs" && <RunsList onOpenRun={(id) => go(`/runs/${encodeURIComponent(id)}`)} />}
          {route.view === "run" && <RunDetail runId={route.runId} onBack={() => go("/runs")} onOpenGates={() => go("/gates")} />}
          {route.view === "gates" && <GatesInbox onOpenRun={(id) => go(`/runs/${encodeURIComponent(id)}`)} />}
          {route.view === "builder" && <Suspense fallback={null}><BuilderSlot /></Suspense>}
        </main>
      </div>
    </DataClientProvider>
  );
}
