const DAY_MS = 86_400_000;

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

function zonedDateTimeToUtc(parts, timeZone) {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0);
  let guess = target;
  for (let index = 0; index < 3; index += 1) {
    const shown = zonedParts(new Date(guess), timeZone);
    const shownUtc = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second);
    guess += target - shownUtc;
  }
  return new Date(guess);
}

function startOfZonedDay(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  return zonedDateTimeToUtc({ year: parts.year, month: parts.month, day: parts.day }, timeZone);
}

export function resolveRange(searchParams, now = new Date(), timeZone = 'Asia/Shanghai') {
  const preset = searchParams.get('range') || '7d';
  const end = new Date(now);
  let start;
  if (preset === 'today') start = startOfZonedDay(now, timeZone);
  else if (preset === '30d') start = new Date(end.getTime() - 30 * DAY_MS);
  else if (preset === 'month') {
    const parts = zonedParts(now, timeZone);
    start = zonedDateTimeToUtc({ year: parts.year, month: parts.month, day: 1 }, timeZone);
  }
  else if (preset === 'custom') {
    start = new Date(searchParams.get('start') || '');
    const customEnd = new Date(searchParams.get('end') || '');
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(customEnd.getTime()) || start >= customEnd) {
      throw Object.assign(new Error('invalid custom date range'), { statusCode: 400 });
    }
    return { preset, start, end: customEnd };
  } else {
    start = new Date(end.getTime() - 7 * DAY_MS);
  }
  return { preset, start, end };
}

export function pagination(searchParams) {
  const rawPage = searchParams.get('page') || '1';
  const rawPageSize = searchParams.get('page_size') || '20';
  const page = Number.parseInt(rawPage, 10);
  const pageSize = Number.parseInt(rawPageSize, 10);
  if (!/^\d+$/.test(rawPage) || !Number.isSafeInteger(page) || page < 1) {
    throw Object.assign(new Error('invalid page'), { statusCode: 400 });
  }
  if (!/^\d+$/.test(rawPageSize) || !Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw Object.assign(new Error('invalid page_size'), { statusCode: 400 });
  }
  const boundedPageSize = Math.min(100, Math.max(10, pageSize));
  const offset = (page - 1) * boundedPageSize;
  if (!Number.isSafeInteger(offset)) {
    throw Object.assign(new Error('page is too large'), { statusCode: 400 });
  }
  return { page, pageSize: boundedPageSize, offset };
}

export function searchTerm(searchParams) {
  return (searchParams.get('search') || '').trim().slice(0, 120);
}
