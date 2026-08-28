// routes/community.js
// Posteos, comentarios y "me gusta" de la Comunidad -- lo único de toda
// la plataforma donde pueden publicar DOS tipos de cuenta distintos
// (astrólogo o cliente final), por eso authenticateAny() de acá abajo,
// que intenta las dos formas de sesión en vez de asumir una sola.

import { db, newId } from "../db.js";
import { authenticate } from "../auth.js";
import { authenticateClient } from "../auth-cliente.js";
import { HttpError } from "../http-utils.js";

const ESPACIOS_VALIDOS = ["anuncios", "transitos", "preguntas", "cartas"];
const TIPOS_VALIDOS = ["video", "reel", "post", "pregunta"];

/** Prueba la sesión de astrólogo primero, y si no hay, la de cliente --
    devuelve una forma común para las dos, así el resto de las rutas de
    este archivo no necesita saber cuál de las dos es. */
export function authenticateAny(req) {
  const user = authenticate(req);
  if (user) return { type: "astrologo", id: user.id, name: user.professionalName || user.name };
  const account = authenticateClient(req);
  if (account) return { type: "cliente", id: account.id, name: account.name };
  return null;
}

function requireAnyAuth(req) {
  const author = authenticateAny(req);
  if (!author) throw new HttpError(401, "No autenticado — mandá Authorization o X-Client-Auth.");
  return author;
}

function contarPost(id) {
  const likes = db.prepare("SELECT COUNT(*) AS n FROM community_likes WHERE post_id = ?").get(id).n;
  const comentarios = db.prepare("SELECT COUNT(*) AS n FROM community_comments WHERE post_id = ?").get(id).n;
  return { likes, comentarios };
}

export async function listPosts(req, query) {
  const espacio = query.get("espacio");
  if (espacio && !ESPACIOS_VALIDOS.includes(espacio)) throw new HttpError(400, "Espacio inválido.");
  const posts = espacio
    ? db.prepare("SELECT * FROM community_posts WHERE space = ? ORDER BY created_at DESC LIMIT 50").all(espacio)
    : db.prepare("SELECT * FROM community_posts ORDER BY created_at DESC LIMIT 50").all();

  // Si hay una sesión (de cualquiera de los dos tipos), marcamos qué
  // posteos ya likeó esta persona -- para que el corazón aparezca lleno
  // sin tener que pedirlo aparte por cada tarjeta.
  const autor = authenticateAny(req);
  return posts.map(p => {
    const { likes, comentarios } = contarPost(p.id);
    const meGusta = autor
      ? !!db.prepare("SELECT 1 FROM community_likes WHERE post_id = ? AND author_type = ? AND author_id = ?").get(p.id, autor.type, autor.id)
      : false;
    return { ...p, likes, comentarios, meGusta };
  });
}

export async function getPost(req, id) {
  const post = db.prepare("SELECT * FROM community_posts WHERE id = ?").get(id);
  if (!post) throw new HttpError(404, "No se encontró ese posteo.");
  const comentarios = db.prepare("SELECT * FROM community_comments WHERE post_id = ? ORDER BY created_at ASC").all(id);
  const { likes } = contarPost(id);
  const autor = authenticateAny(req);
  const meGusta = autor
    ? !!db.prepare("SELECT 1 FROM community_likes WHERE post_id = ? AND author_type = ? AND author_id = ?").get(id, autor.type, autor.id)
    : false;
  return { ...post, comentarios, likes, meGusta };
}

export async function createPost(author, body) {
  const { space, postType, title, text, mediaUrl } = body;
  if (!ESPACIOS_VALIDOS.includes(space)) throw new HttpError(400, "Espacio inválido.");
  if (!TIPOS_VALIDOS.includes(postType)) throw new HttpError(400, "Tipo de posteo inválido.");
  if (!title || !title.trim()) throw new HttpError(400, "Falta el título.");
  if ((postType === "video" || postType === "reel") && !mediaUrl) {
    throw new HttpError(400, "Los posteos de video o reel necesitan un link (mediaUrl) por ahora.");
  }
  const id = newId("post");
  db.prepare(
    `INSERT INTO community_posts (id, author_type, author_id, author_name, space, post_type, title, body, media_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, author.type, author.id, author.name, space, postType, title.trim(), text || null, mediaUrl || null);
  return db.prepare("SELECT * FROM community_posts WHERE id = ?").get(id);
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

/** Toggle -- si ya le había dado me gusta, se lo saca; si no, se lo pone.
    Un solo endpoint para las dos acciones, en vez de dos rutas separadas. */
export async function toggleLike(author, postId) {
  const post = db.prepare("SELECT id FROM community_posts WHERE id = ?").get(postId);
  if (!post) throw new HttpError(404, "No se encontró ese posteo.");
  const yaExiste = db.prepare("SELECT 1 FROM community_likes WHERE post_id = ? AND author_type = ? AND author_id = ?").get(postId, author.type, author.id);
  if (yaExiste) {
    db.prepare("DELETE FROM community_likes WHERE post_id = ? AND author_type = ? AND author_id = ?").run(postId, author.type, author.id);
  } else {
    db.prepare("INSERT INTO community_likes (post_id, author_type, author_id) VALUES (?, ?, ?)").run(postId, author.type, author.id);
  }
  const { likes } = contarPost(postId);
  return { likes, meGusta: !yaExiste };
}

export { requireAnyAuth };
