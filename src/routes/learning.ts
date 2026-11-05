import { Router } from 'express';
import { q } from '../lib/sqlite.js';
import { requireAuth } from '../lib/middleware.js';
import {
  FEATURE_SPECS, PREFERENCE_FEATURES, currentInsights, deletePreference, listPreferences, listSnapshots,
  learningHistory, learningStats, resolvePreferences, resetPreferences, restoreSnapshot,
  runLearningUpdate, setManualPreference, updatePreference, valueLabel,
  type PreferenceFeature,
} from '../services/learning.js';

export const learningRouter = Router();
learningRouter.use(requireAuth);

/* ---------------- preferences ---------------- */

learningRouter.get('/preferences', (req, res, next) => {
  try {
    const contextKey = typeof req.query.context === 'string' ? req.query.context.trim().toLowerCase().slice(0, 40) : '';
    const rows = listPreferences(contextKey ? { contextKey } : {});
    const effective = resolvePreferences(contextKey);
    res.json({
      features: PREFERENCE_FEATURES,
      specs: PREFERENCE_FEATURES.map((f) => ({
        feature: f,
        kind: FEATURE_SPECS[f].kind,
        options: FEATURE_SPECS[f].options ?? null,
        label: f.replace(/_/g, ' '),
      })),
      preferences: rows,
      effective: [...effective.values()].map((p) => ({
        feature: p.feature,
        value: p.value.value,
        kind: p.value.kind,
        label: valueLabel(p.value),
        confidence: p.confidence,
        contextKey: p.contextKey,
        source: p.source,
      })),
    });
  } catch (e) {
    next(e);
  }
});

learningRouter.put('/preferences', (req, res, next) => {
  try {
    const b = req.body ?? {};
    if (typeof b.feature !== 'string' || !b.feature) return res.status(400).json({ error: 'feature is required' });
    const contextKey = typeof b.contextKey === 'string' ? b.contextKey.trim().toLowerCase().slice(0, 40) : '';
    const pref = setManualPreference(b.feature, contextKey, b.value, {
      confidence: typeof b.confidence === 'number' ? b.confidence : undefined,
      status: b.status === 'suppressed' ? 'suppressed' : 'active',
    });
    res.json({ preference: pref });
  } catch (e) {
    next(e);
  }
});

learningRouter.patch('/preferences/:id', (req, res, next) => {
  try {
    const b = req.body ?? {};
    const updated = updatePreference(String(req.params.id), {
      value: b.value,
      confidence: typeof b.confidence === 'number' ? b.confidence : undefined,
      status: b.status === 'active' || b.status === 'suppressed' ? b.status : undefined,
    });
    if (!updated) return res.status(404).json({ error: 'preference not found' });
    res.json({ preference: updated });
  } catch (e) {
    next(e);
  }
});

learningRouter.delete('/preferences/:id', (req, res, next) => {
  try {
    if (!deletePreference(String(req.params.id))) return res.status(404).json({ error: 'preference not found' });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/* ---------------- dashboard data ---------------- */

learningRouter.get('/insights', (_req, res, next) => {
  try {
    res.json({ insights: currentInsights(20) });
  } catch (e) {
    next(e);
  }
});

learningRouter.get('/stats', (_req, res, next) => {
  try {
    res.json(learningStats());
  } catch (e) {
    next(e);
  }
});

learningRouter.get('/events', (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const context = typeof req.query.context === 'string' ? req.query.context.trim().toLowerCase() : '';
    const rows = q.all<unknown>(
      `SELECT id, event_type, feature, source, prev_value, new_value, context, clip_id, weight, status, created_at
       FROM learning_events ${context ? "WHERE json_extract(context, '$.contextKey') = ?" : ''} ORDER BY created_at DESC LIMIT ?`,
      ...(context ? [context, limit] : [limit])
    );
    res.json({ events: rows });
  } catch (e) {
    next(e);
  }
});

learningRouter.get('/history', (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const kind = req.query.kind === 'runs' || req.query.kind === 'events' ? req.query.kind : undefined;
    res.json(learningHistory({ limit, kind }));
  } catch (e) {
    next(e);
  }
});

learningRouter.post('/update', (_req, res, next) => {
  try {
    const run = runLearningUpdate('rebuild');
    res.json({ ok: true, run });
  } catch (e) {
    next(e);
  }
});

/* ---------------- snapshots + reset ---------------- */

learningRouter.get('/snapshots', (_req, res, next) => {
  try {
    res.json({ snapshots: listSnapshots() });
  } catch (e) {
    next(e);
  }
});

learningRouter.post('/snapshots/:id/restore', (req, res, next) => {
  try {
    const result = restoreSnapshot(String(req.params.id));
    res.json({ ok: true, ...result });
  } catch (e) {
    next(e);
  }
});

learningRouter.post('/reset', (req, res, next) => {
  try {
    const b = req.body ?? {};
    const scope = b.scope === 'all' || b.scope === 'context' || b.scope === 'feature' || b.scope === 'learned' ? b.scope : 'learned';
    const contextKey = typeof b.contextKey === 'string' && scope === 'context' ? b.contextKey.trim().toLowerCase().slice(0, 40) : undefined;
    const feature = typeof b.feature === 'string' && scope === 'feature' ? b.feature : undefined;
    const result = resetPreferences({
      ...(feature && PREFERENCE_FEATURES.includes(feature as PreferenceFeature) ? { feature: feature as PreferenceFeature } : {}),
      ...(contextKey !== undefined ? { contextKey } : {}),
      includeManual: scope === 'all',
    });
    runLearningUpdate('rebuild');
    res.json({ ok: true, ...result });
  } catch (e) {
    next(e);
  }
});
