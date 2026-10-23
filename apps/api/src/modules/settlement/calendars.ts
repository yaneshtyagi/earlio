/**
 * Holiday calendars for India, the US and Singapore (XB-9). Seeded for 2026–2027 from commonly published dates and marked
 * VERIFY: confirm with the authorised dealer bank or a calendar provider before any production use.
 */
export const HOLIDAYS_VERIFY = true;
export const HOLIDAYS: Record<string, Record<string, string>> = {
  IN: {
    '2026-11-09': 'Diwali (Laxmi Puja) — observed', '2026-11-24': 'Guru Nanak Jayanti', '2026-12-25': 'Christmas Day',
    '2027-01-26': 'Republic Day', '2027-03-22': 'Holi', '2027-03-26': 'Good Friday',
  },
  US: {
    '2026-11-11': 'Veterans Day', '2026-11-26': 'Thanksgiving Day', '2026-12-25': 'Christmas Day', '2027-01-01': "New Year's Day",
    '2027-01-18': 'Martin Luther King Jr. Day', '2027-02-15': "Presidents' Day",
  },
  SG: {
    '2026-11-09': 'Deepavali — observed', '2026-12-25': 'Christmas Day', '2027-01-01': "New Year's Day", '2027-02-08': 'Chinese New Year — observed', '2027-03-26': 'Good Friday',
  },
};

const day = (d: string) => new Date(d + 'T00:00:00Z');
const iso = (d: Date) => d.toISOString().slice(0, 10);
export const addCalendarDays = (d: string, n: number) => iso(new Date(day(d).getTime() + n * 86_400_000));

export function isBusinessDay(country: string, date: string): boolean {
  const wd = day(date).getUTCDay();
  return wd !== 0 && wd !== 6 && !HOLIDAYS[country]?.[date];
}
export function nextBusinessDay(country: string, date: string): string {
  let d = addCalendarDays(date, 1);
  while (!isBusinessDay(country, d)) d = addCalendarDays(d, 1);
  return d;
}
export function addBusinessDays(country: string, date: string, n: number): string {
  let d = date;
  for (let i = 0; i < n; i++) d = nextBusinessDay(country, d);
  return d;
}

/** Wall-clock date and HH:MM in an IANA time zone. */
export function localParts(at: Date, timeZone: string): { date: string; time: string } {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/**
 * Value date for a payment instruction: instructions after the bank's cut-off, or on a non-business day, count from the next
 * business day. `settlementDays` business days are then added. `cutoffMissed` is true when the instruction was pushed back.
 */
export function valueDateFor(a: { country: string; timeZone: string; cutoff: string; now: Date; settlementDays: number }): { valueDate: string; cutoffMissed: boolean; localDate: string } {
  const { date, time } = localParts(a.now, a.timeZone);
  let effective = date, missed = false;
  if (!isBusinessDay(a.country, date)) { effective = nextBusinessDay(a.country, date); missed = true; }
  else if (time > a.cutoff) { effective = nextBusinessDay(a.country, date); missed = true; }
  return { valueDate: addBusinessDays(a.country, effective, a.settlementDays), cutoffMissed: missed, localDate: date };
}
