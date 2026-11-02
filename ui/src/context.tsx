import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { DataClient, SubappHost } from "./data-client";

const DataClientContext = createContext<DataClient | null>(null);
const HostContext = createContext<SubappHost | null>(null);

/** `host` (optional) is what a host app mounting these screens knows: its selection, auth and attention sink (Compose's `contracts/subapp-host.schema.json`). The standalone shell passes none. */
export function DataClientProvider({ client, host, children }: { client: DataClient; host?: SubappHost | null; children: ReactNode }) {
  return (
    <DataClientContext.Provider value={client}>
      <HostContext.Provider value={host ?? null}>{children}</HostContext.Provider>
    </DataClientContext.Provider>
  );
}

/** The provider's host, or null when the screens run standalone. */
export function useHost(): SubappHost | null {
  return useContext(HostContext);
}

/** The provider's client, or null outside one (the builder works without a host, minus validate/plan). */
export function useOptionalDataClient(): DataClient | null {
  return useContext(DataClientContext);
}

export function useDataClient(): DataClient {
  const client = useContext(DataClientContext);
  if (!client) throw new Error("@smartmemory/stratum-ui: wrap screens in <DataClientProvider client={...}>");
  return client;
}

export interface Loaded<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Load through the DataClient, optionally re-polling every `pollMs` (0 = off). Keeps the
 * last good data on a failed refresh so a flaky poll does not blank the screen.
 *
 * `subscribe` (pass it only while live) is tried first: when it returns an unsubscribe
 * function, pushed values replace the data and polling stays off. When it is absent or
 * returns undefined (the host's client has no `subscribe`), `pollMs` polls instead.
 */
export function useLoad<T>(
  load: (client: DataClient) => Promise<T>,
  deps: unknown[],
  pollMs = 0,
  subscribe?: (client: DataClient, push: (value: T) => void) => (() => void) | undefined,
): Loaded<T> {
  const client = useDataClient();
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const run = useCallback(() => {
    const mine = ++seq.current;
    setLoading(true);
    load(client).then(
      (value) => {
        if (mine !== seq.current) return;
        setData(value);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (mine !== seq.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, ...deps]);

  useEffect(() => {
    setData(undefined);
    run();
  }, [run]);

  useEffect(() => {
    if (subscribe) {
      const off = subscribe(client, (value) => {
        seq.current += 1; // a pushed value is newer than any load still in flight
        setData(value);
        setError(null);
        setLoading(false);
      });
      if (off) return off;
    }
    if (!pollMs) return undefined;
    const timer = setInterval(run, pollMs);
    return () => clearInterval(timer);
  }, [client, run, pollMs, subscribe]);

  return { data, error, loading, reload: run };
}
