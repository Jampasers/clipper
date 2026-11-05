import { nanoid } from 'nanoid';
import fs from 'node:fs';
import { q, J } from '../lib/sqlite.js';
import { logger } from '../lib/log.js';
import {
  parseDesignDocument, serializeDesignDocument, emptyDocument,
  type DesignDocument, DesignSchemaError,
} from '../design/document.js';
import { resolveDesignAsset } from './design-assets.js';

/**
 * Design document persistence: documents, immutable version snapshots,
 * templates, reviews and generation records. Documents are stored as validated
 * JSON; every save creates a version row first (recoverable history) and bumps
 * the revision.
 */

export interface DesignRow {
  id: string;
  name: string;
  status: 'draft' | 'generating' | 'ready' | 'failed';
  width: number;
  height: number;
  document: string;
  schema_version: number;
  revision: number;
  category: string | null;
  tags: string | null;
  brief: string | null;
  thumbnail_path: string | null;
  job_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export class DesignNotFoundError extends Error {
  status = 404;
  constructor(message = 'design not found') {
    super(message);
    this.name = 'DesignNotFoundError';
  }
}

export interface DesignSummaryView {
  id: string;
  name: string;
  status: DesignRow['status'];
  width: number;
  height: number;
  revision: number;
  category: string | null;
  tags: string[];
  brief: string | null;
  thumbnail: string | null;
  jobId: string | null;
  error: string | null;
  layerCount: number;
  strategy: string | null;
  palette: string[];
  createdAt: string;
  updatedAt: string;
}

export function getDesignRow(id: string): DesignRow | undefined {
  return q.get<DesignRow>('SELECT * FROM design_documents WHERE id = ?', id);
}

export function getDesign(id: string): { row: DesignRow; doc: DesignDocument } {
  const row = getDesignRow(id);
  if (!row) throw new DesignNotFoundError();
  return { row, doc: parseDesignDocument(J.read(row.document) ?? {}) };
}

export function listDesigns(opts: { q?: string; category?: string; limit?: number } = {}): DesignSummaryView[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.category) { where.push('category = ?'); args.push(opts.category); }
  if (opts.q) { where.push('(name LIKE ? OR brief LIKE ? OR tags LIKE ?)'); args.push(`%${opts.q}%`, `%${opts.q}%`, `%${opts.q}%`); }
  const rows = q.all<DesignRow>(
    `SELECT * FROM design_documents ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT ?`,
    ...args,
    Math.min(500, opts.limit ?? 200)
  );
  return rows.map((r) => summarizeRow(r));
}

