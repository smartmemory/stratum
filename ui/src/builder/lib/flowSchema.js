export const NODE_W = 236;
export const NODE_H = 112;

export const KIND_META = {
  do: { label: 'do', blurb: 'invoke an agent', tone: '#38bdf8' },
  set: { label: 'set', blurb: 'assign a value', tone: '#94a3b8' },
  gate: { label: 'gate', blurb: 'human approval', tone: '#a78bfa' },
  fanout: { label: 'fanout', blurb: 'parallel branches', tone: '#22d3ee' },
  run: { label: 'run', blurb: 'nested sub-flow', tone: '#fbbf24' },
  evaluate: { label: 'evaluate', blurb: 'score / assert', tone: '#34d399' },
};

export const KIND_KEYS = {
  do: ['agent', 'out', 'ensure', 'attempts', 'budget'],
  set: ['assign'],
  gate: ['on_approve', 'on_kill', 'on_revise', 'max_rounds'],
  fanout: ['over', 'concurrency', 'isolation', 'require', 'merge', 'steps'],
  run: ['flow'],
  evaluate: ['expr', 'threshold'],
};

export const KIND_FIELDS = {
  do: [
    { key: 'agent', label: 'agent', type: 'text', placeholder: 'release-triage' },
    { key: 'out', label: 'out', type: 'text', placeholder: 'plan' },
    { key: 'ensure', label: 'ensure', type: 'list', placeholder: 'plan.targets, plan.risk' },
    { key: 'attempts', label: 'attempts', type: 'number', min: 1, max: 10 },
    { key: 'budget', label: 'budget', type: 'number', min: 0, step: 1 },
  ],
  set: [{ key: 'assign', label: 'assign', type: 'json', hint: 'map of target → source' }],
  gate: [
    { key: 'on_approve', label: 'on_approve', type: 'target' },
    { key: 'on_kill', label: 'on_kill', type: 'target' },
    { key: 'on_revise', label: 'on_revise', type: 'target' },
    { key: 'max_rounds', label: 'max_rounds', type: 'number', min: 1, max: 20 },
  ],
  fanout: [
    { key: 'over', label: 'over', type: 'text', placeholder: 'plan.targets' },
    { key: 'concurrency', label: 'concurrency', type: 'number', min: 1, max: 32 },
    { key: 'isolation', label: 'isolation', type: 'enum', options: ['worktree', 'none'] },
    { key: 'require', label: 'require', type: 'text', placeholder: 'all | any | 2' },
    { key: 'merge', label: 'merge', type: 'enum', options: ['sequential'] },
    { key: 'steps', label: 'nested steps', type: 'json', hint: 'steps run per item' },
  ],
  run: [{ key: 'flow', label: 'flow', type: 'text', placeholder: 'nightly-audit' }],
  evaluate: [
    { key: 'expr', label: 'expr', type: 'text', placeholder: 'score >= 0.8' },
    { key: 'threshold', label: 'threshold', type: 'number', min: 0, max: 1, step: 0.05 },
  ],
};

export function defaultStep(kind, id, after = []) {
  const base = { id, kind, after, when: '' };
  switch (kind) {
    case 'do':
      return { ...base, agent: '', out: '', ensure: [], attempts: 2, budget: 25 };
    case 'set':
      return { ...base, assign: {} };
    case 'gate':
      return { ...base, on_approve: '', on_kill: '', on_revise: '', max_rounds: 2 };
    case 'fanout':
      return {
        ...base,
        over: '',
        concurrency: 4,
        isolation: 'worktree',
        require: 'all',
        merge: 'sequential',
        steps: [],
      };
    case 'run':
      return { ...base, flow: '' };
    case 'evaluate':
      return { ...base, expr: '', threshold: 0.8 };
    default:
      return base;
  }
}

export function nextStepId(kind, steps = []) {
  let i = 1;
  while (steps.some((s) => s.id === `${kind}_${i}`)) i += 1;
  return `${kind}_${i}`;
}

export function makeStarterFlow() {
  const draft = defaultStep('do', 'draft');
  const review = defaultStep('gate', 'review', ['draft']);
  const fanOut = defaultStep('fanout', 'fan_out', ['review']);
  const steps = [
    { ...draft, agent: 'planner', out: 'plan', ensure: ['plan.targets'] },
    { ...review, on_approve: 'fan_out', on_revise: 'draft', max_rounds: 2 },
    { ...fanOut, over: 'plan.targets', concurrency: 4, isolation: 'worktree', require: 'all' },
  ];
  return {
    name: 'untitled-flow',
    entry: true,
    contracts: { plan: { targets: 'string[]', risk: 'number' } },
    input: { ticket: 'string' },
    output: { from: 'fan_out', contract: 'plan' },
    steps,
    layout: autoLayout(steps),
  };
}

