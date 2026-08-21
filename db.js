// db.js
// Persistencia real con SQLite — node:sqlite viene incluido en Node.js 22.5+,
// no requiere instalar ningún paquete externo. El esquema es la versión
// implementada de /docs/schema.sql que ya existía como diseño.
//
// Multi-tenant por diseño: cada tabla de negocio cuelga de user_id (el
// astrólogo dueño de esos datos) — esto es lo que permite que mañana cada
// astrólogo tenga su propia cuenta con sus propios clientes, sin mezclarse.

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "astromundo.db");

// Si la carpeta destino (ej. el volumen /data) todavía no existe o no está
// montada cuando arranca el proceso, SQLite falla con "unable to open
// database file" — esto se asegura de que exista antes de intentar abrirla.
const dbDir = path.dirname(DB_PATH);
try { fs.mkdirSync(dbDir, { recursive: true }); } catch (e) { /* ya existe, o no hace falta (ej. carpeta actual) */ }

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  name TEXT NOT NULL,
  professional_name TEXT,
  plan TEXT NOT NULL DEFAULT 'gratis',
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- Límite de intentos de login (Fase 0 del plan de seguridad). identifier es
-- el email en minúsculas — no la IP, porque acá no hay proxy configurado
-- para leerla de forma confiable, y por email alcanza para frenar fuerza
-- bruta contra una cuenta puntual.
CREATE TABLE IF NOT EXISTS login_attempts (
  identifier TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL DEFAULT (datetime('now')),
  blocked_until TEXT
);

