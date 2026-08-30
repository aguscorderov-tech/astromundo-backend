// routes/community.js
// Posteos, comentarios y "me gusta" de la Comunidad -- lo único de toda
// la plataforma donde pueden publicar DOS tipos de cuenta distintos
// (astrólogo o cliente final), por eso authenticateAny() de acá abajo,
// que intenta las dos formas de sesión en vez de asumir una sola.

import { db, newId, MEDIA_DIR } from "../db.js";
import { authenticate } from "../auth.js";
import { authenticateClient } from "../auth-cliente.js";
import { HttpError } from "../http-utils.js";
import fs from "node:fs";
import path from "node:path";
import * as mp from "../providers/mercadopago.js";
import { ownerCredentials } from "./subscriptions.js";

const ESPACIOS_VALIDOS = ["anuncios", "transitos", "preguntas", "cartas"];
const TIPOS_VALIDOS = ["video", "reel", "post", "pregunta"];

/** Prueba la sesión de astrólogo primero, y si no hay, la de cliente --
    devuelve una forma común para las dos, así el resto de las rutas de
    este archivo no necesita saber cuál de las dos es. */
export function authenticateAny(req) {
  const user = authenticate(req);
  if (user) return { type: "astrologo", id: user.id, name: user.professionalName || user.name };
  const account = authenticateClient(req);
  if (account) return { type: "cliente", id: account.id, name: account.name, email: account.email };
  return null;
}

/** El dueño de la plataforma (mismo ADMIN_EMAIL que ya usa el lado de
    astrólogo en auth.js) entra gratis a la Comunidad aunque se loguee
    con una cuenta de cliente, para poder probar la app como la vería
    un cliente real, sin tener que pagarse la cuota a sí mismo. */
function esCuentaDelDueno(email) {
  const ownerEmail = (process.env.ADMIN_EMAIL || "").toLowerCase().trim();
  return !!(ownerEmail && email && email.toLowerCase().trim() === ownerEmail);
}

function requireAnyAuth(req) {
  const author = authenticateAny(req);
  if (!author) throw new HttpError(401, "No autenticado — mandá Authorization o X-Client-Auth.");
  return author;
}

const TIPOS_REACCION = ["corazon", "like", "amor", "excelente"];

function contarPost(id) {
  const filas = db.prepare("SELECT reaction_type, COUNT(*) AS n FROM community_likes WHERE post_id = ? GROUP BY reaction_type").all(id);
  const reacciones = Object.fromEntries(TIPOS_REACCION.map(t => [t, 0]));
  filas.forEach(f => { reacciones[f.reaction_type] = f.n; });
  const comentarios = db.prepare("SELECT COUNT(*) AS n FROM community_comments WHERE post_id = ?").get(id).n;
  return { reacciones, comentarios };
}

function miReaccion(autor, postId) {
  if (!autor) return null;
  const fila = db.prepare("SELECT reaction_type FROM community_likes WHERE post_id = ? AND author_type = ? AND author_id = ?").get(postId, autor.type, autor.id);
  return fila ? fila.reaction_type : null;
}

export async function listPosts(req, query) {
  const espacio = query.get("espacio");
  if (espacio && !ESPACIOS_VALIDOS.includes(espacio)) throw new HttpError(400, "Espacio inválido.");
  const posts = espacio
    ? db.prepare("SELECT * FROM community_posts WHERE space = ? ORDER BY created_at DESC LIMIT 50").all(espacio)
    : db.prepare("SELECT * FROM community_posts ORDER BY created_at DESC LIMIT 50").all();

  // Si hay una sesión (de cualquiera de los dos tipos), marcamos qué
  // reacción -- si hay alguna -- ya puso esta persona en cada posteo.
  const autor = authenticateAny(req);
  return posts.map(p => {
    const { reacciones, comentarios } = contarPost(p.id);
    return { ...p, reacciones, comentarios, miReaccion: miReaccion(autor, p.id) };
  });
}

