import Link from "next/link";

export interface FilterDef {
  name: string;
  label: string;
  options: { value: string; label: string }[];
}

/** GET-form toolbar: search box, filter selects, apply + reset. */
export function Toolbar({
  action,
  searchPlaceholder,
  searchValue,
  filters,
  values,
}: {
  action: string;
  searchPlaceholder: string;
  searchValue?: string;
  filters: FilterDef[];
  values: Record<string, string | undefined>;
}) {
  return (
    <form method="get" action={action} className="toolbar">
      <input type="search" name="q" placeholder={searchPlaceholder} defaultValue={searchValue ?? ""} />
      {filters.map((f) => (
        <label key={f.name} className="toolbar-filter">
          <span>{f.label}</span>
          <select name={f.name} defaultValue={values[f.name] ?? ""}>
            <option value="">All</option>
            {f.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      ))}
      <button type="submit" className="btn btn-primary">Apply</button>
      <Link href={action} className="btn btn-secondary">Reset</Link>
    </form>
  );
}
