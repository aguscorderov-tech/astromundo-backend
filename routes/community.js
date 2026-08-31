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
  if (user) return { type: "astrologo", id: user.id, name: user.professional_name || user.name, isAdmin: !!user.is_admin };
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
  const tabla = author.type === "astrologo" ? "users" : "client_accounts";
  const fila = db.prepare(`SELECT suspendido FROM ${tabla} WHERE id = ?`).get(author.id);
  if (fila && fila.suspendido) throw new HttpError(403, "Tu cuenta fue suspendida de la Comunidad.");
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
  const feed = query.get("feed"); // 'siguiendo' | null (todo, por defecto)
  const ordenar = query.get("ordenar"); // 'tendencia' | null (recientes, por defecto)
  const autor = authenticateAny(req);

  let sql = "SELECT * FROM community_posts WHERE oculto = 0";
  const params = [];
  if (espacio) { sql += " AND space = ?"; params.push(espacio); }
  if (feed === "siguiendo") {
    if (!autor) throw new HttpError(401, "Iniciá sesión para ver tu feed de Siguiendo.");
    sql += ` AND EXISTS (SELECT 1 FROM community_follows f WHERE f.follower_type = ? AND f.follower_id = ? AND f.followed_type = community_posts.author_type AND f.followed_id = community_posts.author_id)`;
    params.push(autor.type, autor.id);
  }

  let posts;
  if (ordenar === "tendencia") {
    // Traemos más candidatos (200, no 50) para elegir el top real de la
    // semana entre un universo más amplio, no solo los últimos 50
    // publicados -- si no, "tendencia" y "recientes" darían casi lo mismo.
    posts = db.prepare(sql + " ORDER BY created_at DESC LIMIT 200").all(...params);
    posts = posts.map(p => ({
      ...p,
      __puntaje: db.prepare(`SELECT COUNT(*) AS n FROM community_likes WHERE post_id = ? AND created_at > datetime('now', '-7 days')`).get(p.id).n,
    })).sort((a, b) => b.__puntaje - a.__puntaje).slice(0, 50);
  } else {
    // Los fijados van primero, pero solo tiene sentido "fijar" dentro de
    // un espacio puntual -- en "Todo" (sin filtro de espacio) se
    // ordena por fecha nomás, si no un solo posteo fijado en un
    // espacio le taparía el feed entero a todos los demás.
    const orden = espacio ? "ORDER BY fijado DESC, created_at DESC" : "ORDER BY created_at DESC";
    posts = db.prepare(sql + " " + orden + " LIMIT 50").all(...params);
  }

  const visibles = autor ? posts.filter(p => !estanBloqueados(autor.type, autor.id, p.author_type, p.author_id)) : posts;
  return visibles.map(p => {
    const { __puntaje, ...limpio } = p;
    const { reacciones, comentarios } = contarPost(limpio.id);
    const guardado = autor ? !!db.prepare("SELECT 1 FROM community_saves WHERE post_id = ? AND author_type = ? AND author_id = ?").get(limpio.id, autor.type, autor.id) : false;
    return conFotoAutor({ ...limpio, reacciones, comentarios, miReaccion: miReaccion(autor, limpio.id), guardado });
  });
}

/** Guardar/sacar un posteo de tus guardados -- toggle, misma idea que
    una reacción, pero privado (nadie más ve qué guardaste). */
export async function toggleSave(author, postId) {
  const post = db.prepare("SELECT id FROM community_posts WHERE id = ?").get(postId);
  if (!post) throw new HttpError(404, "No se encontró ese posteo.");
  const yaExiste = db.prepare("SELECT 1 FROM community_saves WHERE post_id = ? AND author_type = ? AND author_id = ?").get(postId, author.type, author.id);
  if (yaExiste) {
    db.prepare("DELETE FROM community_saves WHERE post_id = ? AND author_type = ? AND author_id = ?").run(postId, author.type, author.id);
  } else {
    db.prepare("INSERT INTO community_saves (post_id, author_type, author_id) VALUES (?, ?, ?)").run(postId, author.type, author.id);
  }
  return { guardado: !yaExiste };
}

export async function listSavedPosts(author) {
  const posts = db.prepare(
    `SELECT p.* FROM community_posts p
     JOIN community_saves s ON s.post_id = p.id
     WHERE s.author_type = ? AND s.author_id = ?
     ORDER BY s.created_at DESC`
  ).all(author.type, author.id);
  return posts.map(p => {
    const { reacciones, comentarios } = contarPost(p.id);
    return conFotoAutor({ ...p, reacciones, comentarios, miReaccion: miReaccion(author, p.id), guardado: true });
  });
}

