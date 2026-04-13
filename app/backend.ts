import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DIR = join(homedir(), '.reese/workspace/calendar');
const DATA_FILE = join(DIR, 'events.json');

export interface Event {
  id: string;
  title: string;
  date: string;
  description?: string;
}

const load = (): Event[] => existsSync(DATA_FILE) ? JSON.parse(readFileSync(DATA_FILE, 'utf-8')) : [];
const save = (events: Event[]) => {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(events, null, 2));
};

export const create = (title: string, date: string, description?: string): Event => {
  const events = load();
  const event: Event = { id: Date.now().toString(), title, date, description };
  events.push(event);
  save(events);
  return event;
};

export const read = (id?: string): Event | Event[] => {
  const events = load();
  return id ? events.find(e => e.id === id) || null : events;
};

export const update = (id: string, updates: Partial<Omit<Event, 'id'>>): Event | null => {
  const events = load();
  const idx = events.findIndex(e => e.id === id);
  if (idx === -1) return null;
  events[idx] = { ...events[idx], ...updates };
  save(events);
  return events[idx];
};

export const remove = (id: string): boolean => {
  const events = load();
  const filtered = events.filter(e => e.id !== id);
  if (filtered.length === events.length) return false;
  save(filtered);
  return true;
};