export async function getPost(req, id) {
  const post = db.prepare("SELECT * FROM community_posts WHERE id = ?").get(id);
  if (!post) throw new HttpError(404, "No se encontró ese posteo.");
  const comentarios = db.prepare("SELECT * FROM community_comments WHERE post_id = ? ORDER BY created_at ASC").all(id);
  const { reacciones } = contarPost(id);
  const autor = authenticateAny(req);
  const meGusta = autor
    ? !!db.prepare("SELECT 1 FROM community_likes WHERE post_id = ? AND author_type = ? AND author_id = ?").get(id, autor.type, autor.id)
    : false;
  return { ...post, comentarios, reacciones, miReaccion: miReaccion(autor, id) };
}

export async function createPost(author, body) {
  const { space, postType, title, text, mediaUrl, mediaBase64, mediaMimeType } = body;
  if (!ESPACIOS_VALIDOS.includes(space)) throw new HttpError(400, "Espacio inválido.");
  if (!TIPOS_VALIDOS.includes(postType)) throw new HttpError(400, "Tipo de posteo inválido.");
  if (!title || !title.trim()) throw new HttpError(400, "Falta el título.");

  // El archivo (foto o video) se acepta en CUALQUIER tipo de posteo --
  // una Pregunta puede venir con una foto de la carta, por ejemplo. Solo
  // Video/Reel lo exigen como obligatorio.
  let mediaUrlFinal = mediaUrl || null;
  let mediaTypeFinal = null; // 'image' | 'video' | null -- para saber CÓMO
  // mostrar el archivo después, sin depender del tipo de posteo (un
  // "Posteo" común puede perfectamente traer un video adjunto).
  if (mediaBase64 && mediaMimeType) {
    const mediaId = newId("media");
    // El contenido va como archivo real al volumen persistente
    // (MEDIA_DIR) -- en la base solo queda el tipo de contenido, para
    // poder servirlo de vuelta con el Content-Type correcto.
    fs.writeFileSync(path.join(MEDIA_DIR, mediaId), Buffer.from(mediaBase64, "base64"));
    db.prepare("INSERT INTO media (id, mime_type) VALUES (?, ?)").run(mediaId, mediaMimeType);
    mediaUrlFinal = `/api/media/${mediaId}`;
    mediaTypeFinal = mediaMimeType.startsWith("video/") ? "video" : "image";
  } else if (mediaUrlFinal) {
    // Un link externo (Youtube, etc.) -- solo se ofrece para Video/Reel,
    // así que si hay un link puesto, es video.
    mediaTypeFinal = "video";
  }
  if ((postType === "video" || postType === "reel") && !mediaUrlFinal) {
    throw new HttpError(400, "Los posteos de video o reel necesitan un archivo subido o un link.");
  }

  const id = newId("post");
  db.prepare(
    `INSERT INTO community_posts (id, author_type, author_id, author_name, space, post_type, title, body, media_url, media_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, author.type, author.id, author.name, space, postType, title.trim(), text || null, mediaUrlFinal, mediaTypeFinal);
  return db.prepare("SELECT * FROM community_posts WHERE id = ?").get(id);
}

/** Arma la respuesta binaria real (no JSON) para servir de vuelta un
    archivo ya subido -- lee del disco real (MEDIA_DIR), no de la base. */
export async function getMedia(id) {
  const m = db.prepare("SELECT * FROM media WHERE id = ?").get(id);
  if (!m) throw new HttpError(404, "No se encontró ese archivo.");
  const rutaArchivo = path.join(MEDIA_DIR, id);
  if (!fs.existsSync(rutaArchivo)) throw new HttpError(404, "El archivo ya no está disponible.");
  return { mimeType: m.mime_type, buffer: fs.readFileSync(rutaArchivo) };
}

export async function createComment(author, postId, body) {
  const post = db.prepare("SELECT id FROM community_posts WHERE id = ?").get(postId);
  if (!post) throw new HttpError(404, "No se encontró ese posteo.");
  const { text } = body;
  if (!text || !text.trim()) throw new HttpError(400, "Falta el comentario.");
  const id = newId("cm");
  db.prepare(
    `INSERT INTO community_comments (id, post_id, author_type, author_id, author_name, body) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, postId, author.type, author.id, author.name, text.trim());
  return db.prepare("SELECT * FROM community_comments WHERE id = ?").get(id);
}

