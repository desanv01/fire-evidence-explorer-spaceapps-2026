import type { RunField } from "../../lib/evidence";

const iconPaths = {
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  table: "M3 4h18v16H3z M3 9h18M3 14h18M9 4v16",
  file: "M6 3h8l5 5v13H6z M14 3v6h5M9 13h7M9 17h7",
  search: "M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0z M15 15l6 6",
  plus: "M12 5v14M5 12h14",
  chevron: "m8 10 4 4 4-4",
  menu: "M4 6h16M4 12h16M4 18h16",
  arrow: "M12 20V4m-7 7 7-7 7 7",
  link: "M14 4h6v6M20 4l-9 9M10 5H5v14h14v-5",
  spark: "M12 2c0 6-4 8-4 12a4 4 0 0 0 8 0c0-3-2-4-3-6 1 6-7 8-7 2-2 3-3 5-3 7a9 7 0 0 0 18 0c0-5-5-9-9-15z",
};

export function Icon({ name }: { name: keyof typeof iconPaths }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={iconPaths[name]} /></svg>;
}

const fieldLabels: Record<string, string> = {
  oxygen: "O₂ mole fraction",
  nitrogen: "N₂ mole fraction",
  carbon_dioxide: "CO₂ mole fraction",
  helium: "He mole fraction",
  diameter: "Initial droplet diameter",
  extinction_diameter: "Diameter at visible extinction",
};

export function fieldLabel(key: string, fallback: string) {
  return fieldLabels[key] ?? fallback;
}

export function coordinates(locator: string) {
  const match = /^(.*), CSV row (\d+), column ([A-Z]+) \((.*?)\), (.*)$/.exec(locator);
  if (!match) return undefined;
  const [, file, row, column, header, test] = match;
  return { file, row, column, header, test, cell: column + row };
}

export type InspectSource = (runId: string, fieldKey: string, trigger: HTMLButtonElement) => void;

export function Citation({ runId, field, inspect }: {
  runId: string;
  field: RunField;
  inspect: InspectSource;
}) {
  const cell = coordinates(field.locator)?.cell;
  return <button type="button" className="citation" aria-label={`Inspect ${runId} ${field.label} source`} onClick={event => inspect(runId, field.key, event.currentTarget)}>{cell ?? "Source"} <Icon name="link" /></button>;
}

export function FieldValue({ field, showUnit = false }: { field: RunField | null | undefined; showUnit?: boolean }) {
  if (field == null || field.value === null) return <span className="muted">Unknown</span>;
  return <span className="number">{field.value}{showUnit && field.unit && <small className="unit"> {field.unit}</small>}</span>;
}
