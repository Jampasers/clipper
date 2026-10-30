import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { config } from '../config.js';
import { logger } from '../lib/log.js';
import { authorizationCheck, TelegramClient, type TgUpdate } from './client.js';
import { createProject, getProject, projectSummary, listProjects } from '../services/projects.js';
import { listClips, clipView, getClip } from '../services/clips.js';
import { enqueueProjectPipeline } from '../services/pipeline.js';
import { getSettings } from '../lib/settings.js';
import { runHealthChecks } from '../lib/health.js';

/**
 * Telegram bot: same backend services as the web UI — no business logic here.
 * Access is restricted to TELEGRAM_ALLOWED_USER_ID (numeric id comparison).
 */

const MAX_TG_UPLOAD = 49 * 1024 * 1024; // Bot API sendVideo limit

export function startTelegram(): () => void {
  if (!config.telegram.token) {
    logger.info('TELEGRAM', 'TELEGRAM_BOT_TOKEN not set — bot disabled');
    return () => {};
  }
  const client = new TelegramClient(config.telegram.token);
  let offset = 0;
  let stopped = false;

  const loop = async () => {
    logger.info('TELEGRAM', 'bot polling started');
    while (!stopped) {
      try {
        const updates = await client.call<TgUpdate[]>('getUpdates', {
          offset,
          timeout: 25,
          allowed_updates: ['message', 'callback_query'],
        });
        for (const u of updates) {
          offset = u.update_id + 1;
          await handleUpdate(client, u).catch((e) => logger.error('TELEGRAM', `update handling failed: ${e?.message}`));
        }
      } catch (e: any) {
        logger.error('TELEGRAM', `poll failed: ${String(e?.message).slice(0, 200)}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}

async function handleUpdate(client: TelegramClient, u: TgUpdate): Promise<void> {
  if (u.callback_query) {
    const cb = u.callback_query;
    const auth = authorizationCheck(cb.from?.id);
    if (!auth.ok) {
      logger.warn('TELEGRAM', `rejected callback: ${auth.reason}`);
      void client.call('answerCallbackQuery', { callback_query_id: cb.id, text: 'Unauthorized' });
      return;
    }
    await client.call('answerCallbackQuery', { callback_query_id: cb.id });
    if (cb.data && cb.message) await handleCallback(client, cb.message.chat.id, cb.data, cb.message.message_id);
    return;
  }
  const msg = u.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const auth = authorizationCheck(msg.from?.id);
  if (!auth.ok) {
    logger.warn('TELEGRAM', `rejected message from ${msg.from?.id}: ${auth.reason}`);
    await client.sendMessage(chatId, '⛔ Not authorized.');
    return;
  }

  if (msg.video || (msg.document && String(msg.document.mime_type).startsWith('video/'))) {
    await handleVideo(client, chatId, msg);
    return;
  }
  if (!msg.text) return;
  const text = msg.text.trim();
  if (text.startsWith('/start')) {
    await client.sendMessage(chatId, [
      '<b>AI Video Clipper</b>',
      '',
      'Send me a video (up to ~20MB via Telegram) and I will:',
      '1. Transcribe it',
      '2. Find + score the best clips',
      '3. Let you pick clips to render with subtitles',
      '',
      '/projects — list projects',
      '/clips — candidates for the latest project',
      '/render — render the top clip',
      '/health — system health',
      '/help — this message',
    ].join('\n'));
  } else if (text.startsWith('/help')) {
    await client.sendMessage(chatId, 'Send a video to start. /projects /clips /render /health. Settings live in the web dashboard.');
  } else if (text.startsWith('/projects')) {
    const ps = listProjects(8);
    if (!ps.length) return void (await client.sendMessage(chatId, 'No projects yet. Send me a video!'));
    const lines = ps.map((p) => `• <b>${escapeHtml(p.name)}</b> — ${p.status} (${p.id})`);
    await client.sendMessage(chatId, `<b>Projects</b>\n${lines.join('\n')}`);
  } else if (text.startsWith('/clips')) {
    const project = latestReadyProject();
    if (!project) return void (await client.sendMessage(chatId, 'No analyzed project ready yet. /projects to see status.'));
    await sendCandidates(client, chatId, project.id);
  } else if (text.startsWith('/render')) {
    const project = latestReadyProject();
    if (!project) return void (await client.sendMessage(chatId, 'Nothing ready to render.'));
    const clips = listClips({ projectId: project.id, status: 'selected' });
    if (!clips.length) return void (await client.sendMessage(chatId, 'No selected clips. Use the clip buttons first.'));
    await client.sendMessage(chatId, `Rendering ${clips.length} clip(s)…`);
    for (const c of clips) {
      const { enqueueRender } = await import('../services/pipeline.js');
      enqueueRender(c.id, 'telegram');
    }
  } else if (text.startsWith('/health')) {
    const h = await runHealthChecks();
    const lines = h.items.map((i) => `${i.ok ? '✅' : '❌'} ${i.name}: ${i.detail}`);
    await client.sendMessage(chatId, `<b>Health</b>\n${lines.join('\n')}`);
  } else {
    await client.sendMessage(chatId, 'Unknown command. /help for options.');
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));
}

function latestReadyProject() {
  const ps = listProjects(20);
  return ps.find((p) => p.status === 'READY' || p.status === 'COMPLETED' || p.status === 'RENDERING');
}

async function handleVideo(client: TelegramClient, chatId: number, msg: NonNullable<TgUpdate['message']>): Promise<void> {
  const video = msg.video ?? msg.document;
  if (!video?.file_id) {
    await client.sendMessage(chatId, 'Send a video file or a video document.');
    return;
  }
  const size = video.file_size ?? 0;
  // Bot API caps getFile downloads at 20 MB; larger files fail server-side.
  if (size > 20 * 1024 * 1024) {
    await client.sendMessage(chatId, 'File too large for the bot (20 MB max via getFile). Upload big files in the web dashboard.');
    return;
  }
  const statusMsg = await client.sendMessage(chatId, '📥 Downloading video…');
  try {
    const url = await client.getFileDownloadUrl(video.file_id);
    const name = path.basename(video.file_name || `tg_${Date.now()}.mp4`);
    const tmpPath = path.join(config.dirs.input, `tg_${Date.now()}_${name.replace(/[^\w.-]/g, '_')}`);
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(tmpPath));

    const project = createProject(name.replace(/\.[^.]+$/, '') || 'telegram upload', tmpPath);
    await client.editMessageText(chatId, statusMsg.message_id, `✅ Downloaded. Project <b>${escapeHtml(project.name)}</b> (${project.id})\nStarting pipeline: transcribe → analyze → clips → score…`);
    enqueueProjectPipeline(project.id);
    await watchProject(client, chatId, project.id, statusMsg.message_id);
  } catch (e: any) {
    logger.error('TELEGRAM', `video handling failed: ${e?.message}`);
    await client.editMessageText(chatId, statusMsg.message_id, `❌ ${escapeHtml(String(e?.message).slice(0, 300))}`);
  }
}

/** Poll project status and push progress updates to the chat. */
async function watchProject(client: TelegramClient, chatId: number, projectId: string, messageId: number): Promise<void> {
  if (!getSettings('telegram').send_progress) return;
  let lastLine = '';
  for (let i = 0; i < 1000; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const p = getProject(projectId);
    if (!p) return;
    const summary = projectSummary(projectId);
    const job = summary?.nextJob ?? summary?.activeJobs?.[0];
    const line = job ? `${p.status} — ${job.type} ${job.progress}%` : p.status;
    if (line !== lastLine) {
      lastLine = line;
      try { await client.editMessageText(chatId, messageId, `⚙️ ${escapeHtml(p.name)}\n${escapeHtml(line)}`); } catch { /* same text */ }
    }
    if (['READY', 'FAILED', 'COMPLETED'].includes(p.status)) {
      if (p.status === 'READY') await sendCandidates(client, chatId, projectId, messageId);
      else await client.editMessageText(chatId, messageId, `❌ Processing failed: ${escapeHtml(p.error ?? 'unknown error')}\nRetry from the dashboard.`);
      return;
    }
  }
}

async function sendCandidates(client: TelegramClient, chatId: number, projectId: string, editMessageId?: number): Promise<void> {
  const clips = listClips({ projectId, status: 'selected' });
  const project = getProject(projectId);
  const text = [
    `🎬 <b>${escapeHtml(project?.name ?? projectId)}</b> — top ${clips.length} clips:`,
    '',
    ...clips.map((c) => {
      const v = clipView(c);
      return `#${String(v.ord).padStart(2, '0')} <b>${v.overall?.toFixed(0) ?? '?'}</b>/100 — ${escapeHtml(v.title ?? '')}\n   ${v.start.toFixed(0)}s → ${v.end.toFixed(0)}s (${v.duration.toFixed(0)}s)`;
    }),
    '',
    'Tap a clip to render it with subtitles.',
  ].join('\n');
  const keyboard = clips.map((c) => [{
    text: `▶️ #${c.ord} ${c.title?.slice(0, 24) ?? ''} (${c.overall?.toFixed(0) ?? '?'})`,
    callback_data: `render:${c.id}`,
  }]);
  const extra = { reply_markup: { inline_keyboard: keyboard } };
  if (editMessageId) {
    try { await client.editMessageText(chatId, editMessageId, text, extra as any); return; } catch { /* fallthrough */ }
  }
  await client.sendMessage(chatId, text, extra);
}

async function handleCallback(client: TelegramClient, chatId: number, data: string, messageId: number): Promise<void> {
  const [action, clipId] = data.split(':');
  if (action === 'render' && clipId) {
    const clip = getClip(clipId);
    if (!clip) return void (await client.sendMessage(chatId, 'Clip not found.'));
    await client.editMessageText(chatId, messageId, `⏳ Rendering "#${clip.ord} ${clip.title ?? ''}"…`);
    const { enqueueRender } = await import('../services/pipeline.js');
    enqueueRender(clipId, 'telegram');
    await watchRender(client, chatId, clipId, messageId);
  } else if (action === 'again') {
    const project = latestReadyProject();
    if (project) await sendCandidates(client, chatId, project.id, messageId);
  }
}

async function watchRender(client: TelegramClient, chatId: number, clipId: string, messageId: number): Promise<void> {
  const clip = getClip(clipId)!;
  for (let i = 0; i < 500; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const fresh = getClip(clipId);
    if (!fresh) return;
    const finalPath = path.join(config.dirs.output, `${clipId}_telegram.mp4`);
    const finalPathStd = path.join(config.dirs.output, `${clipId}_final.mp4`);
    const filePath = fs.existsSync(finalPath) ? finalPath : fs.existsSync(finalPathStd) ? finalPathStd : null;
    if (!filePath) {
      const p = getProject(clip.project_id);
      if (p?.status === 'FAILED') {
        await client.editMessageText(chatId, messageId, `❌ Render failed. Check the dashboard logs.`);
        return;
      }
      continue;
    }
    const size = fs.statSync(filePath).size;
    try {
      if (size > MAX_TG_UPLOAD) {
        await client.editMessageText(chatId, messageId, `✅ Clip rendered (${(size / 1e6).toFixed(1)}MB — too large for Telegram).\nAvailable at: ${filePath}`);
      } else {
        await client.editMessageText(chatId, messageId, `📤 Sending "#${clip.ord} ${clip.title ?? ''}"…`);
        await client.sendVideo(chatId, filePath, `#${clip.ord} ${clip.title ?? ''} — score ${clip.overall?.toFixed(0) ?? '?'}`);
        await client.sendMessage(chatId, 'Pick another clip?', { reply_markup: { inline_keyboard: [[{ text: '🎞 Clips', callback_data: 'again:x' }]] } });
      }
    } catch (e: any) {
      logger.error('TELEGRAM', `send failed: ${e?.message}`);
      await client.sendMessage(chatId, `❌ Could not send clip: ${escapeHtml(String(e?.message).slice(0, 200))}`);
    }
    return;
  }
}
