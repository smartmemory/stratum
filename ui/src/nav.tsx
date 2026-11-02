import { createContext, useContext, useState, type MouseEvent, type ReactNode } from "react";

/**
 * What a screen can point at (STRAT-UI-LINKS-1). Components never route: they render an <a href> when the
 * host's NavProvider can name a URL for the target, a <button> when only a callback exists (Compose passes
 * `onOpenRun` and friends), and plain text otherwise. Same shape as Cadence's `nav.tsx`.
 */
export type NavTarget =
  | { kind: "run"; id: string; stepId?: string | null }
  | { kind: "step"; runId?: string; stepId: string }
  | { kind: "flow"; runId?: string; stepId?: string | null }
  | { kind: "feature"; code: string }
  | { kind: "gates"; runId?: string; stepId?: string | null }
  | { kind: "runs"; filter?: string }
  | { kind: "builder" };

export interface Nav {
  /** URL for a target (shareable, middle-clickable); null when the host has none. */
  href?: (target: NavTarget) => string | null;
  /** In-app navigation for a target, used when the component has no callback of its own. */
  open?: (target: NavTarget) => void;
  /** False when the host has no page for a target (the standalone shell has no feature page); the link then stays text. Absent: every target is openable. */
  has?: (target: NavTarget) => boolean;
}

const NavContext = createContext<Nav | null>(null);

export function NavProvider({ nav, children }: { nav: Nav; children: ReactNode }) {
  return <NavContext.Provider value={nav}>{children}</NavContext.Provider>;
}

export function useNav(): Nav | null {
  return useContext(NavContext);
}

const plainClick = (event: MouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/** A real link when the host has a URL for the target, a button when only a callback exists, text when neither (nothing at all with `hideWithoutTarget`, for action controls that read wrong as text). */
export function EntityLink({ target, onOpen, className = "sui-link", title, hideWithoutTarget, children }: { target: NavTarget; onOpen?: () => void; className?: string; title?: string; hideWithoutTarget?: boolean; children: ReactNode }) {
  const nav = useNav();
  const href = nav?.href?.(target) ?? null;
  const open = onOpen ?? (nav?.open && nav.has?.(target) !== false ? () => nav.open?.(target) : undefined);
  if (href) {
    return (
      <a
        href={href}
        className={className}
        title={title}
        onClick={(event) => {
          event.stopPropagation();
          if (!open || !plainClick(event)) return;
          event.preventDefault();
          open();
        }}
      >
        {children}
      </a>
    );
  }
  if (open) {
    return (
      <button
        type="button"
        className={className}
        title={title}
        onClick={(event) => {
          event.stopPropagation();
          open();
        }}
      >
        {children}
      </button>
    );
  }
  if (hideWithoutTarget) return null;
  return <span className={className === "sui-link" ? undefined : className} title={title}>{children}</span>;
}

/** Text with no page to open (a run id, a path): one click copies it. Read-only: it only writes the clipboard, and says so when the browser refuses. */
export function CopyText({ value, children, className = "sui-link" }: { value: string; children?: ReactNode; className?: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  return (
    <button
      type="button"
      className={className}
      title={`copy ${value}`}
      onClick={(event) => {
        event.stopPropagation();
        const settle = (next: "done" | "failed") => {
          setState(next);
          setTimeout(() => setState("idle"), 1500);
        };
        if (!navigator.clipboard?.writeText) return settle("failed");
        navigator.clipboard.writeText(value).then(() => settle("done"), () => settle("failed"));
      }}
    >
      {state === "done" ? "copied" : state === "failed" ? "copy blocked" : (children ?? value)}
    </button>
  );
}
