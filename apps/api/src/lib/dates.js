'use strict';

/**
 * Calendar days for date filters. [BUG-0055]
 *
 * A day is a day in the server's time zone (`TZ`, Asia/Kolkata in production, the zone the
 * product's users are in): a date-only `from`/`to` (YYYY-MM-DD) means that day's local start
 * and end. Filters used to parse `from` as UTC midnight — 05:30 in India, so a range lost its
 * first five and a half hours — and the ticket and audit-log filters ended `to` at 05:29 the
 * next morning. A full timestamp is used as given.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The Prisma range filter for `from`..`to` (either may be missing), or undefined for neither.
 * @param {string} [from]
 * @param {string} [to]
 * @returns {{ gte?: Date, lte?: Date } | undefined}
 */
function dayRange(from, to) {
  if (!from && !to) return undefined;
  const range = {};
  if (from) range.gte = DATE_ONLY.test(from) ? new Date(`${from}T00:00:00`) : new Date(from);
  if (to) range.lte = DATE_ONLY.test(to) ? new Date(`${to}T23:59:59.999`) : new Date(to);
  return range;
}

/**
 * The local calendar date of `d` as YYYY-MM-DD — not d.toISOString().slice(0, 10), which is
 * the UTC date (the day before, between 00:00 and 05:30 in India).
 * @param {Date} [d]
 * @returns {string}
 */
function localDateKey(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The server's IANA time zone (from TZ), for grouping by local day in SQL. Timestamps are
 * stored as UTC in `timestamp` columns, so the local day of a column is
 * DATE(col AT TIME ZONE 'UTC' AT TIME ZONE <zone>), not DATE(col). Bound as a parameter,
 * the expression differs between SELECT and GROUP BY, so such queries group by position
 * (GROUP BY 1). [BUG-0056]
 * @returns {string}
 */
function serverTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

module.exports = { dayRange, localDateKey, serverTimeZone };