export function autoLayout(steps = []) {
  const byId = {};
  steps.forEach((s) => {
    byId[s.id] = s;
  });
  const depth = {};
  const calc = (id, seen = new Set()) => {
    if (depth[id] !== undefined) return depth[id];
    if (seen.has(id)) return 0;
    seen.add(id);
    const step = byId[id];
    const parents = ((step && step.after) || []).filter((a) => byId[a]);
    const d = parents.length ? Math.max(...parents.map((a) => calc(a, new Set(seen)))) + 1 : 0;
    depth[id] = d;
    return d;
  };
  steps.forEach((s) => calc(s.id));
  const rows = {};
  const layout = {};
  steps.forEach((s) => {
    const d = depth[s.id] || 0;
    rows[d] = rows[d] || 0;
    layout[s.id] = { x: 56 + d * (NODE_W + 92), y: 56 + rows[d] * (NODE_H + 52) };
    rows[d] += 1;
  });
  return layout;
}

export function validateFlow(flow) {
  const errors = [];
  const steps = flow.steps || [];
  const known = new Map();
  steps.forEach((s, i) => {
    if (!s.id) {
      errors.push({ code: 'missing_id', path: `steps[${i}].id`, message: 'Step is missing an id' });
      return;
    }
    if (known.has(s.id)) {
      errors.push({
        code: 'duplicate_id',
        path: `steps[${i}].id`,
        message: `Duplicate step id "${s.id}"`,
      });
    } else {
      known.set(s.id, s);
    }
  });

  steps.forEach((s, i) => {
    (s.after || []).forEach((a) => {
      if (!known.has(a)) {
        errors.push({
          code: 'unknown_after',
          path: `steps[${i}].after`,
          message: `"${s.id}" waits on unknown step "${a}"`,
        });
      }
    });
    if (s.kind === 'gate') {
      ['on_approve', 'on_kill', 'on_revise'].forEach((key) => {
        const target = s[key];
        if (target && !known.has(target)) {
          errors.push({
            code: 'unknown_target',
            path: `steps[${i}].${key}`,
            message: `Gate "${s.id}" routes to unknown step "${target}"`,
          });
        }
      });
    }
  });

  const state = new Map();
  const stack = [];
  const visit = (id) => {
    state.set(id, 'open');
    stack.push(id);
    const step = known.get(id);
    ((step && step.after) || []).forEach((parent) => {
      if (!known.has(parent)) return;
      const st = state.get(parent);
      if (st === 'open') {
        const idx = stack.indexOf(parent);
        const loop = stack.slice(idx >= 0 ? idx : 0).concat(parent);
        errors.push({
          code: 'cycle',
          path: `${id}.after`,
          message: `Cycle detected: ${loop.join(' → ')}`,
        });
      } else if (st !== 'done') {
        visit(parent);
      }
    });
    state.set(id, 'done');
    stack.pop();
  };
  [...known.keys()].forEach((id) => {
    if (!state.has(id)) visit(id);
  });

  const outputFrom = flow.output && flow.output.from;
  if (outputFrom && !known.has(outputFrom)) {
    errors.push({
      code: 'unknown_output',
      path: 'output.from',
      message: `Output is read from unknown step "${outputFrom}"`,
    });
  }

  return errors;
}

export function serializeStep(step) {
  const out = { id: step.id, kind: step.kind, after: step.after || [] };
  if (step.when) out.when = step.when;
  (KIND_KEYS[step.kind] || []).forEach((key) => {
    const value = step[key];
    if (value === undefined || value === '' || value === null) return;
    if (Array.isArray(value) && !value.length) return;
    if (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length) return;
    out[key] = value;
  });
  return out;
}

export function buildExport(flow) {
  return {
    version: 1,
    contracts: flow.contracts || {},
    flows: {
      entry: flow.name,
      [flow.name]: {
        input: flow.input || {},
        output: flow.output || {},
        steps: (flow.steps || []).map(serializeStep),
      },
    },
  };
}

export function parseImport(doc) {
  if (!doc || doc.version !== 1 || !doc.flows) {
    throw new Error('Expected a flow document with "version": 1 and a "flows" map');
  }
  const entry = doc.flows.entry;
  const body = doc.flows[entry];
  if (!entry || !body) throw new Error(`flows.entry "${entry}" does not exist in flows`);
  const steps = (body.steps || []).map((raw) => ({
    ...defaultStep(raw.kind, raw.id, raw.after || []),
    ...raw,
    after: raw.after || [],
  }));
  return {
    name: entry,
    entry: true,
    contracts: doc.contracts || {},
    input: body.input || {},
    output: body.output || {},
    steps,
    layout: autoLayout(steps),
  };
}

export function stepSummary(step) {
  switch (step.kind) {
    case 'do':
      return [step.agent, step.out && `→ ${step.out}`].filter(Boolean).join(' ') || 'no agent set';
    case 'set':
      return Object.keys(step.assign || {}).join(', ') || 'no assignment';
    case 'gate':
      return `approve → ${step.on_approve || '—'} · ${step.max_rounds || 1} rounds`;
    case 'fanout':
      return `over ${step.over || '—'} · ${step.concurrency || 1}× ${step.isolation || 'none'}`;
    case 'run':
      return step.flow ? `run ${step.flow}` : 'no sub-flow';
    case 'evaluate':
      return step.expr || 'no expression';
    default:
      return '';
  }
}