-- Registro de eventos de seguridad (Fase 1 del plan). user_id puede quedar
-- en null (ON DELETE SET NULL, no CASCADE) — si alguien borra su cuenta,
-- el registro de que hubo, por ejemplo, un intento de login sospechoso
-- sigue teniendo valor para revisar más adelante; el email queda como
-- referencia aunque la cuenta ya no exista.
CREATE TABLE IF NOT EXISTS security_events (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  email TEXT,
  event_type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Verificación en dos pasos (Fase 2, ítem 13). totp_secret se guarda ya al
-- pedir el alta (para poder mostrar el código QR), pero totp_enabled sigue
-- en 0 hasta que la persona confirme con un código real generado por su
-- app — así una activación a medio hacer nunca deja a nadie bloqueado del
-- login. login_2fa_pending es la sesión CORTA (5 minutos) que existe entre
-- "contraseña correcta" y "código de la app correcto" — nunca es una
-- sesión real, no sirve para nada más que completar el segundo paso.
CREATE TABLE IF NOT EXISTS login_2fa_pending (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  date TEXT,
  time TEXT,
  time_unknown INTEGER NOT NULL DEFAULT 0,
  place TEXT,
  lat REAL,
  lng REAL,
  tz TEXT,
  tz_name TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS charts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'natal',
  positions_json TEXT NOT NULL,
  house_cusps_json TEXT NOT NULL,
  aspects_json TEXT NOT NULL,
  asc_lon REAL,
  mc_lon REAL,
  houses_reliable INTEGER NOT NULL DEFAULT 1,
  engine TEXT,
  interp_generated INTEGER NOT NULL DEFAULT 0,
  interp_text TEXT,
  solar_return_year INTEGER,
  solar_return_moment TEXT,
  solar_return_place TEXT,
  lunar_return_moment TEXT,
  lunar_return_place TEXT,
  transit_date TEXT,
  transit_natal_chart_id TEXT,
  progressed_target_date TEXT,
  progressed_moment TEXT,
  house_system TEXT DEFAULT 'equal',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  modality TEXT NOT NULL DEFAULT 'video',
  duration_minutes INTEGER,
  price_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'ARS',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
  chart_id TEXT REFERENCES charts(id) ON DELETE SET NULL,
  day INTEGER NOT NULL,
  time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL,
  commission_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'ARS',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payment_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mp_access_token TEXT,
  mp_public_key TEXT,
  mp_webhook_secret TEXT,
  paypal_client_id TEXT,
  paypal_client_secret TEXT,
  paypal_mode TEXT NOT NULL DEFAULT 'sandbox',
  bank_name TEXT,
  bank_alias TEXT,
  bank_cbu TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Un "order" es un intento de compra desde la página pública de reserva —
-- se crea en estado pending y pasa a approved recién cuando el webhook del
-- proveedor (o la confirmación manual de transferencia) lo confirma. No se
-- mezcla con payments (el historial ya confirmado) hasta ese momento.
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
  client_name TEXT NOT NULL,
  client_email TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'ARS',
  payment_method TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  provider_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Una sinastría compara dos cartas de clientes DISTINTOS del mismo
-- astrólogo — por eso tiene dos client_id en vez de uno, a diferencia de
-- charts (que siempre pertenece a un solo cliente).
CREATE TABLE IF NOT EXISTS synastries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_a_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  client_b_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  positions_a_json TEXT NOT NULL,
  positions_b_json TEXT NOT NULL,
  aspects_json TEXT NOT NULL,
  interp_text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Suscripción del ASTRÓLOGO hacia el DUEÑO de la plataforma (distinto de
-- payments, que es lo que el astrólogo cobra a SUS clientes). Acá el
-- comprador es el astrólogo, y el que recibe la plata sos vos.
CREATE TABLE IF NOT EXISTS platform_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  provider_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_clients_user ON clients(user_id);
CREATE INDEX IF NOT EXISTS idx_charts_user ON charts(user_id);
CREATE INDEX IF NOT EXISTS idx_charts_client ON charts(client_id);
CREATE INDEX IF NOT EXISTS idx_appt_user ON appointments(user_id);
CREATE INDEX IF NOT EXISTS idx_services_user ON services(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_synastries_user ON synastries(user_id);
CREATE INDEX IF NOT EXISTS idx_platform_subs_user ON platform_subscriptions(user_id);

`);

// "CREATE TABLE IF NOT EXISTS" no le agrega columnas nuevas a una tabla que
// ya existía de antes (ej. si el volumen persistente ya tenía datos con el
// esquema viejo, sin estas columnas) — este bloque las agrega a mano si
// hace falta, sin tocar los datos que ya había.
const migrations = [
  "ALTER TABLE charts ADD COLUMN solar_return_year INTEGER",
  "ALTER TABLE charts ADD COLUMN solar_return_moment TEXT",
  "ALTER TABLE charts ADD COLUMN solar_return_place TEXT",
  "ALTER TABLE charts ADD COLUMN transit_date TEXT",
  "ALTER TABLE charts ADD COLUMN transit_natal_chart_id TEXT",
  "ALTER TABLE users ADD COLUMN professional_name TEXT",
  "ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE clients ADD COLUMN notes TEXT",
  "ALTER TABLE charts ADD COLUMN lunar_return_moment TEXT",
  "ALTER TABLE charts ADD COLUMN lunar_return_place TEXT",
  "ALTER TABLE charts ADD COLUMN house_system TEXT DEFAULT 'equal'",
  "ALTER TABLE users ADD COLUMN photo_url TEXT",
  "ALTER TABLE users ADD COLUMN bio TEXT",
  "ALTER TABLE users ADD COLUMN totp_secret TEXT",
  "ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE charts ADD COLUMN progressed_target_date TEXT",
  "ALTER TABLE charts ADD COLUMN progressed_moment TEXT",
  "ALTER TABLE appointments ADD COLUMN date TEXT",
  "ALTER TABLE synastries ADD COLUMN asc_lon_a REAL",
  "ALTER TABLE synastries ADD COLUMN asc_lon_b REAL",
  "ALTER TABLE services ADD COLUMN category TEXT",
  "ALTER TABLE users ADD COLUMN signup_source TEXT",
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (e) { /* la columna ya existe — nada que hacer */ }
}

export function newId(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