/** Elegir una reacción -- si ya tenía puesta esa misma, se la saca
    (toggle); si tenía otra distinta puesta, la cambia; si no tenía
    ninguna, la agrega. Solo puede haber UNA reacción por persona por
    posteo a la vez, igual que en Facebook. */
export async function toggleReaction(author, postId, tipo) {
  if (!TIPOS_REACCION.includes(tipo)) throw new HttpError(400, "Tipo de reacción inválido.");
  const post = db.prepare("SELECT id FROM community_posts WHERE id = ?").get(postId);
  if (!post) throw new HttpError(404, "No se encontró ese posteo.");
  const actual = miReaccion(author, postId);
  if (actual === tipo) {
    db.prepare("DELETE FROM community_likes WHERE post_id = ? AND author_type = ? AND author_id = ?").run(postId, author.type, author.id);
  } else if (actual) {
    db.prepare("UPDATE community_likes SET reaction_type = ? WHERE post_id = ? AND author_type = ? AND author_id = ?").run(tipo, postId, author.type, author.id);
  } else {
    db.prepare("INSERT INTO community_likes (post_id, author_type, author_id, reaction_type) VALUES (?, ?, ?, ?)").run(postId, author.type, author.id, tipo);
  }
  const { reacciones } = contarPost(postId);
  return { reacciones, miReaccion: actual === tipo ? null : tipo };
}

/** Seguir a alguien, o dejar de hacerlo si ya lo seguía (toggle). No se
    puede seguir a uno mismo. */
export async function toggleFollow(follower, followedType, followedId) {
  if (follower.type === followedType && follower.id === followedId) throw new HttpError(400, "No podés seguirte a vos mismo.");
  const yaExiste = db.prepare("SELECT 1 FROM community_follows WHERE follower_type = ? AND follower_id = ? AND followed_type = ? AND followed_id = ?").get(follower.type, follower.id, followedType, followedId);
  if (yaExiste) {
    db.prepare("DELETE FROM community_follows WHERE follower_type = ? AND follower_id = ? AND followed_type = ? AND followed_id = ?").run(follower.type, follower.id, followedType, followedId);
  } else {
    db.prepare("INSERT INTO community_follows (follower_type, follower_id, followed_type, followed_id) VALUES (?, ?, ?, ?)").run(follower.type, follower.id, followedType, followedId);
  }
  const seguidores = db.prepare("SELECT COUNT(*) AS n FROM community_follows WHERE followed_type = ? AND followed_id = ?").get(followedType, followedId).n;
  return { siguiendo: !yaExiste, seguidores };
}

function obtenerPersona(type, id) {
  if (type === "astrologo") {
    const u = db.prepare("SELECT id, name, professional_name, bio, photo_url FROM users WHERE id = ?").get(id);
    return u ? { name: u.professional_name || u.name, bio: u.bio, photoUrl: u.photo_url } : null;
  }
  if (type === "cliente") {
    const c = db.prepare("SELECT id, name, bio, photo_url FROM client_accounts WHERE id = ?").get(id);
    return c ? { name: c.name, bio: c.bio, photoUrl: c.photo_url } : null;
  }
  return null;
}

/** El perfil público de una persona (astrólogo o cliente): su info,
    cuántos la siguen, sus posteos normales y sus destacados aparte. */