/** Marcar/desmarcar una Pregunta como resuelta -- solo un astrólogo
    puede hacerlo (es una validación profesional, no del autor de la
    pregunta), y solo tiene sentido en posteos tipo "pregunta". */
export async function toggleResuelta(author, postId) {
  if (author.type !== "astrologo") throw new HttpError(403, "Solo un astrólogo puede marcar una pregunta como resuelta.");
  const post = db.prepare("SELECT * FROM community_posts WHERE id = ?").get(postId);
  if (!post) throw new HttpError(404, "No se encontró ese posteo.");
  if (post.post_type !== "pregunta") throw new HttpError(400, "Solo las Preguntas se pueden marcar como resueltas.");
  const nuevoValor = post.resuelta ? 0 : 1;
  db.prepare("UPDATE community_posts SET resuelta = ? WHERE id = ?").run(nuevoValor, postId);
  return { resuelta: !!nuevoValor };
}

/** Busca posteos (por título/texto) y personas (por nombre) a la vez --
    LIKE simple, sin nada de full-text -- alcanza para el volumen que
    tiene la Comunidad hoy. */
export async function buscarComunidad(req, texto) {
  const q = (texto || "").trim();
  if (q.length < 2) throw new HttpError(400, "Escribí al menos 2 caracteres para buscar.");
  const comodin = `%${q}%`;
  const autor = authenticateAny(req);

  const posteos = db.prepare(
    `SELECT * FROM community_posts WHERE title LIKE ? OR body LIKE ? ORDER BY created_at DESC LIMIT 20`
  ).all(comodin, comodin);
  const visibles = autor ? posteos.filter(p => !estanBloqueados(autor.type, autor.id, p.author_type, p.author_id)) : posteos;
  const posteosConDatos = visibles.map(p => {
    const { reacciones, comentarios } = contarPost(p.id);
    return conFotoAutor({ ...p, reacciones, comentarios, miReaccion: miReaccion(autor, p.id) });
  });

  const astrologos = db.prepare(
    `SELECT id, name, professional_name, photo_url FROM users WHERE name LIKE ? OR professional_name LIKE ? LIMIT 10`
  ).all(comodin, comodin).map(u => ({ type: "astrologo", id: u.id, name: u.professional_name || u.name, photoUrl: u.photo_url }));
  const clientes = db.prepare(
    `SELECT id, name, photo_url FROM client_accounts WHERE name LIKE ? LIMIT 10`
  ).all(comodin).map(c => ({ type: "cliente", id: c.id, name: c.name, photoUrl: c.photo_url }));
  const personas = autor
    ? [...astrologos, ...clientes].filter(p => !estanBloqueados(autor.type, autor.id, p.type, p.id))
    : [...astrologos, ...clientes];

  return { posteos: posteosConDatos, personas };
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
  return conFotoAutor({ ...post, comentarios, reacciones, miReaccion: miReaccion(autor, id) });
}

// --- Seguridad de contenido ---
// Filtro liviano a propósito: solo frena los casos MÁS obvios (spam
// evidente, insultos graves) -- un filtro agresivo generaría más
// falsos positivos molestos (charlas legítimas de astrología bloqueadas
// por error) que problemas reales evitados. No reemplaza la moderación
// humana del panel de reportes, la complementa.
const PATRONES_SPAM = [
  /\bhaz\s*clic\s*aqu[ií]\b/i, /\bgana\s+dinero\s+f[aá]cil/i, /\bcompra\s+seguidores\b/i,
  /\bviagra\b/i, /\bcasino\s+online\b/i, /\bpr[eé]stamos?\s+r[aá]pidos?\b/i,
  /(https?:\/\/\S+.*){3,}/i, // tres o más links en el mismo texto, patrón clásico de spam
];
const PALABRAS_GRAVES = ["puta madre", "hijo de puta", "concha de tu madre"];

function chequearContenido(titulo, texto) {
  const contenido = `${titulo || ""} ${texto || ""}`.toLowerCase();
  if (PATRONES_SPAM.some(p => p.test(contenido))) {
    throw new HttpError(400, "Este contenido parece spam publicitario, no se pudo publicar.");
  }
  if (PALABRAS_GRAVES.some(palabra => contenido.includes(palabra))) {
    throw new HttpError(400, "Este contenido incluye lenguaje que no está permitido en la Comunidad.");
  }
}

/** Como mucho N posteos por hora por persona, para frenar publicar en
    cadena (a mano o por script) -- los astrólogos, que suelen publicar
    más seguido de forma legítima, tienen un límite más alto. */
function chequearLimiteDeRitmo(author) {
  const limite = author.type === "astrologo" ? 15 : 8;
  const cantidad = db.prepare(
    `SELECT COUNT(*) AS n FROM community_posts WHERE author_type = ? AND author_id = ? AND created_at > datetime('now', '-1 hour')`
  ).get(author.type, author.id).n;
  if (cantidad >= limite) throw new HttpError(429, "Estás publicando muy seguido -- probá de nuevo en un rato.");
}

