import { generate } from '../lib/ai.js';
import { logger } from '../lib/log.js';
import { listMusic, getMusic, type MusicRow } from './assets.js';
import { formatTranscriptForPrompt, type TranscriptData } from './transcribe.js';

/**
 * AI background music selection against the local music library. Only local,
 * user-provided (legal) assets are ever used — nothing is downloaded.
 */

export interface MusicPlan {
  assetId: string;
  name: string;
  mood: string | null;
  reason: string;
  source: 'ai' | 'manual' | 'fallback';
}

export const MUSIC_MOODS = ['motivational', 'emotional', 'funny', 'dramatic', 'educational', 'documentary', 'relaxed', 'cinematic'];

export function libraryPromptLines(library: MusicRow[]): string {
  return library
    .map((m) => `${m.id} | ${m.name} | mood=${m.mood ?? '?'} | genre=${m.genre ?? '?'} | energy=${m.energy} | bpm=${m.bpm ?? '?'}`)
    .join('\n');
}

/** Deterministic best-effort match: keyword overlap between transcript and mood/genre tags. */
export function fallbackMusicPick(excerpt: string, library: MusicRow[]): { asset: MusicRow; score: number } | null {
  if (!library.length) return null;
  const text = excerpt.toLowerCase();
  let best: { asset: MusicRow; score: number } | null = null;
  for (const m of library) {
    let score = 0;
    const tags = [m.mood, m.genre].filter(Boolean).flatMap((t) => String(t).toLowerCase().split(/[^a-z]+/));
    for (const tag of new Set(tags)) {
      if (tag.length >= 4 && text.includes(tag)) score += 3;
    }
    // transcripts almost never contain literal mood words; prefer mid energy
    score += Math.max(0, 2 - Math.abs(m.energy - 3));
    if (!best || score > best.score) best = { asset: m, score };
  }
  if (library.length === 1) return best; // single asset = explicit intent
  return best && best.score >= 3 ? best : null;
}

/**
 * Resolve the background music for a render job.
 * selection: 'none' | 'ai' | <music asset id>. Never throws.
 */
export async function selectMusic(
  transcript: TranscriptData | null,
  clipStart: number,
  clipEnd: number,
  title: string | null,
  selection: string
): Promise<MusicPlan | null> {
  if (!selection || selection === 'none') return null;
  if (selection !== 'ai') {
    const manual = getMusic(selection);
    if (!manual) {
      logger.warn('RENDER', `manual music asset ${selection} not found; rendering without BGM`);
      return null;
    }
    return { assetId: manual.id, name: manual.name, mood: manual.mood, reason: 'manually selected', source: 'manual' };
  }

  const library = listMusic(true);
  if (!library.length) {
    logger.info('AI', 'music selection skipped: library is empty');
    return null;
  }
  const excerpt = transcript
    ? formatTranscriptForPrompt(transcript.segments, { start: clipStart, end: clipEnd, maxChars: 4000 })
    : '';
  try {
    const { json } = await generate<{ use_music?: boolean; asset_id?: string; reason?: string; mood?: string }>('music_selection', {
      title: title ?? '',
      clip_duration: Math.max(0, clipEnd - clipStart).toFixed(1),
      transcript: excerpt || '(no transcript)',
      library: libraryPromptLines(library),
    });
    if (json?.use_music === false) return null;
    const asset = library.find((m) => m.id === json?.asset_id);
    if (!asset) {
      logger.warn('AI', `music selection returned unknown asset "${String(json?.asset_id).slice(0, 40)}"; using failover`);
    } else {
      return {
        assetId: asset.id,
        name: asset.name,
        mood: json?.mood ?? asset.mood,
        reason: (json?.reason ?? 'AI selected').slice(0, 300),
        source: 'ai',
      };
    }
  } catch (err: any) {
    logger.warn('AI', `music selection failed (${String(err?.message).slice(0, 160)}); using deterministic pick`);
  }
  const pick = fallbackMusicPick(excerpt, library);
  if (!pick) {
    logger.info('AI', 'no suitable music found; rendering without BGM');
    return null;
  }
  return {
    assetId: pick.asset.id,
    name: pick.asset.name,
    mood: pick.asset.mood,
    reason: 'deterministic fallback (closest mood/energy match)',
    source: 'fallback',
  };
}

/** Resolve a stored plan back to a playable file; missing files never fail a render. */
export function resolveMusicFile(plan: MusicPlan | null): string | null {
  if (!plan) return null;
  const asset = getMusic(plan.assetId);
  if (!asset || !asset.enabled) {
    logger.warn('RENDER', `music asset ${plan.assetId} unavailable; rendering without BGM`);
    return null;
  }
  return asset.file_path;
}
