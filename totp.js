// totp.js
// TOTP (RFC 6238, sobre HOTP de RFC 4226) implementado con node:crypto nativo
// -- sin librerías externas, coherente con el resto del backend ("cero
// dependencias"). Compatible con Google Authenticator, Authy, y cualquier
// app que siga el estándar.

import { createHmac, randomBytes } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PASO_SEGUNDOS = 30;
const DIGITOS = 6;

export function base32Encode(buffer) {
  let bits = 0, value = 0, output = "";
  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(str) {
  str = String(str).replace(/=+$/, "").toUpperCase().replace(/\s+/g, "");
  let bits = 0, value = 0;
  const output = [];
  for (let i = 0; i < str.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(str[i]);
    if (idx === -1) continue; // ignora caracteres invalidos en vez de romper
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

/** Genera un secreto nuevo — 160 bits (20 bytes), el tamaño estándar
    recomendado por el RFC para SHA1, codificado en base32 para que se
    pueda tipear a mano en una app autenticadora si hace falta. */
export function generarSecretoTotp() {
  return base32Encode(randomBytes(20));
}

function hotp(secretBuffer, counter) {
  const contadorBuf = Buffer.alloc(8);
  contadorBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", secretBuffer).update(contadorBuf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binCode % 10 ** DIGITOS).padStart(DIGITOS, "0");
}

export function totpEnMomento(secretBase32, epochMs, ventana = 0) {
  const secretBuffer = base32Decode(secretBase32);
  const contador = Math.floor(epochMs / 1000 / PASO_SEGUNDOS) + ventana;
  return hotp(secretBuffer, contador);
}

/** Acepta el código actual y un paso de 30s para cada lado (tolerancia a
    reloj desincronizado — la app autenticadora y el servidor no siempre
    están perfectamente sincronizados). */
export function verificarTotp(secretBase32, codigo, epochMs = Date.now()) {
  if (!codigo || !/^\d{6}$/.test(String(codigo))) return false;
  for (const ventana of [-1, 0, 1]) {
    if (totpEnMomento(secretBase32, epochMs, ventana) === String(codigo)) return true;
  }
  return false;
}

/** URI otpauth:// estándar — cualquier app autenticadora lo puede leer
    como código QR o pegado a mano. */
export function otpauthUri(secretBase32, email) {
  const label = encodeURIComponent(`Astromundo:${email}`);
  const issuer = encodeURIComponent("Astromundo");
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${issuer}&digits=${DIGITOS}&period=${PASO_SEGUNDOS}`;
}