export async function getProfile(req, type, id) {
  if (type !== "astrologo" && type !== "cliente") throw new HttpError(400, "Tipo de persona inválido.");
  const persona = obtenerPersona(type, id);
  if (!persona) throw new HttpError(404, "No se encontró esa persona.");

  const seguidores = db.prepare("SELECT COUNT(*) AS n FROM community_follows WHERE followed_type = ? AND followed_id = ?").get(type, id).n;
  const siguiendo = db.prepare("SELECT COUNT(*) AS n FROM community_follows WHERE follower_type = ? AND follower_id = ?").get(type, id).n;
  const posts = db.prepare("SELECT * FROM community_posts WHERE author_type = ? AND author_id = ? AND is_destacado = 0 ORDER BY created_at DESC LIMIT 30").all(type, id);
  const destacados = db.prepare("SELECT * FROM community_posts WHERE author_type = ? AND author_id = ? AND is_destacado = 1 ORDER BY created_at DESC").all(type, id);

  const autor = authenticateAny(req);
  const meSigue = autor
    ? !!db.prepare("SELECT 1 FROM community_follows WHERE follower_type = ? AND follower_id = ? AND followed_type = ? AND followed_id = ?").get(autor.type, autor.id, type, id)
    : false;

  const conReacciones = (lista) => lista.map(p => {
    const { reacciones, comentarios } = contarPost(p.id);
    return { ...p, reacciones, comentarios, miReaccion: miReaccion(autor, p.id) };
  });

  return {
    type, id, name: persona.name, bio: persona.bio, photoUrl: persona.photoUrl,
    seguidores, siguiendo, meSigue, esUnoMismo: !!(autor && autor.type === type && autor.id === id),
    posts: conReacciones(posts), destacados: conReacciones(destacados),
  };
}

/** Marca/desmarca un posteo PROPIO como destacado -- se usa desde el
    propio perfil, no se puede destacar el posteo de otra persona. */
export async function toggleDestacado(author, postId) {
  const post = db.prepare("SELECT * FROM community_posts WHERE id = ?").get(postId);
  if (!post) throw new HttpError(404, "No se encontró ese posteo.");
  if (post.author_type !== author.type || post.author_id !== author.id) throw new HttpError(403, "Solo podés destacar tus propios posteos.");
  const nuevoValor = post.is_destacado ? 0 : 1;
  db.prepare("UPDATE community_posts SET is_destacado = ? WHERE id = ?").run(nuevoValor, postId);
  return { destacado: !!nuevoValor };
}

/** Actualiza la bio y/o la foto de perfil de la cuenta logueada -- para
    astrólogo o cliente, cada uno en su propia tabla. La foto se guarda
    como archivo real (mismo mecanismo que los posteos), no como texto
    suelto en la base. */
export async function updateBioYFoto(author, body) {
  const { bio, photoBase64, photoMimeType } = body;
  let photoUrl = null;
  if (photoBase64 && photoMimeType) {
    const mediaId = newId("media");
    fs.writeFileSync(path.join(MEDIA_DIR, mediaId), Buffer.from(photoBase64, "base64"));
    db.prepare("INSERT INTO media (id, mime_type) VALUES (?, ?)").run(mediaId, photoMimeType);
    photoUrl = `/api/media/${mediaId}`;
  }
  if (author.type === "astrologo") {
    db.prepare("UPDATE users SET bio = COALESCE(?, bio), photo_url = COALESCE(?, photo_url) WHERE id = ?").run(bio ?? null, photoUrl, author.id);
  } else {
    db.prepare("UPDATE client_accounts SET bio = COALESCE(?, bio), photo_url = COALESCE(?, photo_url) WHERE id = ?").run(bio ?? null, photoUrl, author.id);
  }
  return obtenerPersona(author.type, author.id);
}

/** Borra un posteo PROPIO -- comentarios y reacciones se van solos por
    el ON DELETE CASCADE de la base. El archivo subido (si tenía) se
    borra del disco a mano, porque eso la base no lo hace sola. */
export async function deletePost(author, postId) {
  const post = db.prepare("SELECT * FROM community_posts WHERE id = ?").get(postId);
  if (!post) throw new HttpError(404, "No se encontró ese posteo.");
  if (post.author_type !== author.type || post.author_id !== author.id) throw new HttpError(403, "Solo podés borrar tus propios posteos.");
  if (post.media_url && post.media_url.startsWith("/api/media/")) {
    const mediaId = post.media_url.replace("/api/media/", "");
    const rutaArchivo = path.join(MEDIA_DIR, mediaId);
    try { fs.unlinkSync(rutaArchivo); } catch (e) { /* si ya no está, no pasa nada */ }
    db.prepare("DELETE FROM media WHERE id = ?").run(mediaId);
  }
  db.prepare("DELETE FROM community_posts WHERE id = ?").run(postId);
  return { deleted: true };
}

