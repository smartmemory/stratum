import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { DataClient } from "./data-client";

const DataClientContext = createContext<DataClient | null>(null);

export function DataClientProvider({ client, children }: { client: DataClient; children: ReactNode }) {
  return <DataClientContext.Provider value={client}>{children}</DataClientContext.Provider>;
}

export function useDataClient(): DataClient {
  const client = useContext(DataClientContext);
  if (!client) throw new Error("@stratum/ui: wrap screens in <DataClientProvider client={...}>");
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
 */
export function useLoad<T>(load: (client: DataClient) => Promise<T>, deps: unknown[], pollMs = 0): Loaded<T> {
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
    if (!pollMs) return undefined;
    const timer = setInterval(run, pollMs);
    return () => clearInterval(timer);
  }, [run, pollMs]);

  return { data, error, loading, reload: run };
}
