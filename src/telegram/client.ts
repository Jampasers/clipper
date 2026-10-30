import fs from 'node:fs';
import { config } from '../config.js';
import { logger } from '../lib/log.js';

/**
 * Minimal Telegram Bot API client using fetch (no extra dependency).
 * Long-polling getUpdates loop; only the configured numeric user id is allowed.
 */

interface TgUser { id: number; username?: string; first_name?: string }
export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number };
  text?: string;
  video?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number; duration: number; width: number; height: number };
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
}
export interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: { id: string; from: TgUser; data?: string; message?: TgMessage } }

export class TelegramClient {
  constructor(private token: string) {}
  private get base() {
    return `https://api.telegram.org/bot${this.token}`;
  }
  async call<T = any>(method: string, payload?: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    });
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!json.ok) throw new Error(`telegram ${method} failed: ${json.description}`);
    return json.result as T;
  }
  sendMessage(chatId: number, text: string, extra: Record<string, unknown> = {}) {
    return this.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
  }
  editMessageText(chatId: number, messageId: number, text: string, extra: Record<string, unknown> = {}) {
    return this.call('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...extra });
  }
  sendVideo(chatId: number, filePath: string, caption = '') {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', caption);
    form.append('supports_streaming', 'true');
    const blob = new Blob([fs.readFileSync(filePath)]);
    form.append('video', blob, filePath.split(/[\\/]/).pop());
    return fetch(`${this.base}/sendVideo`, { method: 'POST', body: form }).then(async (r) => {
      const j = (await r.json()) as { ok: boolean; description?: string };
      if (!j.ok) throw new Error(`telegram sendVideo failed: ${j.description}`);
    });
  }
  async getFileDownloadUrl(fileId: string): Promise<string> {
    const file = await this.call<{ file_path: string }>('getFile', { file_id: fileId });
    return `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
  }
}

export function authorizationCheck(userId: number | undefined): { ok: boolean; reason?: string } {
  const allowed = config.telegram.allowedUserId;
  if (!allowed) return { ok: false, reason: 'TELEGRAM_ALLOWED_USER_ID is not configured' };
  if (userId === undefined) return { ok: false, reason: 'no user id' };
  if (String(userId) !== String(allowed).trim()) return { ok: false, reason: 'unauthorized user' };
  return { ok: true };
}
