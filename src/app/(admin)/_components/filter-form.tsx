"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Shared filter surface (system update — Group 2, items E/F/H).
 *
 * Behaviour contract:
 *   • NO Apply button. Selects apply the moment they change; text and number
 *     inputs apply on a short debounce (350ms) or on Enter.
 *   • Filtering stays SERVER-SIDE: the component only writes query parameters
 *     and lets the page/API re-query. Nothing is filtered in the browser, so
 *     paginated and permission-sensitive lists keep behaving exactly as before.
 *   • `preserve` carries unrelated state through a filter change (sort, order,
 *     pageSize, and the year/week a page is anchored to). This is the bug the
 *     old Apply-only form had: submitting it silently dropped the active sort.
 *   • `page` is deliberately NOT preserved — a new filter starts at page 1.
 *   • Reset clears every filter in ONE click and restores the default dataset.
 *
 * Values are seeded from the server on every navigation, so the controls always
 * show what the current URL actually applied.
 */

export interface FilterSelectField {
  name: string;
  label: string;
  options: { value: string; label: string }[];
  kind?: "select";
}

export interface FilterInputField {
  kind: "search" | "number";
  name: string;
  label?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  width?: number;
}

export type FilterField = FilterSelectField | FilterInputField;

function fieldValues(values: Record<string, string | undefined>, fields: FilterField[]) {
  const out: Record<string, string> = {};
  for (const f of fields) out[f.name] = values[f.name] ?? "";
  return out;
}

export function FilterForm({
  action,
  fields,
  values,
  preserve,
  resetLabel = "Reset",
  resetHref,
}: {
  /** Page the filters belong to; also the Reset target unless resetHref is given. */
  action: string;
  fields: FilterField[];
  /** Currently APPLIED values (from the URL, parsed server-side). */
  values: Record<string, string | undefined>;
  /** Unrelated params carried through every filter change (sort, year, …). */
  preserve?: Record<string, string | undefined>;
  resetLabel?: string;
  /** Where Reset goes (e.g. the current week). Defaults to `action`. */
  resetHref?: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const applied = useRef<Record<string, string>>(fieldValues(values, fields));
  const [local, setLocal] = useState<Record<string, string>>(() => fieldValues(values, fields));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appliedKey = useRef<string>(JSON.stringify(fieldValues(values, fields)));
  // Update #7 — TRUE while OUR OWN navigation (or debounce) is still in flight.
  // Server `values` lag behind push(); without this guard an interim re-render
  // (e.g. the next keystroke) sees a "changed" seed and wipes what was typed.
  const inFlight = useRef(false);

  // Re-seed only on a genuine EXTERNAL change (Reset, a sort link, back/forward):
  // never while our own push is in flight or a keystroke debounce is armed.
  const seed = fieldValues(values, fields);
  const seedKey = JSON.stringify(seed);
  useEffect(() => {
    if (seedKey === appliedKey.current) {
      inFlight.current = false; // our navigation landed — values acknowledged
      return;
    }
    if (inFlight.current || timer.current !== null) return; // stale props mid-push
    appliedKey.current = seedKey;
    applied.current = seed;
    setLocal(seed);
  }, [seedKey, seed]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function buildUrl(next: Record<string, string>) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(preserve ?? {})) {
      if (v) params.set(k, v);
    }
    for (const f of fields) {
      const v = next[f.name];
      if (v) params.set(f.name, v);
    }
    const qs = params.toString();
    return qs ? `${action}?${qs}` : action;
  }

  function push(next: Record<string, string>) {
    timer.current = null; // debounce is spent; it must not block the ack re-seed
    applied.current = next;
    appliedKey.current = JSON.stringify(fieldValues(next as Record<string, string | undefined>, fields));
    inFlight.current = true;
    startTransition(() => router.replace(buildUrl(next), { scroll: false }));
  }

  function onSelect(name: string, value: string) {
    const next = { ...local, [name]: value };
    setLocal(next);
    push(next);
  }

  function onText(name: string, value: string, immediate = false) {
    const next = { ...local, [name]: value };
    setLocal(next);
    if (timer.current) clearTimeout(timer.current);
    if (immediate) {
      push(next);
      return;
    }
    timer.current = setTimeout(() => push(next), 350);
  }

  return (
    <form
      className="toolbar"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        if (timer.current) clearTimeout(timer.current);
        push(local);
      }}
    >
      {fields.map((f) => {
        if (f.kind === "select" || f.kind === undefined) {
          const select = f as FilterSelectField;
          return (
            <label key={select.name} className="toolbar-filter">
              <span>{select.label}</span>
              <select
                name={select.name}
                value={local[select.name] ?? ""}
                onChange={(e) => onSelect(select.name, e.target.value)}
              >
                <option value="">All</option>
                {select.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          );
        }
        const input = f as FilterInputField;
        const style = input.width ? { width: input.width } : undefined;
        return (
          <label key={input.name} className={input.label ? "toolbar-filter" : undefined}>
            {input.label ? (
              <span>
                {input.label}
              </span>
            ) : null}
            <input
              name={input.name}
              type={input.kind}
              placeholder={input.placeholder}
              value={local[input.name] ?? ""}
              min={input.min}
              max={input.max}
              style={style}
              onChange={(e) => onText(input.name, e.target.value)}
            />
          </label>
        );
      })}
      <Link className="btn btn-secondary" href={resetHref ?? action} scroll={false}>
        {resetLabel}
      </Link>
    </form>
  );
}