/** Edita el título y/o el texto de un posteo PROPIO -- el archivo
    adjunto (si tiene) no se puede cambiar por acá, para mantenerlo
    simple; si hace falta cambiar el archivo, se borra el posteo y se
    crea uno nuevo. */
export async function editPost(author, postId, body) {
  const post = db.prepare("SELECT * FROM community_posts WHERE id = ?").get(postId);
  if (!post) throw new HttpError(404, "No se encontró ese posteo.");
  if (post.author_type !== author.type || post.author_id !== author.id) throw new HttpError(403, "Solo podés editar tus propios posteos.");
  const { title, text } = body;
  if (!title || !title.trim()) throw new HttpError(400, "Falta el título.");
  db.prepare("UPDATE community_posts SET title = ?, body = ? WHERE id = ?").run(title.trim(), text || null, postId);
  return db.prepare("SELECT * FROM community_posts WHERE id = ?").get(postId);
}

/** Sube una historia -- a diferencia de un posteo, el archivo es
    obligatorio siempre (no tiene sentido una historia sin nada). */
export async function createStory(author, body) {
  const { mediaBase64, mediaMimeType } = body;
  if (!mediaBase64 || !mediaMimeType) throw new HttpError(400, "Falta el archivo de la historia.");
  const mediaId = newId("media");
  fs.writeFileSync(path.join(MEDIA_DIR, mediaId), Buffer.from(mediaBase64, "base64"));
  db.prepare("INSERT INTO media (id, mime_type) VALUES (?, ?)").run(mediaId, mediaMimeType);
  const mediaUrl = `/api/media/${mediaId}`;
  const mediaType = mediaMimeType.startsWith("video/") ? "video" : "image";
  const id = newId("story");
  db.prepare(
    `INSERT INTO community_stories (id, author_type, author_id, author_name, media_url, media_type) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, author.type, author.id, author.name, mediaUrl, mediaType);
  return db.prepare("SELECT * FROM community_stories WHERE id = ?").get(id);
}

/** Todas las historias activas (últimas 24hs), agrupadas por persona --
    cada grupo trae sus historias en orden, más si esa persona sos vos
    mismo (para poder borrar las propias desde el visor). */
export async function listStories(req) {
  const filas = db.prepare(
    `SELECT * FROM community_stories WHERE created_at > datetime('now', '-24 hours') ORDER BY created_at ASC`
  ).all();
  const autor = authenticateAny(req);
  const grupos = {};
  const orden = [];
  filas.forEach(s => {
    const clave = `${s.author_type}:${s.author_id}`;
    if (!grupos[clave]) {
      grupos[clave] = { authorType: s.author_type, authorId: s.author_id, authorName: s.author_name, esMio: !!(autor && autor.type === s.author_type && autor.id === s.author_id), historias: [] };
      orden.push(clave);
    }
    grupos[clave].historias.push({ id: s.id, mediaUrl: s.media_url, mediaType: s.media_type, createdAt: s.created_at });
  });
  return orden.map(k => grupos[k]);
}

/** Borra una historia PROPIA antes de que expire sola. */
export async function deleteStory(author, storyId) {
  const historia = db.prepare("SELECT * FROM community_stories WHERE id = ?").get(storyId);
  if (!historia) throw new HttpError(404, "No se encontró esa historia.");
  if (historia.author_type !== author.type || historia.author_id !== author.id) throw new HttpError(403, "Solo podés borrar tus propias historias.");
  if (historia.media_url.startsWith("/api/media/")) {
    const mediaId = historia.media_url.replace("/api/media/", "");
    try { fs.unlinkSync(path.join(MEDIA_DIR, mediaId)); } catch (e) { /* si ya no está, no pasa nada */ }
    db.prepare("DELETE FROM media WHERE id = ?").run(mediaId);
  }
  db.prepare("DELETE FROM community_stories WHERE id = ?").run(storyId);
  return { deleted: true };
}

// --- Cuota mensual de la Comunidad -- solo cuentas de cliente final,
// los astrólogos ya pagan su propio plan y entran gratis. Mismo
// proveedor (Mercado Pago, débito automático) que las suscripciones
// Pro/Premium, cobrando a nombre del dueño de la plataforma.
export const COMMUNITY_PRICE_CENTS = 770000; // $7.700 ARS/mes -- equivalente a USD 5 al dólar oficial (~$1.535, agosto 2026), incluye "los mejores días"

export function hasActiveCommunityAccess(author) {
  if (author.type === "astrologo") return true;
  if (author.type === "cliente" && esCuentaDelDueno(author.email)) return true;
  const sub = db.prepare("SELECT status FROM community_subscriptions WHERE client_account_id = ? ORDER BY created_at DESC LIMIT 1").get(author.id);
  return !!(sub && sub.status === "active");
}

/** Mismo que requireAnyAuth(), pero además exige que la cuenta de
    cliente tenga la cuota activa -- se usa en las acciones que
    "participan" (publicar, comentar, reaccionar, seguir, historias),
    nunca para simplemente leer el feed. */
export function requireCommunityAccess(req) {
  const author = requireAnyAuth(req);
  if (!hasActiveCommunityAccess(author)) throw new HttpError(402, "Necesitás ser miembro de la Comunidad para hacer esto.");
  return author;
}

export function getMyCommunityStatus(author) {
  return { activa: hasActiveCommunityAccess(author), precioCents: COMMUNITY_PRICE_CENTS };
}

export async function createCommunityCheckout(clientAccount, baseUrl) {
  if (hasActiveCommunityAccess({ type: "cliente", id: clientAccount.id, email: clientAccount.email })) throw new HttpError(400, "Ya sos miembro de la Comunidad.");
  const { accessToken } = ownerCredentials();
  const id = newId("csub");
  db.prepare(`INSERT INTO community_subscriptions (id, client_account_id, amount_cents, status) VALUES (?, ?, ?, 'pending')`)
    .run(id, clientAccount.id, COMMUNITY_PRICE_CENTS);
  const pre = await mp.createPreapproval(accessToken, {
    reason: "Comunidad Apolo — membresía mensual",
    amountCents: COMMUNITY_PRICE_CENTS, currency: "ARS", frequency: 1, frequencyType: "months",
    payerEmail: clientAccount.email, externalReference: id,
    notificationUrl: `${baseUrl}/api/public/webhooks/community-subscription?subscriptionId=${id}`,
    backUrl: `${baseUrl}/comunidad.html?membresia=gracias`,
  });
  db.prepare("UPDATE community_subscriptions SET provider_ref = ? WHERE id = ?").run(pre.id, id);
  return { redirectUrl: pre.init_point };
}

export async function handleCommunityWebhook(query, headers, body) {
  const subId = query.get("subscriptionId");
  const sub = subId && db.prepare("SELECT * FROM community_subscriptions WHERE id = ?").get(subId);
  if (!sub) return;
  const { accessToken, webhookSecret } = ownerCredentials();

  const preapprovalId = query.get("data.id") || (body && body.data && body.data.id) || sub.provider_ref;
  if (webhookSecret) {
    const valid = mp.verifyWebhookSignature({ xSignature: headers["x-signature"], xRequestId: headers["x-request-id"], dataId: preapprovalId, webhookSecret });
    if (!valid) { console.warn("Webhook de suscripción de Comunidad con firma inválida, se ignora."); return; }
  }

  const preapproval = await mp.getPreapproval(accessToken, sub.provider_ref);
  if (preapproval.status === "authorized") {
    db.prepare("UPDATE community_subscriptions SET status='active', updated_at=datetime('now') WHERE id=?").run(sub.id);
    return;
  }
  if (preapproval.status === "paused" || preapproval.status === "cancelled") {
    db.prepare("UPDATE community_subscriptions SET status=?, updated_at=datetime('now') WHERE id=?").run(preapproval.status, sub.id);
  }
}

export { requireAnyAuth };
