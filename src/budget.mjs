/**
 * Budgets (R6): spend today, this week and this month against limits you set, with an exit code for scripts and CI. The periods are the
 * local calendar: today from midnight, the week from Monday midnight, the month from the 1st. Dollars are API-equivalent at list price
 * (what the tokens would cost at public prices), so on a subscription a budget is a pace limit and not a bill.
 */
export const PERIODS = [["dailyUSD", "today"], ["weeklyUSD", "this week"], ["monthlyUSD", "this month"]];

export function periodStarts(now = Date.now()) {
  const d = new Date(now);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const mondayOffset = (d.getDay() + 6) % 7;
  return { dailyUSD: day, weeklyUSD: new Date(d.getFullYear(), d.getMonth(), d.getDate() - mondayOffset).getTime(), monthlyUSD: new Date(d.getFullYear(), d.getMonth(), 1).getTime() };
}

export function checkBudgets(/** @type {any} */ events, budgets = /** @type {Record<string, number | undefined>} */ ({}), now = Date.now()) {
  const starts = periodStarts(now);
  const rows = PERIODS.map(([key, label]) => {
    const spent = events.reduce((/** @type {number} */ n, /** @type {any} */ e) => (e.t >= /** @type {Record<string, number>} */ (starts)[key] && e.t <= now ? n + e.cost : n), 0);
    const limit = budgets[key] ?? null;
    return { key, label, spentUSD: Math.round(spent * 100) / 100, limitUSD: limit, pct: limit ? Math.round((spent / limit) * 100) : null, over: limit != null && spent > limit };
  });
  return { rows, over: rows.filter((r) => r.over).map((r) => r.label), anySet: rows.some((r) => r.limitUSD != null) };
}
