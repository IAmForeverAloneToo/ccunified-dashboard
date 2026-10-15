import type { DetailedSummary, Summary, Totals } from "./api";
import { modelFamily } from "./models";

/**
 * What the Overview is limited to. An empty list means "all". A model counts
 * if its family is in `families` or its exact name is in `models`.
 */
export interface Filters {
  machines: string[];
  tools: string[];
  families: string[];
  models: string[];
}

export const noFilters = (): Filters => ({ machines: [], tools: [], families: [], models: [] });

const PARAMS: [keyof Filters, string][] = [
  ["machines", "machine"],
  ["tools", "tool"],
  ["families", "family"],
  ["models", "model"],
];

/** The filters in the page address (?machine=…&tool=…&family=…&model=…). */
export function readFilters(query: URLSearchParams): Filters {
  const f = noFilters();
  for (const [key, param] of PARAMS) f[key] = [...new Set(query.getAll(param).filter(Boolean))];
  return f;
}

/** Puts the filters into the page address, replacing any there. */
export function writeFilters(query: URLSearchParams, f: Filters): void {
  for (const [key, param] of PARAMS) {
    query.delete(param);
    for (const value of f[key]) query.append(param, value);
  }
}

export const isFiltered = (f: Filters) => PARAMS.some(([key]) => f[key].length > 0);

/** Whether a row of usage passes the filters. */
export function matcher(f: Filters): (machine: string, tool: string, model: string) => boolean {
  const machines = new Set(f.machines);
  const tools = new Set(f.tools);
  const families = new Set(f.families);
  const models = new Set(f.models);
  const anyModel = families.size === 0 && models.size === 0;
  return (machine, tool, model) =>
    (machines.size === 0 || machines.has(machine)) &&
    (tools.size === 0 || tools.has(tool)) &&
    (anyModel || models.has(model) || families.has(modelFamily(model).id));
}

/**
 * The exact models the filters allow, out of the models the dashboard knows,
 * for asking the server; null if every model is allowed.
 */
export function allowedModels(f: Filters, known: string[]): string[] | null {
  if (f.families.length === 0 && f.models.length === 0) return null;
  const ok = matcher({ ...f, machines: [], tools: [] });
  return [...new Set([...known.filter((m) => ok("", "", m)), ...f.models])];
}

function emptyTotals(): Totals {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    cost_usd: 0,
  };
}

/** The totals of the rows that pass the filters. */
export function applyFilters(s: DetailedSummary, f: Filters): Summary {
  const d = s.detail;
  const ok = matcher(f);
  const byMachine = new Map<string, Totals & { day: string; machine_id: string }>();
  const byModel = new Map<string, Totals & { day: string; model: string }>();
  const bySource = new Map<string, Totals & { day: string; source: string }>();
  const machineSource = new Map<string, Totals & { machine_id: string; source: string }>();
  const addTo = <T extends Totals>(
    map: Map<string, T>,
    key: string,
    make: () => T,
    row: (typeof d.rows)[number],
  ) => {
    const t = map.get(key) ?? make();
    t.input_tokens += row[4];
    t.output_tokens += row[5];
    t.cache_creation_tokens += row[6];
    t.cache_read_tokens += row[7];
    t.cost_usd += row[8];
    map.set(key, t);
  };
  for (const row of d.rows) {
    const [di, mi, si, ki] = row;
    const day = d.days[di] ?? "";
    const machine = d.machines[mi] ?? "";
    const source = d.sources[si] ?? "";
    const model = d.models[ki] ?? "";
    if (!ok(machine, source, model)) continue;
    addTo(
      byMachine,
      `${day}|${machine}`,
      () => ({ day, machine_id: machine, ...emptyTotals() }),
      row,
    );
    addTo(byModel, `${day}|${model}`, () => ({ day, model, ...emptyTotals() }), row);
    addTo(bySource, `${day}|${source}`, () => ({ day, source, ...emptyTotals() }), row);
    addTo(
      machineSource,
      `${machine}|${source}`,
      () => ({ machine_id: machine, source, ...emptyTotals() }),
      row,
    );
  }
  return {
    timezone: s.timezone,
    today: s.today,
    from: s.from,
    to: s.to,
    tools: s.tools,
    models: s.models,
    bucket: s.bucket,
    by_day_machine: [...byMachine.values()],
    by_day_model: [...byModel.values()],
    by_day_source: [...bySource.values()],
    by_machine_source: [...machineSource.values()],
  };
}

/** What each filter list can offer. */
export interface Available {
  machines: Set<string>;
  tools: Set<string>;
  models: Set<string>;
}

/**
 * What each list can offer: the machines, tools and models with usage in the
 * period's rows that match the picks in the other two lists. A list's own
 * picks don't narrow it, so several items can be ticked in one list.
 */
export function available(s: DetailedSummary, f: Filters): Available {
  const d = s.detail;
  const machines = new Set(f.machines);
  const tools = new Set(f.tools);
  const families = new Set(f.families);
  const models = new Set(f.models);
  const anyModel = families.size === 0 && models.size === 0;
  const modelOk = new Map<string, boolean>();
  const out: Available = { machines: new Set(), tools: new Set(), models: new Set() };
  for (const [, mi, si, ki, input, output, write, read] of d.rows) {
    if (input + output + write + read === 0) continue;
    const machine = d.machines[mi] ?? "";
    const tool = d.sources[si] ?? "";
    const model = d.models[ki] ?? "";
    const okMachine = machines.size === 0 || machines.has(machine);
    const okTool = tools.size === 0 || tools.has(tool);
    let okModel = modelOk.get(model);
    if (okModel === undefined) {
      okModel = anyModel || models.has(model) || families.has(modelFamily(model).id);
      modelOk.set(model, okModel);
    }
    if (okTool && okModel) out.machines.add(machine);
    if (okMachine && okModel) out.tools.add(tool);
    if (okMachine && okTool) out.models.add(model);
  }
  return out;
}
