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

function zonedDateKey(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function rangeResult(preset, start, end, timeZone) {
  return {
    preset,
    start,
    end,
    dailyStart: zonedDateKey(start, timeZone),
    dailyEnd: zonedDateKey(new Date(end.getTime() - 1), timeZone),
  };
}

function dateParts(value, field) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) throw Object.assign(new Error(`invalid ${field}`), { statusCode: 400 });
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw Object.assign(new Error(`invalid ${field}`), { statusCode: 400 });
  }
  return { year, month, day };
}

function nextDateParts(parts) {
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

export function resolveRange(searchParams, now = new Date(), timeZone = 'Asia/Shanghai') {
  const preset = searchParams.get('range') || '7d';
  const end = new Date(now);
  let start;
  if (preset === 'today') start = startOfZonedDay(now, timeZone);
  else if (preset === '30d') start = startOfZonedDay(new Date(end.getTime() - 29 * DAY_MS), timeZone);
  else if (preset === 'month') {
    const parts = zonedParts(now, timeZone);
    start = zonedDateTimeToUtc({ year: parts.year, month: parts.month, day: 1 }, timeZone);
  }
  else if (preset === 'custom') {
    const customStart = dateParts(searchParams.get('start'), 'custom start date');
    const customEnd = dateParts(searchParams.get('end'), 'custom end date');
    start = zonedDateTimeToUtc(customStart, timeZone);
    const endOfRange = zonedDateTimeToUtc(nextDateParts(customEnd), timeZone);
    if (start >= endOfRange) throw Object.assign(new Error('invalid custom date range'), { statusCode: 400 });
    return rangeResult(preset, start, endOfRange, timeZone);
  } else {
    start = startOfZonedDay(new Date(end.getTime() - 6 * DAY_MS), timeZone);
  }
  return rangeResult(preset, start, end, timeZone);
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

export function filterTerm(searchParams, name, maxLength = 120) {
  return (searchParams.get(name) || '').trim().slice(0, maxLength);
}

export function listSort(searchParams, allowed, defaultSort = 'created_at') {
  const sortBy = searchParams.get('sort_by') || defaultSort;
  const sortOrder = searchParams.get('sort_order') || 'desc';
  if (!allowed.includes(sortBy)) {
    throw Object.assign(new Error('invalid sort_by'), { statusCode: 400 });
  }
  if (!['asc', 'desc'].includes(sortOrder)) {
    throw Object.assign(new Error('invalid sort_order'), { statusCode: 400 });
  }
  return { sortBy, sortOrder };
}

export function accountScope(searchParams) {
  const scope = searchParams.get('scope') || 'current';
  if (!['current', 'deleted', 'all'].includes(scope)) {
    throw Object.assign(new Error('invalid account scope'), { statusCode: 400 });
  }
  return scope;
}

export function cashScope(searchParams) {
  const scope = searchParams.get('scope') || 'all';
  if (!['all', 'recharge'].includes(scope)) {
    throw Object.assign(new Error('invalid cash scope'), { statusCode: 400 });
  }
  return scope;
}

export function userBalanceScope(searchParams) {
  const scope = searchParams.get('balance_scope') || 'all';
  if (!['all', 'reported', 'whitelist'].includes(scope)) {
    throw Object.assign(new Error('invalid user balance scope'), { statusCode: 400 });
  }
  return scope;
}
