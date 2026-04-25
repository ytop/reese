import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const storageDir = join(homedir(), '.reese/workspace/calendar');
const storagePath = join(storageDir, 'calendar.db');

if (!existsSync(storageDir)) {
  mkdirSync(storageDir, { recursive: true });
}

const db = new Database(storagePath);

db.run(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    date TEXT NOT NULL,
    description TEXT
  )
`);

export interface Event {
  id: string;
  title: string;
  date: string;
  description?: string;
}

export const create = (title: string, date: string, description?: string): Event => {
  const query = db.query("INSERT INTO events (title, date, description) VALUES (?, ?, ?) RETURNING *");
  const row = query.get(title, date, description) as any;
  return { ...row, id: row.id.toString() };
};

export const read = (id?: string): Event | Event[] | null => {
  if (id) {
    const query = db.query("SELECT * FROM events WHERE id = ?");
    const row = query.get(id) as any;
    return row ? { ...row, id: row.id.toString() } : null;
  }
  const query = db.query("SELECT * FROM events ORDER BY date ASC");
  return (query.all() as any[]).map(e => ({ ...e, id: e.id.toString() }));
};

export const readRange = (start: string, end: string): Event[] => {
  const query = db.query("SELECT * FROM events WHERE date BETWEEN ? AND ? ORDER BY date ASC");
  return (query.all(start, end) as any[]).map(e => ({ ...e, id: e.id.toString() }));
};

export const update = (id: string, updates: Partial<Omit<Event, 'id'>>): Event | null => {
  const fields = Object.keys(updates);
  if (fields.length === 0) return read(id) as Event;

  const setClause = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => (updates as any)[f]);
  values.push(id);

  const result = db.run(`UPDATE events SET ${setClause} WHERE id = ?`, values);
  if (result.changes === 0) return null;
  
  return read(id) as Event;
};

export const remove = (id: string): boolean => {
  const result = db.run("DELETE FROM events WHERE id = ?", [id]);
  return result.changes > 0;
};
