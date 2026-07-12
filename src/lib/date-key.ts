export const DATE_KEY_PATTERN = /^\d{8}$/;

export type DateKey = string & { readonly __dateKey: unique symbol };

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }

  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isDateKey(value: unknown): value is DateKey {
  if (typeof value !== "string" || !DATE_KEY_PATTERN.test(value)) {
    return false;
  }

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));

  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export function assertDateKey(value: unknown, fieldName = "dateKey"): asserts value is DateKey {
  if (!isDateKey(value)) {
    throw new TypeError(`${fieldName} must be a valid date in YYYYMMDD format`);
  }
}

export function normalizeDateKey(value: string, fieldName = "dateKey"): DateKey {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.replaceAll("-", "") : value;
  assertDateKey(normalized, fieldName);
  return normalized;
}

export function formatDateKey(date: Date): DateKey {
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("date must be valid");
  }

  const value = [
    date.getFullYear().toString().padStart(4, "0"),
    (date.getMonth() + 1).toString().padStart(2, "0"),
    date.getDate().toString().padStart(2, "0"),
  ].join("");

  assertDateKey(value);
  return value;
}

export function parseDateKey(value: string): Date {
  const dateKey = normalizeDateKey(value);
  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(4, 6));
  const day = Number(dateKey.slice(6, 8));
  const date = new Date(0);

  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  return date;
}
