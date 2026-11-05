import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { getSettings } from '../lib/settings.js';
import { probeVideo } from '../lib/ffmpeg.js';
import { logger } from '../lib/log.js';

/**
 * Independent image-generation provider abstraction.
 *
 * The 9Router chat endpoint is NOT assumed to support image generation. A
 * provider must be explicitly configured (design.image_provider). When none is
 * configured we throw ImageGenerationUnavailableError — we never fabricate an
 * asset or pretend generation succeeded. API keys stay server-side.
 */

export interface GenerateImageInput {
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  referenceImages?: string[];
}

export interface GeneratedImage {
  filePath: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  model: string;
  prompt: string;
}

export interface ImageGenerationProvider {
  readonly name: string;
  generate(input: GenerateImageInput): Promise<GeneratedImage>;
}

export class ImageGenerationUnavailableError extends Error {
  status = 503;
  constructor(message: string) {
    super(message);
    this.name = 'ImageGenerationUnavailableError';
  }
}

export class ImageProviderError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'ImageProviderError';
    this.status = status;
  }
}

export const IMAGE_MAX_BYTES = 30 * 1024 * 1024;

export function imageProviderStatus(): { configured: boolean; provider: string; model: string; baseUrl: string } {
  const d = getSettings('design');
  const ai = getSettings('ai');
  const baseUrl = d.image_base_url || ai.base_url;
  const configured = d.image_provider !== 'none' && !!baseUrl && !!d.image_model.trim();
  return { configured, provider: d.image_provider, model: d.image_model, baseUrl };
}

function sniffMime(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length > 8 && buf.subarray(0, 4).toString('hex') === '89504e47') return { mime: 'image/png', ext: '.png' };
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return { mime: 'image/jpeg', ext: '.jpg' };
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
  return null;
}

/** OpenAI-compatible /images/generations adapter. */
class OpenAiImagesProvider implements ImageGenerationProvider {
  readonly name = 'openai_images';

  async generate(input: GenerateImageInput): Promise<GeneratedImage> {
    const d = getSettings('design');
    const ai = getSettings('ai');
    const baseUrl = (d.image_base_url || ai.base_url).replace(/\/+$/, '');
    const apiKey = d.image_api_key || ai.api_key;
    if (!baseUrl) throw new ImageGenerationUnavailableError('no image provider base URL configured');
    if (!apiKey) throw new ImageGenerationUnavailableError('no API key configured for image generation');

    const url = `${baseUrl}/images/generations`;
    const body = {
      model: d.image_model,
      prompt: input.negativePrompt ? `${input.prompt}\n\nAvoid: ${input.negativePrompt}` : input.prompt,
      n: 1,
      size: `${Math.round(input.width)}x${Math.round(input.height)}`,
      response_format: 'b64_json',
    };

    const retries = Math.max(0, d.image_retries);
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.call(url, apiKey, body, input, d.image_timeout_ms);
      } catch (err) {
        lastErr = err;
        const status = err instanceof ImageProviderError ? err.status : 500;
        const retriable = status === 408 || status === 409 || status === 429 || status >= 500;
        if (!retriable || attempt === retries) break;
        await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  private async call(
    url: string,
    apiKey: string,
    body: Record<string, unknown>,
    input: GenerateImageInput,
    timeoutMs: number
  ): Promise<GeneratedImage> {
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(5000, timeoutMs)),
      });
    } catch (err: any) {
      const reason = err?.cause?.code || err?.name || 'network error';
      throw new ImageProviderError(`image provider request failed (${reason})`, 502);
    }
    const text = await res.text();
    if (!res.ok) {
      const msg = text.slice(0, 300).replace(/\s+/g, ' ');
      throw new ImageProviderError(`image provider returned ${res.status}: ${msg}`, res.status);
    }
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { throw new ImageProviderError('image provider returned non-JSON', 502); }
    const item = parsed?.data?.[0];
    let bytes: Buffer | null = null;
    if (item?.b64_json) {
      bytes = Buffer.from(String(item.b64_json), 'base64');
    } else if (item?.url) {
      const imgRes = await fetch(String(item.url), { signal: AbortSignal.timeout(Math.max(5000, timeoutMs)) });
      if (!imgRes.ok) throw new ImageProviderError(`image download failed (${imgRes.status})`, 502);
      bytes = Buffer.from(await imgRes.arrayBuffer());
    }
    if (!bytes || bytes.length < 64) throw new ImageProviderError('image provider returned no image data', 502);
    if (bytes.length > IMAGE_MAX_BYTES) throw new ImageProviderError(`generated image too large (${bytes.length} bytes)`, 413);
    const sniff = sniffMime(bytes);
    if (!sniff) throw new ImageProviderError('generated content is not a supported image (png/jpg/webp)', 502);

    const tmpPath = path.join(config.dirs.temp, `gen_${nanoid(10)}${sniff.ext}`);
    fs.writeFileSync(tmpPath, bytes);

    // dimension validation from the real file, never from provider claims
    const probe = await probeVideo(tmpPath).catch(() => null);
    if (!probe || !probe.hasVideo || !probe.width || !probe.height) {
      fs.rmSync(tmpPath, { force: true });
      throw new ImageProviderError('generated image could not be decoded', 502);
    }
    if (probe.width < 64 || probe.height < 64) {
      fs.rmSync(tmpPath, { force: true });
      throw new ImageProviderError(`generated image is too small (${probe.width}x${probe.height})`, 502);
    }
    logger.info('DESIGN', `image generated: ${probe.width}x${probe.height} ${sniff.mime} in ${Date.now() - started}ms (model ${String(body.model)})`);
    return {
      filePath: tmpPath,
      mime: sniff.mime,
      width: probe.width,
      height: probe.height,
      bytes: bytes.length,
      model: String(body.model),
      prompt: input.prompt,
    };
  }
}

export function getImageProvider(): ImageGenerationProvider | null {
  const status = imageProviderStatus();
  if (!status.configured) return null;
  if (status.provider === 'openai_images') return new OpenAiImagesProvider();
  return null;
}

export async function generateImage(input: GenerateImageInput): Promise<GeneratedImage> {
  const provider = getImageProvider();
  if (!provider) {
    throw new ImageGenerationUnavailableError(
      'image generation is not configured; enable it in Settings → Design Studio (provider + model), or upload your own images'
    );
  }
  if (!input.prompt || input.prompt.trim().length < 3) throw new ImageProviderError('image prompt is empty', 400);
  return provider.generate(input);
}

/** Capability check used by settings UI — performs a real (small) generation. */
export async function testImageProvider(): Promise<{ ok: boolean; error?: string; model?: string }> {
  try {
    const img = await generateImage({ prompt: 'a plain solid deep navy blue background, no text', width: 256, height: 256 });
    try { fs.rmSync(img.filePath, { force: true }); } catch { /* temp */ }
    return { ok: true, model: img.model };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err).slice(0, 400) };
  }
}
