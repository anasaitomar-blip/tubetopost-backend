// store.js — Persistance simple par fichier JSON.
// REMPLACER par une vraie base (Postgres, etc.) en production.
// Clé = email (minuscules). Valeur = { email, customerId, subscriptionId, status, currentPeriodEnd, cancelAtPeriodEnd }.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, 'data', 'subscriptions.json');

function ensure() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, '{}');
}
function readAll() {
  ensure();
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8') || '{}'); }
  catch { return {}; }
}
function writeAll(obj) {
  ensure();
  fs.writeFileSync(FILE, JSON.stringify(obj, null, 2));
}

const norm = (email) => String(email || '').trim().toLowerCase();

export function getByEmail(email) {
  return readAll()[norm(email)] || null;
}

export function getByCustomerId(customerId) {
  const all = readAll();
  return Object.values(all).find((r) => r.customerId === customerId) || null;
}

export function upsert(email, patch) {
  const all = readAll();
  const key = norm(email);
  all[key] = { ...(all[key] || {}), email: key, ...patch };
  writeAll(all);
  return all[key];
}

export function updateByCustomerId(customerId, patch) {
  const all = readAll();
  const entry = Object.entries(all).find(([, r]) => r.customerId === customerId);
  if (!entry) return null;
  const [key] = entry;
  all[key] = { ...all[key], ...patch };
  writeAll(all);
  return all[key];
}
