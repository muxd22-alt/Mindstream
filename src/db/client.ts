// Thin typed wrapper over the D1 binding. All SQL lives in repo.ts.

export type SqlValue = string | number | null;

export interface Row {
  [key: string]: unknown;
}

export class DbError extends Error {
  constructor(message: string, readonly sql: string, readonly detail?: unknown) {
    super(message);
    this.name = 'DbError';
  }
}

export class Db {
  constructor(private readonly d1: D1Database) {}

  prepare(sql: string): D1PreparedStatement {
    return this.d1.prepare(sql);
  }

  /** Coerce undefined → null so D1 never sees an unsupported binding. */
  static bind(values: unknown[]): SqlValue[] {
    return values.map((v) => {
      if (v === undefined || v === null) return null;
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (typeof v === 'number') return Number.isFinite(v) ? v : null;
      if (typeof v === 'string') return v;
      return JSON.stringify(v);
    });
  }

  async all<T = Row>(sql: string, ...values: unknown[]): Promise<T[]> {
    try {
      const res = await this.d1.prepare(sql).bind(...Db.bind(values)).all<T>();
      return res.results ?? [];
    } catch (e) {
      throw new DbError(`SQL failed: ${firstLine(e)}`, sql, e);
    }
  }

  async first<T = Row>(sql: string, ...values: unknown[]): Promise<T | null> {
    const rows = await this.all<T>(sql, ...values);
    return rows[0] ?? null;
  }

  async run(sql: string, ...values: unknown[]): Promise<void> {
    try {
      await this.d1.prepare(sql).bind(...Db.bind(values)).run();
    } catch (e) {
      throw new DbError(`SQL failed: ${firstLine(e)}`, sql, e);
    }
  }

  /** Atomic-ish multi-statement write. D1 batch is a single transaction. */
  async batch(statements: { sql: string; values: unknown[] }[]): Promise<void> {
    if (!statements.length) return;
    try {
      await this.d1.batch(statements.map((s) => this.d1.prepare(s.sql).bind(...Db.bind(s.values))));
    } catch (e) {
      throw new DbError(`Batch failed: ${firstLine(e)}`, statements[0]?.sql ?? '', e);
    }
  }
}

function firstLine(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split('\n')[0].slice(0, 300);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix = ''): string {
  const id = crypto.randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  if (typeof raw !== 'string') return raw as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
