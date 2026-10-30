const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Parsed by hand: `new Date("1960-03-05")` is UTC midnight, which shows
// as March 4 in timezones west of Greenwich.
function parts(iso: string): [number, number, number] | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth) return null;
  return [y, mo, d];
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && parts(value) !== null;
}

export function toIsoDate(year: number, month: number, day: number): string | null {
  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isIsoDate(iso) ? iso : null;
}

export function yearOf(iso: string): number | null {
  return parts(iso)?.[0] ?? null;
}

// "1960-03-05" -> "5 Mar 1960"
export function formatDate(iso: string): string {
  const p = parts(iso);
  return p ? `${p[2]} ${MONTHS[p[1] - 1]} ${p[0]}` : iso;
}

export function birthLabel(p: { birthYear?: number | null; birthDate?: string | null }): string | null {
  if (p.birthDate && isIsoDate(p.birthDate)) return formatDate(p.birthDate);
  return p.birthYear ? String(p.birthYear) : null;
}

const MONTH_INDEX: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

export function monthNumber(word: string): number | null {
  return MONTH_INDEX[word.toLowerCase().replace(/\.$/, "")] ?? null;
}
