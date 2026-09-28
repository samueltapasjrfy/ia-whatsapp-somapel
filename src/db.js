import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });
const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS leads (
    id            TEXT PRIMARY KEY,          -- jid do WhatsApp ou id da sessão CLI
    phone         TEXT,
    push_name     TEXT,
    origin        TEXT DEFAULT 'inbound',    -- inbound | outbound
    stage         TEXT DEFAULT 'novo',       -- novo | em_qualificacao | qualificado | encaminhado | nutrir | desqualificado
    score         INTEGER DEFAULT 0,
    temperature   TEXT DEFAULT 'frio',       -- frio | morno | quente
    data          TEXT DEFAULT '{}',         -- campos de qualificação (JSON)
    summary       TEXT,
    paused_until  INTEGER DEFAULT 0,
    handed_off_at INTEGER,
    created_at    INTEGER,
    updated_at    INTEGER
  );
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id    TEXT NOT NULL,
    role       TEXT NOT NULL,                -- user | assistant | human | system
    content    TEXT NOT NULL,
    created_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages(lead_id, id);
`);

const now = () => Date.now();

export function getLead(id) {
  const row = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  return row ? { ...row, data: JSON.parse(row.data || '{}') } : null;
}

export function upsertLead(id, { phone, pushName } = {}) {
  const existing = getLead(id);
  if (existing) {
    if (pushName && pushName !== existing.push_name) {
      db.prepare('UPDATE leads SET push_name = ?, updated_at = ? WHERE id = ?').run(pushName, now(), id);
    }
    return getLead(id);
  }
  db.prepare('INSERT INTO leads (id, phone, push_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, phone || null, pushName || null, now(), now());
  return getLead(id);
}

export function updateLead(id, fields) {
  const cols = Object.keys(fields);
  if (!cols.length) return getLead(id);
  const values = cols.map((c) => (c === 'data' ? JSON.stringify(fields[c]) : fields[c]));
  db.prepare(`UPDATE leads SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...values, now(), id);
  return getLead(id);
}

export function addMessage(leadId, role, content) {
  db.prepare('INSERT INTO messages (lead_id, role, content, created_at) VALUES (?, ?, ?, ?)')
    .run(leadId, role, content, now());
}

export function getHistory(leadId, limit) {
  return db.prepare('SELECT role, content, created_at FROM messages WHERE lead_id = ? ORDER BY id DESC LIMIT ?')
    .all(leadId, limit)
    .reverse();
}

export function listLeads() {
  return db.prepare('SELECT * FROM leads ORDER BY score DESC, updated_at DESC').all()
    .map((r) => ({ ...r, data: JSON.parse(r.data || '{}') }));
}

export function resetLead(id) {
  db.prepare('DELETE FROM messages WHERE lead_id = ?').run(id);
  db.prepare('DELETE FROM leads WHERE id = ?').run(id);
}