export function summarizeRow(row: DesignRow): DesignSummaryView {
  let doc: DesignDocument | undefined;
  try { doc = parseDesignDocument(J.read(row.document) ?? {}); } catch { doc = undefined; }
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    width: row.width,
    height: row.height,
    revision: row.revision,
    category: row.category,
    tags: row.tags ? String(row.tags).split(',').map((t) => t.trim()).filter(Boolean) : [],
    brief: row.brief,
    thumbnail: row.thumbnail_path ? `/media/design-thumbs/${basenameSafe(row.thumbnail_path)}` : null,
    jobId: row.job_id,
    error: row.error,
    layerCount: doc?.layers.length ?? 0,
    strategy: doc?.metadata.strategy ?? null,
    palette: doc?.metadata.palette ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function basenameSafe(p: string): string {
  return p.replace(/^.*[\\/]/, '');
}

export function createDesign(opts: { name?: string; width?: number; height?: number; brief?: string; category?: string; tags?: string; background?: string; id?: string; status?: DesignRow['status'] } = {}): DesignRow {
  const id = opts.id ?? nanoid(10);
  const doc = emptyDocument({ id, width: opts.width ?? 1080, height: opts.height ?? 1080, title: opts.name ?? 'Untitled design', background: opts.background });
  doc.metadata.brief = opts.brief;
  q.run(
    `INSERT INTO design_documents (id, name, status, width, height, document, schema_version, revision, category, tags, brief)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    (opts.name ?? doc.metadata.title).slice(0, 200),
    opts.status ?? 'draft',
    doc.canvas.width,
    doc.canvas.height,
    serializeDesignDocument(doc),
    doc.schemaVersion,
    1,
    opts.category ?? null,
    opts.tags ?? null,
    opts.brief ?? null
  );
  logger.info('DESIGN', `design created: ${id} (${doc.canvas.width}x${doc.canvas.height})`);
  return getDesignRow(id)!;
}

/** Save a document: snapshot the current revision, then replace + bump. */
export function saveDesign(id: string, raw: unknown, opts: { label?: string; name?: string; status?: DesignRow['status']; thumbnailPath?: string | null } = {}): { row: DesignRow; doc: DesignDocument } {
  const current = getDesignRow(id);
  if (!current) throw new DesignNotFoundError();
  const parsed = parseDesignDocument(raw);
  if (parsed.id !== id) throw new DesignSchemaError(`document id "${parsed.id}" does not match design "${id}"`);
  validateLibraryAssets(parsed);

  snapshotVersion(id, current.revision, current.document, opts.label ?? 'auto (before save)');
  const nextRevision = current.revision + 1;
  const doc: DesignDocument = { ...parsed, id, revision: nextRevision, schemaVersion: 1 };
  q.run(
    `UPDATE design_documents SET name = ?, status = ?, width = ?, height = ?, document = ?, schema_version = ?,
       revision = ?, category = ?, tags = ?, brief = ?, thumbnail_path = ?, error = NULL, updated_at = datetime('now')
     WHERE id = ?`,
    (opts.name ?? current.name).slice(0, 200),
    opts.status ?? 'ready',
    doc.canvas.width,
    doc.canvas.height,
    serializeDesignDocument(doc),
    doc.schemaVersion,
    nextRevision,
    doc.metadata.category ?? current.category,
    doc.metadata.tags?.length ? doc.metadata.tags.join(',') : current.tags,
    doc.metadata.brief ?? current.brief,
    opts.thumbnailPath === undefined ? current.thumbnail_path : opts.thumbnailPath,
    id
  );
  logger.info('DESIGN', `design saved: ${id} r${nextRevision} (${doc.layers.length} layers)`);
  return getDesign(id);
}

/** Replace the document without bumping (internal pipeline writes; caller snapshots). */
export function putDocument(id: string, doc: DesignDocument, opts: { status?: DesignRow['status']; jobId?: string | null; error?: string | null; thumbnailPath?: string | null; name?: string } = {}): DesignRow {
  const current = getDesignRow(id);
  if (!current) throw new DesignNotFoundError();
  q.run(
    `UPDATE design_documents SET status = ?, document = ?, width = ?, height = ?, name = ?, job_id = ?, error = ?, thumbnail_path = COALESCE(?, thumbnail_path), updated_at = datetime('now') WHERE id = ?`,
    opts.status ?? current.status,
    serializeDesignDocument(doc),
    doc.canvas.width,
    doc.canvas.height,
    (opts.name ?? current.name).slice(0, 200),
    opts.jobId === undefined ? current.job_id : opts.jobId,
    opts.error === undefined ? null : opts.error,
    opts.thumbnailPath === undefined ? null : opts.thumbnailPath,
    id
  );
  return getDesignRow(id)!;
}

export function setDesignStatus(id: string, status: DesignRow['status'], error: string | null = null): void {
  q.run("UPDATE design_documents SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?", status, error, id);
}

export function snapshotVersion(designId: string, revision: number, document: string, label?: string): void {
  q.run(
    `INSERT OR IGNORE INTO design_versions (design_id, revision, document, label) VALUES (?,?,?,?)`,
    designId,
    revision,
    document,
    label ?? null
  );
}

export interface VersionView {
  id: number;
  revision: number;
  label: string | null;
  layerCount: number;
  createdAt: string;
}

export function listVersions(designId: string): VersionView[] {
  if (!getDesignRow(designId)) throw new DesignNotFoundError();
  return q
    .all<{ id: number; revision: number; document: string; label: string | null; created_at: string }>(
      'SELECT id, revision, document, label, created_at FROM design_versions WHERE design_id = ? ORDER BY revision DESC LIMIT 100',
      designId
    )
    .map((r) => {
      let layerCount = 0;
      try { layerCount = parseDesignDocument(J.read(r.document) ?? {}).layers.length; } catch { /* corrupt snapshot */ }
      return { id: r.id, revision: r.revision, label: r.label, layerCount, createdAt: r.created_at };
    });
}

export function restoreVersion(designId: string, revision: number): { row: DesignRow; doc: DesignDocument } {
  const current = getDesignRow(designId);
  if (!current) throw new DesignNotFoundError();
  const version = q.get<{ document: string }>('SELECT document FROM design_versions WHERE design_id = ? AND revision = ?', designId, revision);
  if (!version) throw new DesignNotFoundError(`version ${revision} not found`);
  const doc = parseDesignDocument(J.read(version.document) ?? {});
  // keep a recoverable snapshot of the pre-restore state
  snapshotVersion(designId, current.revision, current.document, `auto (before restore to r${revision})`);
  const nextRevision = current.revision + 1;
  const restored: DesignDocument = { ...doc, id: designId, revision: nextRevision };
  q.run(
    "UPDATE design_documents SET document = ?, revision = ?, status = 'ready', error = NULL, updated_at = datetime('now') WHERE id = ?",
    serializeDesignDocument(restored),
    nextRevision,
    designId
  );
  logger.info('DESIGN', `design ${designId} restored to version r${revision} as r${nextRevision}`);
  return getDesign(designId);
}

export function duplicateDesign(id: string, name?: string): { row: DesignRow; doc: DesignDocument } {
  const { row, doc } = getDesign(id);
  const newId = nanoid(10);
  const copy: DesignDocument = { ...doc, id: newId, revision: 1, metadata: { ...doc.metadata, generation: { ...(doc.metadata.generation ?? {}), variantOf: id } } };
  q.run(
    `INSERT INTO design_documents (id, name, status, width, height, document, schema_version, revision, category, tags, brief)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    newId,
    (name ?? `${row.name} copy`).slice(0, 200),
    'ready',
    copy.canvas.width,
    copy.canvas.height,
    serializeDesignDocument(copy),
    copy.schemaVersion,
    1,
    row.category,
    row.tags,
    row.brief
  );
  logger.info('DESIGN', `design duplicated: ${id} -> ${newId}`);
  return getDesign(newId);
}

export function deleteDesign(id: string): boolean {
  const row = getDesignRow(id);
  if (!row) return false;
  if (row.thumbnail_path) {
    try { fs.rmSync(row.thumbnail_path, { force: true }); } catch { /* best effort */ }
  }
  q.run('DELETE FROM design_documents WHERE id = ?', id);
  logger.info('DESIGN', `design deleted: ${id}`);
  return true;
}

/** Every document asset must resolve to a live library asset. */
export function validateLibraryAssets(doc: DesignDocument): void {
  const missing = doc.assets.filter((a) => !resolveDesignAsset(a.assetId)).map((a) => a.assetId);
  if (missing.length) {
    throw new DesignSchemaError(`document references ${missing.length} missing/disabled library asset(s): ${missing.slice(0, 5).join(', ')}`);
  }
}

/* ---------------- templates ---------------- */

export interface TemplateRow {
  id: string;
  name: string;
  category: string | null;
  tags: string | null;
  document: string;
  thumbnail_path: string | null;
  builtin: number;
  created_at: string;
  updated_at: string;
}

export function listTemplates(category?: string): TemplateView[] {
  const rows = q.all<TemplateRow>(
    `SELECT * FROM design_templates ${category ? 'WHERE category = ?' : ''} ORDER BY builtin DESC, name ASC LIMIT 200`,
    ...(category ? [category] : [])
  );
  return rows.map((r) => {
    let layerCount = 0;
    let width = 0;
    let height = 0;
    try {
      const doc = parseDesignDocument(J.read(r.document) ?? {});
      layerCount = doc.layers.length;
      width = doc.canvas.width;
      height = doc.canvas.height;
    } catch { /* corrupt template */ }
    return { id: r.id, name: r.name, category: r.category, tags: r.tags, thumbnail_path: r.thumbnail_path, builtin: r.builtin, created_at: r.created_at, updated_at: r.updated_at, layerCount, width, height };
  });
}

export interface TemplateView {
  id: string;
  name: string;
  category: string | null;
  tags: string | null;
  thumbnail_path: string | null;
  builtin: number;
  layerCount: number;
  width: number;
  height: number;
  created_at: string;
  updated_at: string;
}

export function getTemplate(id: string): TemplateRow | undefined {
  return q.get<TemplateRow>('SELECT * FROM design_templates WHERE id = ?', id);
}

export function createTemplate(opts: { name: string; document: unknown; category?: string; tags?: string; thumbnailPath?: string | null }): TemplateRow {
  const doc = parseDesignDocument(opts.document);
  validateLibraryAssets(doc);
  const id = nanoid(10);
  q.run(
    `INSERT INTO design_templates (id, name, category, tags, document, thumbnail_path) VALUES (?,?,?,?,?,?)`,
    id,
    opts.name.slice(0, 200),
    opts.category ?? null,
    opts.tags ?? null,
    serializeDesignDocument(doc),
    opts.thumbnailPath ?? null
  );
  logger.info('DESIGN', `template created: ${id} "${opts.name}"`);
  return getTemplate(id)!;
}

export function duplicateTemplate(id: string, name?: string): TemplateRow {
  const t = getTemplate(id);
  if (!t) throw new DesignNotFoundError('template not found');
  return createTemplate({ name: name ?? `${t.name} copy`, document: J.read(t.document), category: t.category ?? undefined, tags: t.tags ?? undefined });
}

/** Apply a template: clone its document into a new (or existing) design. */
export function applyTemplate(templateId: string, opts: { designId?: string; name?: string } = {}): { row: DesignRow; doc: DesignDocument } {
  const t = getTemplate(templateId);
  if (!t) throw new DesignNotFoundError('template not found');
  const doc = parseDesignDocument(J.read(t.document) ?? {});
  if (opts.designId) {
    return saveDesign(opts.designId, { ...doc, id: opts.designId, revision: 1 }, { label: `auto (template ${t.name})` });
  }
  const id = nanoid(10);
  const instance: DesignDocument = { ...doc, id, revision: 1, metadata: { ...doc.metadata, title: opts.name ?? t.name, generation: undefined } };
  q.run(
    `INSERT INTO design_documents (id, name, status, width, height, document, schema_version, revision, category, tags)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id,
    (opts.name ?? t.name).slice(0, 200),
    'ready',
    instance.canvas.width,
    instance.canvas.height,
    serializeDesignDocument(instance),
    instance.schemaVersion,
    1,
    t.category,
    t.tags
  );
  return getDesign(id);
}

export function deleteTemplate(id: string): boolean {
  const t = getTemplate(id);
  if (!t) return false;
  if (t.builtin) throw Object.assign(new Error('built-in templates cannot be deleted'), { status: 400 });
  q.run('DELETE FROM design_templates WHERE id = ?', id);
  return true;
}

/* ---------------- reviews ---------------- */

export function saveReview(designId: string, revision: number, source: string, score: number | null, data: unknown): number {
  const res = q.run(
    `INSERT INTO design_reviews (design_id, revision, source, score, data) VALUES (?,?,?,?,?)`,
    designId,
    revision,
    source,
    score,
    JSON.stringify(data)
  );
  return Number(res.lastInsertRowid);
}

export function listReviews(designId: string, limit = 20) {
  return q
    .all<{ id: number; revision: number; source: string; score: number | null; data: string; created_at: string }>(
      'SELECT * FROM design_reviews WHERE design_id = ? ORDER BY id DESC LIMIT ?',
      designId,
      limit
    )
    .map((r) => ({ id: r.id, revision: r.revision, source: r.source, score: r.score, data: J.read(r.data), createdAt: r.created_at }));
}
