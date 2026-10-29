export const STEP_STATUS = {
  pending: { label: 'pending', color: '#8b9099' },
  ready: { label: 'ready', color: '#38bdf8' },
  running: { label: 'running', color: '#f59e0b', pulse: true },
  waiting_gate: { label: 'waiting_gate', color: '#a78bfa', pulse: true },
  succeeded: { label: 'succeeded', color: '#10b981' },
  failed: { label: 'failed', color: '#ef4444' },
  skipped: { label: 'skipped', color: '#6b7280' },
};

export const RUN_STATUS = {
  queued: { label: 'queued', color: '#8b9099' },
  running: { label: 'running', color: '#f59e0b', pulse: true },
  waiting_gate: { label: 'waiting_gate', color: '#a78bfa', pulse: true },
  succeeded: { label: 'succeeded', color: '#10b981' },
  failed: { label: 'failed', color: '#ef4444' },
  killed: { label: 'killed', color: '#f97316' },
};

export const EVENT_TONES = {
  planned: '#8b9099',
  ready: '#38bdf8',
  result: '#34d399',
  routed: '#a78bfa',
  skipped: '#6b7280',
  gate_waiting: '#a78bfa',
  gate_resolved: '#10b981',
  fanout_item_start: '#22d3ee',
  fanout_item_done: '#10b981',
  fanout_merge: '#22d3ee',
  step_reset: '#f59e0b',
  usage_debit: '#fbbf24',
  completed: '#10b981',
  failed: '#ef4444',
};

export const stepStatus = (status) => STEP_STATUS[status] || STEP_STATUS.pending;
export const runStatus = (status) => RUN_STATUS[status] || RUN_STATUS.queued;
export const eventTone = (type) => EVENT_TONES[type] || '#8b9099';