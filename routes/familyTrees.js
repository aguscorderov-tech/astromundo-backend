// routes/familyTrees.js
import { db, newId } from "../db.js";
import { HttpError } from "../http-utils.js";

// ---- Árboles ----

export function listFamilyTrees(user) {
  return db.prepare("SELECT * FROM family_trees WHERE user_id = ? ORDER BY created_at DESC").all(user.id);
}

export function createFamilyTree(user, body) {
  if (!body.name) throw new HttpError(400, "El árbol necesita un nombre.");
  const id = newId("ft");
  db.prepare("INSERT INTO family_trees (id, user_id, name) VALUES (?, ?, ?)").run(id, user.id, body.name);
  return db.prepare("SELECT * FROM family_trees WHERE id = ?").get(id);
}

export function renameFamilyTree(user, treeId, body) {
  const tree = db.prepare("SELECT * FROM family_trees WHERE id = ? AND user_id = ?").get(treeId, user.id);
  if (!tree) throw new HttpError(404, "Árbol no encontrado.");
  db.prepare("UPDATE family_trees SET name = ? WHERE id = ?").run(body.name, treeId);
  return db.prepare("SELECT * FROM family_trees WHERE id = ?").get(treeId);
}

export function deleteFamilyTree(user, treeId) {
  const tree = db.prepare("SELECT * FROM family_trees WHERE id = ? AND user_id = ?").get(treeId, user.id);
  if (!tree) throw new HttpError(404, "Árbol no encontrado.");
  db.prepare("DELETE FROM family_trees WHERE id = ?").run(treeId); // nodos y relaciones se borran solos (ON DELETE CASCADE)
  return { ok: true };
}

export function getFamilyTree(user, treeId) {
  const tree = db.prepare("SELECT * FROM family_trees WHERE id = ? AND user_id = ?").get(treeId, user.id);
  if (!tree) throw new HttpError(404, "Árbol no encontrado.");
  const nodes = db.prepare("SELECT * FROM family_nodes WHERE tree_id = ?").all(treeId);
  const relations = db.prepare("SELECT * FROM family_relations WHERE tree_id = ?").all(treeId);
  return { ...tree, nodes, relations };
}

// ---- Nodos (personas del árbol) ----

export function createFamilyNode(user, treeId, body) {
  const tree = db.prepare("SELECT * FROM family_trees WHERE id = ? AND user_id = ?").get(treeId, user.id);
  if (!tree) throw new HttpError(404, "Árbol no encontrado.");
  if (!body.name) throw new HttpError(400, "La persona necesita un nombre.");
  const id = newId("fn");
  db.prepare(`INSERT INTO family_nodes
    (id, tree_id, client_id, name, date, time, time_unknown, place, lat, lng, tz, tz_name, gender, deceased, death_date, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, treeId, body.clientId || null, body.name, body.date || null, body.time || null,
    body.timeUnknown ? 1 : 0, body.place || null, body.lat ?? null, body.lng ?? null,
    body.tz || null, body.tzName || null, body.gender || null,
    body.deceased ? 1 : 0, body.deathDate || null, body.notes || null
  );
  return db.prepare("SELECT * FROM family_nodes WHERE id = ?").get(id);
}

export function updateFamilyNode(user, nodeId, body) {
  const existing = db.prepare(
    `SELECT family_nodes.* FROM family_nodes
     JOIN family_trees ON family_trees.id = family_nodes.tree_id
     WHERE family_nodes.id = ? AND family_trees.user_id = ?`
  ).get(nodeId, user.id);
  if (!existing) throw new HttpError(404, "Persona no encontrada.");
  const merged = { ...existing, ...body };
  db.prepare(`UPDATE family_nodes SET
    client_id=?, name=?, date=?, time=?, time_unknown=?, place=?, lat=?, lng=?, tz=?, tz_name=?, gender=?, deceased=?, death_date=?, notes=?
    WHERE id=?`).run(
    merged.clientId ?? existing.client_id ?? null,
    merged.name, merged.date ?? null, merged.time ?? null,
    (body.timeUnknown !== undefined ? body.timeUnknown : existing.time_unknown) ? 1 : 0,
    merged.place ?? null, merged.lat ?? null, merged.lng ?? null, merged.tz ?? null,
    merged.tzName ?? existing.tz_name ?? null, merged.gender ?? existing.gender ?? null,
    (body.deceased !== undefined ? body.deceased : existing.deceased) ? 1 : 0,
    merged.deathDate ?? existing.death_date ?? null,
    body.notes !== undefined ? body.notes : (existing.notes || null),
    nodeId
  );
  return db.prepare("SELECT * FROM family_nodes WHERE id = ?").get(nodeId);
}

export function deleteFamilyNode(user, nodeId) {
  const existing = db.prepare(
    `SELECT family_nodes.* FROM family_nodes
     JOIN family_trees ON family_trees.id = family_nodes.tree_id
     WHERE family_nodes.id = ? AND family_trees.user_id = ?`
  ).get(nodeId, user.id);
  if (!existing) throw new HttpError(404, "Persona no encontrada.");
  db.prepare("DELETE FROM family_nodes WHERE id = ?").run(nodeId); // las relaciones que la mencionan se borran solas
  return { ok: true };
}

// ---- Relaciones (vínculos entre dos personas) ----

export function createFamilyRelation(user, treeId, body) {
  const tree = db.prepare("SELECT * FROM family_trees WHERE id = ? AND user_id = ?").get(treeId, user.id);
  if (!tree) throw new HttpError(404, "Árbol no encontrado.");
  const { nodeId, relatedNodeId, type } = body;
  if (!nodeId || !relatedNodeId || !["padre", "madre", "pareja"].includes(type)) {
    throw new HttpError(400, "Faltan datos del vínculo.");
  }
  const id = newId("fr");
  db.prepare("INSERT INTO family_relations (id, tree_id, node_id, related_node_id, type) VALUES (?,?,?,?,?)")
    .run(id, treeId, nodeId, relatedNodeId, type);
  return db.prepare("SELECT * FROM family_relations WHERE id = ?").get(id);
}

export function deleteFamilyRelation(user, relationId) {
  const existing = db.prepare(
    `SELECT family_relations.* FROM family_relations
     JOIN family_trees ON family_trees.id = family_relations.tree_id
     WHERE family_relations.id = ? AND family_trees.user_id = ?`
  ).get(relationId, user.id);
  if (!existing) throw new HttpError(404, "Vínculo no encontrado.");
  db.prepare("DELETE FROM family_relations WHERE id = ?").run(relationId);
  return { ok: true };
}
