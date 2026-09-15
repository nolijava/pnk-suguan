export function FormField({
  label,
  name,
  type = "text",
  required,
  defaultValue,
  placeholder,
  min,
  max,
  step,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  defaultValue?: string | number | null;
  placeholder?: string;
  min?: string | number;
  max?: string | number;
  step?: string | number;
}) {
  return (
    <label className="field">
      <span>
        {label}
        {required ? <em aria-hidden="true"> *</em> : null}
      </span>
      <input
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue ?? undefined}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
      />
    </label>
  );
}

export function SelectField({
  label,
  name,
  options,
  required,
  defaultValue,
  includeBlank,
}: {
  label: string;
  name: string;
  options: { value: string; label: string }[];
  required?: boolean;
  defaultValue?: string | null;
  includeBlank?: string;
}) {
  return (
    <label className="field">
      <span>
        {label}
        {required ? <em aria-hidden="true"> *</em> : null}
      </span>
      <select name={name} required={required} defaultValue={defaultValue ?? ""}>
        {includeBlank ? <option value="">{includeBlank}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function TextAreaField({
  label,
  name,
  required,
  defaultValue,
  rows = 3,
}: {
  label: string;
  name: string;
  required?: boolean;
  defaultValue?: string | null;
  rows?: number;
}) {
  return (
    <label className="field">
      <span>
        {label}
        {required ? <em aria-hidden="true"> *</em> : null}
      </span>
      <textarea name={name} rows={rows} required={required} defaultValue={defaultValue ?? undefined} />
    </label>
  );
}