export async function createPost(author, body) {
  const { space, postType, title, text, mediaUrl, mediaBase64, mediaMimeType } = body;
  if (!ESPACIOS_VALIDOS.includes(space)) throw new HttpError(400, "Espacio inválido.");
  if (!TIPOS_VALIDOS.includes(postType)) throw new HttpError(400, "Tipo de posteo inválido.");
  if (!title || !title.trim()) throw new HttpError(400, "Falta el título.");
  chequearContenido(title, text);
  chequearLimiteDeRitmo(author);

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

/** Inserta una notificación, salvo que la acción sea sobre uno mismo
    (comentar tu propio posteo, por ejemplo) -- nadie necesita que le
    avisen de algo que hizo él mismo. */
function crearNotificacion(recipientType, recipientId, tipo, actor, postId) {
  if (recipientType === actor.type && recipientId === actor.id) return;
  db.prepare(
    `INSERT INTO community_notifications (id, recipient_type, recipient_id, tipo, actor_type, actor_id, actor_name, post_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(newId("notif"), recipientType, recipientId, tipo, actor.type, actor.id, actor.name, postId || null);
}

export async function createComment(author, postId, body) {
  const post = db.prepare("SELECT id, author_type, author_id FROM community_posts WHERE id = ?").get(postId);
  if (!post) throw new HttpError(404, "No se encontró ese posteo.");
  if (estanBloqueados(author.type, author.id, post.author_type, post.author_id)) throw new HttpError(403, "No podés interactuar con este posteo.");
  const { text } = body;
  if (!text || !text.trim()) throw new HttpError(400, "Falta el comentario.");
  chequearContenido("", text);
  const id = newId("cm");
  db.prepare(
    `INSERT INTO community_comments (id, post_id, author_type, author_id, author_name, body) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, postId, author.type, author.id, author.name, text.trim());
  crearNotificacion(post.author_type, post.author_id, "comment", author, postId);
  return db.prepare("SELECT * FROM community_comments WHERE id = ?").get(id);
}

/** Elegir una reacción -- si ya tenía puesta esa misma, se la saca
    (toggle); si tenía otra distinta puesta, la cambia; si no tenía
    ninguna, la agrega. Solo puede haber UNA reacción por persona por
    posteo a la vez, igual que en Facebook. */
export async function toggleReaction(author, postId, tipo) {
  if (!TIPOS_REACCION.includes(tipo)) throw new HttpError(400, "Tipo de reacción inválido.");
  const post = db.prepare("SELECT id, author_type, author_id FROM community_posts WHERE id = ?").get(postId);
  if (!post) throw new HttpError(404, "No se encontró ese posteo.");
  if (estanBloqueados(author.type, author.id, post.author_type, post.author_id)) throw new HttpError(403, "No podés interactuar con este posteo.");
  const actual = miReaccion(author, postId);
  if (actual === tipo) {
    db.prepare("DELETE FROM community_likes WHERE post_id = ? AND author_type = ? AND author_id = ?").run(postId, author.type, author.id);
  } else if (actual) {
    db.prepare("UPDATE community_likes SET reaction_type = ? WHERE post_id = ? AND author_type = ? AND author_id = ?").run(tipo, postId, author.type, author.id);
  } else {
    db.prepare("INSERT INTO community_likes (post_id, author_type, author_id, reaction_type) VALUES (?, ?, ?, ?)").run(postId, author.type, author.id, tipo);
    crearNotificacion(post.author_type, post.author_id, "reaction", author, postId);
  }
  const { reacciones } = contarPost(postId);
  return { reacciones, miReaccion: actual === tipo ? null : tipo };
}

/** Seguir a alguien, o dejar de hacerlo si ya lo seguía (toggle). No se
    puede seguir a uno mismo. */
export async function toggleFollow(follower, followedType, followedId) {
  if (follower.type === followedType && follower.id === followedId) throw new HttpError(400, "No podés seguirte a vos mismo.");
  if (estanBloqueados(follower.type, follower.id, followedType, followedId)) throw new HttpError(403, "No podés seguir a esta persona.");
  const yaExiste = db.prepare("SELECT 1 FROM community_follows WHERE follower_type = ? AND follower_id = ? AND followed_type = ? AND followed_id = ?").get(follower.type, follower.id, followedType, followedId);
  if (yaExiste) {
    db.prepare("DELETE FROM community_follows WHERE follower_type = ? AND follower_id = ? AND followed_type = ? AND followed_id = ?").run(follower.type, follower.id, followedType, followedId);
  } else {
    db.prepare("INSERT INTO community_follows (follower_type, follower_id, followed_type, followed_id) VALUES (?, ?, ?, ?)").run(follower.type, follower.id, followedType, followedId);
    crearNotificacion(followedType, followedId, "follow", follower, null);
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

/** Agrega authorPhotoUrl a un posteo con la foto ACTUAL del autor (no
    una guardada al momento de publicar) -- así, si alguien cambia su
    foto de perfil después, sus posteos viejos también la muestran
    actualizada, en vez de quedar con una foto vieja pegada. */
function conFotoAutor(p) {
  const persona = obtenerPersona(p.author_type, p.author_id);
  return { ...p, authorPhotoUrl: persona ? persona.photoUrl : null };
}

/** El perfil público de una persona (astrólogo o cliente): su info,
    cuántos la siguen, sus posteos normales y sus destacados aparte. */
// Insignias por aportes -- puntaje ponderado (un posteo pesa más que
// un comentario, que a su vez pesa más que una reacción recibida sola),
// con niveles que se van desbloqueando solos, sin que nadie los asigne
// a mano.
const NIVELES_APORTE = [
  { min: 0, nombre: "Nuevo", color: "#8A8577" },
  { min: 10, nombre: "Activo", color: "#4F7FBF" },
  { min: 50, nombre: "Referente", color: "#9C7A3C" },
  { min: 150, nombre: "Leyenda", color: "#C24E7A" },
];

function calcularAportes(type, id) {
  const posts = db.prepare("SELECT COUNT(*) AS n FROM community_posts WHERE author_type = ? AND author_id = ?").get(type, id).n;
  const comentarios = db.prepare("SELECT COUNT(*) AS n FROM community_comments WHERE author_type = ? AND author_id = ?").get(type, id).n;
  const reaccionesRecibidas = db.prepare(
    `SELECT COUNT(*) AS n FROM community_likes l JOIN community_posts p ON p.id = l.post_id WHERE p.author_type = ? AND p.author_id = ?`
  ).get(type, id).n;
  const puntaje = posts * 3 + comentarios * 1 + reaccionesRecibidas * 1;
  let nivel = NIVELES_APORTE[0];
  NIVELES_APORTE.forEach(n => { if (puntaje >= n.min) nivel = n; });
  return { totalAportes: posts + comentarios, puntaje, nivel: nivel.nombre, nivelColor: nivel.color };
}

export async function getProfile(req, type, id) {
  if (type !== "astrologo" && type !== "cliente") throw new HttpError(400, "Tipo de persona inválido.");
  const persona = obtenerPersona(type, id);
  if (!persona) throw new HttpError(404, "No se encontró esa persona.");

  const seguidores = db.prepare("SELECT COUNT(*) AS n FROM community_follows WHERE followed_type = ? AND followed_id = ?").get(type, id).n;
  const siguiendo = db.prepare("SELECT COUNT(*) AS n FROM community_follows WHERE follower_type = ? AND follower_id = ?").get(type, id).n;
  const posts = db.prepare("SELECT * FROM community_posts WHERE author_type = ? AND author_id = ? AND is_destacado = 0 ORDER BY created_at DESC LIMIT 30").all(type, id);
  const destacados = db.prepare("SELECT * FROM community_posts WHERE author_type = ? AND author_id = ? AND is_destacado = 1 ORDER BY created_at DESC").all(type, id);
  const aportes = calcularAportes(type, id);

  const autor = authenticateAny(req);
  const meSigue = autor
    ? !!db.prepare("SELECT 1 FROM community_follows WHERE follower_type = ? AND follower_id = ? AND followed_type = ? AND followed_id = ?").get(autor.type, autor.id, type, id)
    : false;

  const conReacciones = (lista) => lista.map(p => {
    const { reacciones, comentarios } = contarPost(p.id);
    return conFotoAutor({ ...p, reacciones, comentarios, miReaccion: miReaccion(autor, p.id) });
  });

  return {
    type, id, name: persona.name, bio: persona.bio, photoUrl: persona.photoUrl,
    seguidores, siguiendo, meSigue, esUnoMismo: !!(autor && autor.type === type && autor.id === id),
    posts: conReacciones(posts), destacados: conReacciones(destacados),
    ...aportes,
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

/** Fija/desfija un posteo PROPIO -- solo un astrólogo puede fijar (es
    una herramienta de moderación/organización de su espacio, no de
    cualquiera), y solo sobre su propio posteo. Un posteo fijado
    aparece primero al filtrar por espacio (ver listPosts). */
export async function toggleFijado(author, postId) {
  if (author.type !== "astrologo") throw new HttpError(403, "Solo un astrólogo puede fijar un posteo.");
  const post = db.prepare("SELECT * FROM community_posts WHERE id = ?").get(postId);
  if (!post) throw new HttpError(404, "No se encontró ese posteo.");
  if (post.author_type !== author.type || post.author_id !== author.id) throw new HttpError(403, "Solo podés fijar tus propios posteos.");
  const nuevoValor = post.fijado ? 0 : 1;
  db.prepare("UPDATE community_posts SET fijado = ? WHERE id = ?").run(nuevoValor, postId);
  return { fijado: !!nuevoValor };
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
      const persona = obtenerPersona(s.author_type, s.author_id);
      grupos[clave] = { authorType: s.author_type, authorId: s.author_id, authorName: s.author_name, authorPhotoUrl: persona ? persona.photoUrl : null, esMio: !!(autor && autor.type === s.author_type && autor.id === s.author_id), historias: [] };
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
  // Llave de emergencia/prueba -- con COMMUNITY_FREE_FOR_ALL=true en las
  // variables de entorno de Railway, la Comunidad queda abierta para
  // cualquiera con sesión, sin pedir cuota. Para volver a cobrar, alcanza
  // con sacar esa variable (o ponerla en false) desde Railway -- no
  // hace falta tocar código de nuevo para prender o apagar esto.
  if (process.env.COMMUNITY_FREE_FOR_ALL === "true") return true;
  if (author.type === "astrologo") return true;
  if (author.type === "cliente" && esCuentaDelDueno(author.email)) return true;
  const sub = db.prepare("SELECT status FROM community_subscriptions WHERE client_account_id = ? ORDER BY created_at DESC LIMIT 1").get(author.id);
  if (sub && sub.status === "active") return true;
  // Bonus por referidos -- crédito propio, independiente de si la
  // suscripción real de Mercado Pago está activa o no.
  if (author.type === "cliente") {
    const cuenta = db.prepare("SELECT bonus_acceso_hasta FROM client_accounts WHERE id = ?").get(author.id);
    if (cuenta && cuenta.bonus_acceso_hasta && new Date(cuenta.bonus_acceso_hasta + "Z") > new Date()) return true;
  }
  return false;
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
    // El bonus por referido se otorga solo la PRIMERA vez que esta
    // suscripción pasa a activa -- si ya estaba activa antes (un
    // webhook repetido, por ejemplo), no hay que volver a regalar 30
    // días cada vez que Mercado Pago reconfirma el cobro mensual.
    const yaEstabaActiva = sub.status === "active";
    db.prepare("UPDATE community_subscriptions SET status='active', updated_at=datetime('now') WHERE id=?").run(sub.id);
    if (!yaEstabaActiva) otorgarBonusPorReferido(sub.client_account_id);
    return;
  }
  if (preapproval.status === "paused" || preapproval.status === "cancelled") {
    db.prepare("UPDATE community_subscriptions SET status=?, updated_at=datetime('now') WHERE id=?").run(preapproval.status, sub.id);
  }
}

// --- Notificaciones ---
export async function listNotifications(author) {
  const filas = db.prepare(
    `SELECT * FROM community_notifications WHERE recipient_type = ? AND recipient_id = ? ORDER BY created_at DESC LIMIT 50`
  ).all(author.type, author.id);
  const sinLeer = db.prepare(
    `SELECT COUNT(*) AS n FROM community_notifications WHERE recipient_type = ? AND recipient_id = ? AND leida = 0`
  ).get(author.type, author.id).n;
  return { notificaciones: filas, sinLeer };
}

export async function marcarNotificacionesLeidas(author) {
  db.prepare(`UPDATE community_notifications SET leida = 1 WHERE recipient_type = ? AND recipient_id = ?`).run(author.type, author.id);
  return { ok: true };
}

// --- Reportes y bloqueos ---
export async function crearReporte(author, body) {
  const { targetType, targetId, motivo } = body;
  if (!["post", "comment", "usuario"].includes(targetType)) throw new HttpError(400, "Tipo de reporte inválido.");
  if (!targetId) throw new HttpError(400, "Falta indicar qué se reporta.");
  db.prepare(
    `INSERT INTO community_reports (id, reporter_type, reporter_id, target_type, target_id, motivo) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(newId("report"), author.type, author.id, targetType, targetId, (motivo || "").trim().slice(0, 500) || null);

  // Si un posteo junta 3 reportes de personas DISTINTAS, se oculta
  // solo del feed general hasta que un moderador lo revise -- no se
  // borra, solo deja de mostrarse mientras tanto. El propio autor
  // igual lo puede seguir viendo/gestionando desde su perfil.
  if (targetType === "post") {
    const reportantesDistintos = db.prepare(
      `SELECT COUNT(DISTINCT reporter_type || ':' || reporter_id) AS n FROM community_reports WHERE target_type = 'post' AND target_id = ?`
    ).get(targetId).n;
    if (reportantesDistintos >= 3) {
      db.prepare("UPDATE community_posts SET oculto = 1 WHERE id = ?").run(targetId);
    }
  }
  return { ok: true };
}

/** Bloqueo en las dos direcciones -- si CUALQUIERA de los dos bloqueó al
    otro, no se ven mutuamente. Un modelo mental simple: "bloqueado" es
    bloqueado, sin importar quién apretó el botón primero. */
export function estanBloqueados(tipoA, idA, tipoB, idB) {
  const fila = db.prepare(
    `SELECT 1 FROM community_blocks WHERE
     (blocker_type = ? AND blocker_id = ? AND blocked_type = ? AND blocked_id = ?) OR
     (blocker_type = ? AND blocker_id = ? AND blocked_type = ? AND blocked_id = ?)`
  ).get(tipoA, idA, tipoB, idB, tipoB, idB, tipoA, idA);
  return !!fila;
}

export async function toggleBlock(author, blockedType, blockedId) {
  if (author.type === blockedType && author.id === blockedId) throw new HttpError(400, "No podés bloquearte a vos mismo.");
  const yaExiste = db.prepare(
    "SELECT 1 FROM community_blocks WHERE blocker_type = ? AND blocker_id = ? AND blocked_type = ? AND blocked_id = ?"
  ).get(author.type, author.id, blockedType, blockedId);
  if (yaExiste) {
    db.prepare("DELETE FROM community_blocks WHERE blocker_type = ? AND blocker_id = ? AND blocked_type = ? AND blocked_id = ?")
      .run(author.type, author.id, blockedType, blockedId);
  } else {
    db.prepare("INSERT INTO community_blocks (blocker_type, blocker_id, blocked_type, blocked_id) VALUES (?, ?, ?, ?)")
      .run(author.type, author.id, blockedType, blockedId);
    // Bloquear también corta cualquier seguimiento cruzado entre los dos,
    // en las dos direcciones -- no tendría sentido seguir bloqueado a alguien.
    db.prepare(`DELETE FROM community_follows WHERE
      (follower_type=? AND follower_id=? AND followed_type=? AND followed_id=?) OR
      (follower_type=? AND follower_id=? AND followed_type=? AND followed_id=?)`)
      .run(author.type, author.id, blockedType, blockedId, blockedType, blockedId, author.type, author.id);
  }
  return { bloqueado: !yaExiste };
}

// --- Mensajes directos ---
export async function sendMessage(sender, recipientType, recipientId, body) {
  if (sender.type === recipientType && sender.id === recipientId) throw new HttpError(400, "No podés enviarte un mensaje a vos mismo.");
  if (!body || !body.trim()) throw new HttpError(400, "El mensaje no puede estar vacío.");
  if (estanBloqueados(sender.type, sender.id, recipientType, recipientId)) throw new HttpError(403, "No podés enviar mensajes a esta persona.");
  const id = newId("msg");
  db.prepare(`INSERT INTO community_messages (id, sender_type, sender_id, recipient_type, recipient_id, body) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, sender.type, sender.id, recipientType, recipientId, body.trim().slice(0, 2000));
  return db.prepare("SELECT * FROM community_messages WHERE id = ?").get(id);
}

/** Todos los mensajes con UNA persona puntual, en orden -- y de paso
    marca como leídos los que esa persona me mandó a mí. */
export async function getConversation(author, otherType, otherId) {
  const mensajes = db.prepare(
    `SELECT * FROM community_messages WHERE
     (sender_type=? AND sender_id=? AND recipient_type=? AND recipient_id=?) OR
     (sender_type=? AND sender_id=? AND recipient_type=? AND recipient_id=?)
     ORDER BY created_at ASC LIMIT 200`
  ).all(author.type, author.id, otherType, otherId, otherType, otherId, author.type, author.id);
  db.prepare(`UPDATE community_messages SET leido=1 WHERE sender_type=? AND sender_id=? AND recipient_type=? AND recipient_id=? AND leido=0`)
    .run(otherType, otherId, author.type, author.id);
  return mensajes;
}

/** Lista de conversaciones -- agrupa todos mis mensajes por la OTRA
    persona, quedándose con el más reciente de cada una y contando los
    no leídos de cada conversación por separado. */
export async function listConversations(author) {
  const todos = db.prepare(
    `SELECT * FROM community_messages WHERE (sender_type=? AND sender_id=?) OR (recipient_type=? AND recipient_id=?) ORDER BY created_at DESC`
  ).all(author.type, author.id, author.type, author.id);
  const mapa = new Map();
  todos.forEach(m => {
    const soyYoElRemitente = m.sender_type === author.type && m.sender_id === author.id;
    const otroType = soyYoElRemitente ? m.recipient_type : m.sender_type;
    const otroId = soyYoElRemitente ? m.recipient_id : m.sender_id;
    const clave = `${otroType}:${otroId}`;
    if (!mapa.has(clave)) mapa.set(clave, { otroType, otroId, ultimoMensaje: m.body, fecha: m.created_at, sinLeer: 0 });
    if (!soyYoElRemitente && !m.leido) mapa.get(clave).sinLeer++;
  });
  return [...mapa.values()].map(c => {
    const persona = obtenerPersona(c.otroType, c.otroId);
    return { ...c, otroName: persona ? persona.name : "Usuario" };
  });
}

// --- Espacios en vivo ---
export async function crearEventoEnVivo(author, body) {
  if (author.type !== "astrologo") throw new HttpError(403, "Solo un astrólogo puede agendar un espacio en vivo.");
  const { titulo, descripcion, fechaHora, espacio } = body;
  if (!titulo || !titulo.trim()) throw new HttpError(400, "Falta el título.");
  if (!fechaHora) throw new HttpError(400, "Falta la fecha y hora.");
  if (espacio && !ESPACIOS_VALIDOS.includes(espacio)) throw new HttpError(400, "Espacio inválido.");
  const id = newId("live");
  db.prepare(`INSERT INTO community_live_events (id, astrologo_id, astrologo_name, titulo, descripcion, fecha_hora, espacio) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, author.id, author.name, titulo.trim(), (descripcion || "").trim() || null, fechaHora, espacio || null);

  // Avisar a quien sigue a este astrólogo -- reusa el sistema de
  // notificaciones existente, con un tipo nuevo ("live"). post_id acá
  // guarda el id del EVENTO, no de un posteo -- el frontend lo sabe
  // interpretar por el tipo.
  const seguidores = db.prepare("SELECT follower_type, follower_id FROM community_follows WHERE followed_type = 'astrologo' AND followed_id = ?").all(author.id);
  seguidores.forEach(s => crearNotificacion(s.follower_type, s.follower_id, "live", author, id));

  return db.prepare("SELECT * FROM community_live_events WHERE id = ?").get(id);
}

export async function listLiveEvents() {
  return db.prepare("SELECT * FROM community_live_events WHERE fecha_hora > datetime('now') ORDER BY fecha_hora ASC LIMIT 20").all();
}

// --- Referidos ---
function generarCodigoReferido() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

/** Devuelve (generándolo la primera vez que se pide) el código propio
    de la persona, más cuántas personas ya trajo. Solo cuentas de
    cliente participan del programa -- un astrólogo ya tiene su propio
    plan, no paga la cuota de Comunidad. */
export function getMyReferralInfo(author) {
  if (author.type !== "cliente") throw new HttpError(400, "El programa de referidos es solo para cuentas de cliente.");
  const cuenta = db.prepare("SELECT codigo_referido FROM client_accounts WHERE id = ?").get(author.id);
  let codigo = cuenta.codigo_referido;
  if (!codigo) {
    codigo = generarCodigoReferido();
    db.prepare("UPDATE client_accounts SET codigo_referido = ? WHERE id = ?").run(codigo, author.id);
  }
  const cantidadReferidos = db.prepare("SELECT COUNT(*) AS n FROM client_accounts WHERE referido_por = ?").get(author.id).n;
  return { codigo, cantidadReferidos };
}

/** Se llama al activar por primera vez la cuota de Comunidad de
    alguien que fue referido -- le suma 30 días de acceso gratis a
    quien lo refirió. No toca la facturación real de Mercado Pago para
    nada: es un crédito propio, guardado acá, más simple y más seguro
    que intentar manipular el ciclo de cobro de otra persona. */
export function otorgarBonusPorReferido(clientAccountId) {
  const cuenta = db.prepare("SELECT referido_por FROM client_accounts WHERE id = ?").get(clientAccountId);
  if (!cuenta || !cuenta.referido_por) return;
  const referente = db.prepare("SELECT id, bonus_acceso_hasta FROM client_accounts WHERE id = ?").get(cuenta.referido_por);
  if (!referente) return;
  const base = referente.bonus_acceso_hasta && new Date(referente.bonus_acceso_hasta + "Z") > new Date() ? new Date(referente.bonus_acceso_hasta + "Z") : new Date();
  base.setUTCDate(base.getUTCDate() + 30);
  const nuevaFecha = base.toISOString().slice(0, 19).replace("T", " ");
  db.prepare("UPDATE client_accounts SET bonus_acceso_hasta = ? WHERE id = ?").run(nuevaFecha, referente.id);
}

function requireAdmin(req) {
  const author = requireAnyAuth(req);
  if (author.type !== "astrologo" || !author.isAdmin) throw new HttpError(403, "Solo el dueño de la plataforma puede hacer esto.");
  return author;
}

/** Los reportes de tipo "usuario" solo guardan un id, sin el tipo (no
    se sabe de antemano si es astrólogo o cliente) -- esto prueba las
    dos tablas para encontrarlo, en vez de asumir una. */
function buscarPersonaPorIdSolo(id) {
  let p = obtenerPersona("astrologo", id);
  if (p) return { ...p, type: "astrologo" };
  p = obtenerPersona("cliente", id);
  if (p) return { ...p, type: "cliente" };
  return null;
}

/** Panel de moderación -- todos los reportes pendientes, con el
    contenido real de lo reportado (para no tener que ir a buscarlo a
    mano en otro lado). Solo el dueño de la plataforma puede verlo. */
export async function listReports(req) {
  requireAdmin(req);
  const reportes = db.prepare("SELECT * FROM community_reports WHERE estado = 'pendiente' ORDER BY created_at DESC LIMIT 100").all();
  return reportes.map(r => {
    const reportante = buscarPersonaPorIdSolo(r.reporter_id);
    let detalle = null;
    if (r.target_type === "post") {
      const post = db.prepare("SELECT id, title, body, author_name, author_type, author_id FROM community_posts WHERE id = ?").get(r.target_id);
      detalle = post ? { tipo: "post", titulo: post.title, texto: post.body, autorNombre: post.author_name, autorTipo: post.author_type, autorId: post.author_id } : { tipo: "post", eliminado: true };
    } else if (r.target_type === "comment") {
      const com = db.prepare("SELECT id, body, author_name, author_type, author_id FROM community_comments WHERE id = ?").get(r.target_id);
      detalle = com ? { tipo: "comment", texto: com.body, autorNombre: com.author_name, autorTipo: com.author_type, autorId: com.author_id } : { tipo: "comment", eliminado: true };
    } else {
      const persona = buscarPersonaPorIdSolo(r.target_id);
      detalle = persona ? { tipo: "usuario", autorNombre: persona.name, autorTipo: persona.type, autorId: r.target_id } : { tipo: "usuario", eliminado: true };
    }
    return { id: r.id, motivo: r.motivo, createdAt: r.created_at, reportanteNombre: reportante ? reportante.name : "?", detalle };
  });
}

export async function resolverReporte(req, reportId) {
  requireAdmin(req);
  const reporte = db.prepare("SELECT id FROM community_reports WHERE id = ?").get(reportId);
  if (!reporte) throw new HttpError(404, "No se encontró ese reporte.");
  db.prepare("UPDATE community_reports SET estado = 'resuelto' WHERE id = ?").run(reportId);
  return { ok: true };
}

/** Suspende/reactiva una cuenta -- bloquea la PARTICIPACIÓN en la
    Comunidad (publicar, comentar, reaccionar, todo lo que pasa por
    requireAnyAuth), no borra la cuenta ni afecta el resto de la
    plataforma. */
export async function toggleSuspension(req, targetType, targetId) {
  requireAdmin(req);
  if (targetType !== "astrologo" && targetType !== "cliente") throw new HttpError(400, "Tipo inválido.");
  const tabla = targetType === "astrologo" ? "users" : "client_accounts";
  const fila = db.prepare(`SELECT suspendido FROM ${tabla} WHERE id = ?`).get(targetId);
  if (!fila) throw new HttpError(404, "No se encontró esa cuenta.");
  const nuevoValor = fila.suspendido ? 0 : 1;
  db.prepare(`UPDATE ${tabla} SET suspendido = ? WHERE id = ?`).run(nuevoValor, targetId);
  return { suspendido: !!nuevoValor };
}

/** Sugiere unos pocos astrólogos para seguir al arrancar -- primero
    los que ya tienen más seguidores (resuenan con la comunidad), y si
    todavía nadie tiene ninguno (comunidad recién arrancando), los más
    recientes, para que la sugerencia nunca quede vacía. */
export async function sugerirAstrologos(author) {
  const candidatos = db.prepare(
    `SELECT u.id, u.name, u.professional_name, u.photo_url, u.bio,
     (SELECT COUNT(*) FROM community_follows f WHERE f.followed_type='astrologo' AND f.followed_id=u.id) AS seguidores
     FROM users u ORDER BY seguidores DESC, u.created_at DESC LIMIT 6`
  ).all();
  return candidatos
    .filter(u => !(author && author.type === "astrologo" && author.id === u.id))
    .slice(0, 5)
    .map(u => ({ id: u.id, name: u.professional_name || u.name, photoUrl: u.photo_url, bio: u.bio, seguidores: u.seguidores }));
}

export { requireAnyAuth };
