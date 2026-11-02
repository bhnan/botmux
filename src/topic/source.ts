/** A durable message boundary, never a provider's expiring pagination token. */
export interface TopicCursor { time: string; ids: string[] }
export interface TopicMessage { id: string; createdAt: string; text: string; deleted?: boolean }

export function normalizeTime(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error('invalid_source_time');
  }
  return new Date(value).toISOString();
}

export function encodeCursor(cursor: TopicCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, time: normalizeTime(cursor.time), ids: [...new Set(cursor.ids)].sort() })).toString('base64url');
}

export function decodeCursor(value: string): TopicCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (parsed.v !== 1 || !Array.isArray(parsed.ids) || !parsed.ids.every((id: unknown) => typeof id === 'string' && id.length > 0)) throw new Error();
    return { time: normalizeTime(parsed.time), ids: [...new Set<string>(parsed.ids)] };
  } catch { throw new Error('invalid_source_cursor'); }
}

export function coversCursor(next: TopicCursor, previous: TopicCursor): boolean {
  const a = Date.parse(next.time), b = Date.parse(previous.time);
  return a > b || (a === b && previous.ids.every(id => next.ids.includes(id)));
}
