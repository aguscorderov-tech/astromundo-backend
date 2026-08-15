// crypto-secrets.js
// Cifrado en reposo (Fase 2, ítem 16) para las credenciales de pago de cada
// astrólogo — AES-256-GCM con node:crypto nativo, sin librerías externas.
// GCM da cifrado Y autenticación: si alguien modifica el valor cifrado
// guardado en la base (no solo si lo lee), descifrar() lo detecta y falla,
// no descifra cualquier cosa en silencio.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIJO = "enc:v1:";
const IV_BYTES = 12; // estándar para GCM
const AUTHTAG_BYTES = 16;

let claveCache = null;

function obtenerClave() {
  if (claveCache) return claveCache;
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "Falta la variable de entorno ENCRYPTION_KEY. Generá una con: " +
      `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
    );
  }
  const buf = Buffer.from(raw, "hex");
  if (buf.length !== 32) {
    throw new Error("ENCRYPTION_KEY tiene que ser exactamente 32 bytes en hexadecimal (64 caracteres).");
  }
  claveCache = buf;
  return buf;
}

/** Cifra un texto. null/undefined/"" pasan tal cual — no hay nada que
    cifrar, y así los campos vacíos de payment_settings siguen funcionando
    igual que antes. */
export function cifrar(texto) {
  if (texto === null || texto === undefined || texto === "") return texto;
  const clave = obtenerClave();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", clave, iv);
  const cifrado = Buffer.concat([cipher.update(String(texto), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return PREFIJO + Buffer.concat([iv, authTag, cifrado]).toString("base64");
}

/** Descifra. Si el valor NO tiene el prefijo esperado, se asume que es un
    dato viejo guardado antes de este cambio (texto plano) y se devuelve
    tal cual — así los datos ya guardados de astrólogos reales siguen
    funcionando sin necesitar una migración aparte; se cifran solos la
    próxima vez que ese astrólogo actualice sus credenciales. */
export function descifrar(valor) {
  if (valor === null || valor === undefined || valor === "") return valor;
  if (!String(valor).startsWith(PREFIJO)) return valor;
  const clave = obtenerClave();
  const datos = Buffer.from(String(valor).slice(PREFIJO.length), "base64");
  const iv = datos.subarray(0, IV_BYTES);
  const authTag = datos.subarray(IV_BYTES, IV_BYTES + AUTHTAG_BYTES);
  const cifrado = datos.subarray(IV_BYTES + AUTHTAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", clave, iv);
  decipher.setAuthTag(authTag);
  const descifrado = Buffer.concat([decipher.update(cifrado), decipher.final()]);
  return descifrado.toString("utf8");
}
