/** Calendar hook (real India/US/Singapore calendars arrive in M7). Dates are 'YYYY-MM-DD' strings. */
export interface Calendar {
  isBusinessDay(date: string): boolean;
  addBusinessDays(date: string, n: number): string;
}
const dayMs = 86_400_000;
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / dayMs);
export const addDays = (date: string, n: number): string => new Date(Date.parse(date + 'T00:00:00Z') + n * dayMs).toISOString().slice(0, 10);

/** Weekends only; holidays are added with the real calendars. */
export const WeekdayCalendar: Calendar = {
  isBusinessDay: (d) => { const w = new Date(d + 'T00:00:00Z').getUTCDay(); return w !== 0 && w !== 6; },
  addBusinessDays(date, n) { let d = date, left = n; while (left > 0) { d = addDays(d, 1); if (this.isBusinessDay(d)) left--; } return d; },
};

/** Tenor in days from funding to due date, plus grace days. */
export const tenorDays = (fundingDate: string, dueDate: string, graceDays = 0) => daysBetween(fundingDate, dueDate) + graceDays;
