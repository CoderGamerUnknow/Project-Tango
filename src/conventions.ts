/**
 * Conventions shared by more than one analytics module.
 *
 * These are rules every module follows rather than logic any of them owns, so
 * they get one home instead of a copy per module: rounding precision (where the
 * number of decimal places is part of the contract the schemas check) and the
 * rule that a blank string is an absent input rather than a value.
 *
 * They were module-private helpers inside the old `analytics.ts`. Splitting that
 * file forced a choice — duplicate each helper, or give the shared ones an owner
 * — and duplication is exactly the two-owners problem `DEMAND_WEIGHT` had, where
 * one copy silently went stale. One module, two documented rules, no copies.
 */

/** Round to 1 decimal place, for days of cover and percentage change. */
export const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Round to 2 decimal places, for currency. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Round to 3 decimal places, for velocity rates. */
export const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * A string input trimmed, with blank treated as absent.
 *
 * Both filter APIs — catalog filters and order lookup — accept optional strings,
 * and a caller that sends `"   "` meant "no filter", not "match the empty
 * string". Normalising here is what lets those tools echo `null` for a blank
 * argument instead of reporting a filter that matched everything or nothing.
 */
export const trimmed = (value: string | undefined): string | undefined => {
  const clean = value?.trim();
  return clean ? clean : undefined;
};
