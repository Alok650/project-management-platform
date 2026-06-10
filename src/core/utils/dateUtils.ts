import dayjs from 'dayjs';

/** Format a Date as ISO 8601 string */
export const toIso = (d: Date): string => dayjs(d).toISOString();

/** Return true if date is in the past */
export const isPast = (d: Date): boolean => dayjs(d).isBefore(dayjs());

/** Return true if date is in the future */
export const isFuture = (d: Date): boolean => dayjs(d).isAfter(dayjs());

/** Add days to a date, returns new Date */
export const addDays = (d: Date, n: number): Date => dayjs(d).add(n, 'day').toDate();
