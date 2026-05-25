export function formatInTimezone(
  date: Date,
  timezone: string
): { date: string; time: string } {
  const datePart = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);

  const timePart = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);

  return { date: datePart, time: timePart };
}
