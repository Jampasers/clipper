import type { DesignDocument, DesignLayer, ImageLayer, ShapeLayer, TextLayer, GroupLayer, Gradient } from './document.js';
import { resolveTextLayout } from './typography.js';

/**
 * Deterministic DesignDocument → SVG renderer.
 *
 * SVG is the canonical composition format: the editor canvas, previews, export
 * files and the PNG/JPG/PDF rasterizer all consume this one rendering path, so
 * what the user edits is exactly what gets exported. All user text is XML
 * escaped; nothing from the document is ever evaluated as code.
 *
 * `assetHref`/`fontHref` resolve library references to URLs (preview, cookie
 * authenticated) or data URIs (embed/export). Missing assets render a visible
 * placeholder — never a silent blank.
 */

export interface RenderOptions {
  mode: 'preview' | 'embed';
  /** doc asset local id -> href */
  assetHref: (asset: { id: string; assetId: string }) => string | null;
  /** custom font family -> href (data URI or media URL) */
  fontHref?: (family: string) => { href: string; mime: string } | null;
}

export function xmlEscape(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s).replace(/[&<>"']/g, (c) => map[c] ?? c);
}

function safeFamily(family: string): string {
  return String(family).replace(/[^\w\s-]/g, '').trim().slice(0, 80) || 'Arial';
}

function num(n: number): string {
  return String(Math.round(n * 100) / 100);
}

export function renderDocumentSvg(doc: DesignDocument, opts: RenderOptions): string {
  const { width: W, height: H } = doc.canvas;
  const assetById = new Map(doc.assets.map((a) => [a.id, a]));
  const resolveAsset = (localId: string): string | null => {
    const asset = assetById.get(localId);
    if (!asset) return null;
    return opts.assetHref(asset);
  };

  const gradientDefs: string[] = [];
  const gradientIds = new Map<string, string>();
  const clipDefs: string[] = [];
  const fontDefs = new Set<string>();
  let gradSeq = 0;
  let clipSeq = 0;

  const gradientId = (g: Gradient): string => {
    const key = JSON.stringify(g);
    const existing = gradientIds.get(key);
    if (existing) return existing;
    const gid = `grad-${++gradSeq}`;
    gradientIds.set(key, gid);
    const rad = ((g.angle - 90) * Math.PI) / 180;
    const x1 = 0.5 - Math.cos(rad) / 2;
    const y1 = 0.5 - Math.sin(rad) / 2;
    const x2 = 0.5 + Math.cos(rad) / 2;
    const y2 = 0.5 + Math.sin(rad) / 2;
    gradientDefs.push(
      `<linearGradient id="${gid}" x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}">` +
        g.stops.map((s) => `<stop offset="${num(s.offset)}" stop-color="${s.color}"/>`).join('') +
        `</linearGradient>`
    );
    return gid;
  };

  const fillFor = (f: ShapeLayer['fill'] | undefined): string => {
    if (!f || f === 'none') return 'none';
    if (typeof f === 'string') return f;
    return `url(#${gradientId(f)})`;
  };

  const transformFor = (l: DesignLayer): string => {
    const parts = [`translate(${num(l.x)} ${num(l.y)})`];
    if (l.rotation) parts.push(`rotate(${num(l.rotation)} ${num(l.width / 2)} ${num(l.height / 2)})`);
    return parts.join(' ');
  };

  const layerSvg = (layer: DesignLayer, insideGroup: boolean, indent: string): string => {
    const opacity = layer.opacity !== 1 ? ` opacity="${num(layer.opacity)}"` : '';
    const hidden = layer.visible ? '' : ' display="none"';
    const common = `data-layer-id="${xmlEscape(layer.id)}" data-layer-type="${layer.type}"${insideGroup ? ' data-group-child="1"' : ''}`;

    if (layer.type === 'text') return textSvg(layer, indent, common, opacity, hidden);
    if (layer.type === 'image') return imageSvg(layer, indent, common, opacity, hidden);
    if (layer.type === 'shape') return shapeSvg(layer, indent, common, opacity, hidden);
    const kids = layer.children.map((id) => doc.layers.find((l) => l.id === id)).filter((l): l is DesignLayer => !!l);
    return (
      `${indent}<g ${common} transform="${transformFor(layer)}"${opacity}${hidden}>\n` +
      kids.map((k) => layerSvg(k, true, indent + '  ')).join('\n') +
      `\n${indent}</g>`
    );
  };

  const textSvg = (layer: TextLayer, indent: string, extra: string, opacity: string, hidden: string): string => {
    const { spec, metrics } = resolveTextLayout(layer);
    const family = safeFamily(spec.fontFamily);
    if (!isSystemFamily(family)) {
      const font = opts.fontHref?.(family);
      if (font && !fontDefs.has(family)) {
        fontDefs.add(family);
        fontDefs.add(
          `@font-face { font-family: '${family.replace(/'/g, '')}'; src: url('${font.href}') format('${fontFormat(font.mime)}'); }`
        );
      }
    }
    const clipId = `clip-${++clipSeq}`;
    if (layer.style.overflow !== 'visible') {
      clipDefs.push(
        `<clipPath id="${clipId}"><rect x="0" y="0" width="${num(layer.width)}" height="${num(layer.height)}"/></clipPath>`
      );
    }
    const clipAttr = layer.style.overflow !== 'visible' ? ` clip-path="url(#${clipId})"` : '';
    const anchor = layer.style.align === 'center' ? 'middle' : layer.style.align === 'right' ? 'end' : 'start';
    const tx = layer.style.align === 'center' ? layer.width / 2 : layer.style.align === 'right' ? layer.width : 0;
    const stroke = layer.style.stroke && layer.style.stroke.width > 0
      ? ` stroke="${layer.style.stroke.color}" stroke-width="${num(layer.style.stroke.width)}" paint-order="stroke" stroke-linejoin="round"`
      : '';
    const shadowDef = layer.style.shadow
      ? ` filter="url(#${shadowFilter(layer.style.shadow)})"`
      : '';
    const lines = metrics.lines.map((line, i) => {
      const y = i * metrics.lineHeightPx + spec.fontSize * 0.82;
      return `<tspan x="${num(tx)}" y="${num(y)}">${xmlEscape(spec.uppercase ? line.toUpperCase() : line)}</tspan>`;
    });
    const ls = spec.letterSpacing ? ` letter-spacing="${num(spec.letterSpacing)}"` : '';
    return (
      `${indent}<g ${extra} transform="${transformFor(layer)}"${opacity}${hidden}${shadowDef}${clipAttr}>\n` +
      `${indent}  <text font-family="${xmlEscape(family)}" font-size="${num(spec.fontSize)}" font-weight="${spec.fontWeight}" fill="${layer.style.color}" text-anchor="${anchor}"${stroke}${ls} xml:space="preserve">\n` +
      lines.map((l) => `${indent}    ${l}`).join('\n') +
      `\n${indent}  </text>\n${indent}</g>`
    );
  };

  const imageSvg = (layer: ImageLayer, indent: string, extra: string, opacity: string, hidden: string): string => {
    const href = resolveAsset(layer.assetRef);
    const docAsset = assetById.get(layer.assetRef);
    const clipId = `clip-${++clipSeq}`;
    const radius = Math.max(0, layer.cornerRadius);
    clipDefs.push(
      `<clipPath id="${clipId}"><rect x="0" y="0" width="${num(layer.width)}" height="${num(layer.height)}" rx="${num(radius)}"/></clipPath>`
    );
    const border = layer.border && layer.border.width > 0
      ? ` stroke="${layer.border.color}" stroke-width="${num(layer.border.width)}"`
      : '';
    if (!href) {
      return (
        `${indent}<g ${extra} transform="${transformFor(layer)}"${opacity}${hidden} data-missing-asset="1">\n` +
        `${indent}  <rect width="${num(layer.width)}" height="${num(layer.height)}" rx="${num(radius)}" fill="#2a3040" stroke="#ff5c7a" stroke-width="2" stroke-dasharray="8 6"/>` +
        `\n${indent}  <line x1="0" y1="0" x2="${num(layer.width)}" y2="${num(layer.height)}" stroke="#ff5c7a" stroke-opacity="0.5" stroke-width="2"/>` +
        `\n${indent}</g>`
      );
    }
    const sw = docAsset?.width ?? layer.width;
    const sh = docAsset?.height ?? layer.height;
    let inner: string;
    if (layer.fit === 'fill') {
      inner = `<image x="0" y="0" width="${num(layer.width)}" height="${num(layer.height)}" preserveAspectRatio="none" href="${xmlEscape(href)}"/>`;
    } else if (layer.fit === 'contain') {
      inner = `<image x="0" y="0" width="${num(layer.width)}" height="${num(layer.height)}" preserveAspectRatio="xMidYMid meet" href="${xmlEscape(href)}"/>`;
    } else {
      const scale = Math.max(layer.width / sw, layer.height / sh);
      const cropW = Math.min(sw, layer.width / scale);
      const cropH = Math.min(sh, layer.height / scale);
      const cropX = clamp(layer.focusX * sw - cropW / 2, 0, Math.max(0, sw - cropW));
      const cropY = clamp(layer.focusY * sh - cropH / 2, 0, Math.max(0, sh - cropH));
      inner =
        `<svg x="0" y="0" width="${num(layer.width)}" height="${num(layer.height)}" viewBox="${num(cropX)} ${num(cropY)} ${num(cropW)} ${num(cropH)}" preserveAspectRatio="none">` +
        `<image x="0" y="0" width="${num(sw)}" height="${num(sh)}" href="${xmlEscape(href)}"/></svg>`;
    }
    const rectSel = border ? `<rect width="${num(layer.width)}" height="${num(layer.height)}" rx="${num(radius)}" fill="none"${border}/>` : '';
    return (
      `${indent}<g ${extra} transform="${transformFor(layer)}"${opacity}${hidden} clip-path="url(#${clipId})">\n` +
      `${indent}  ${inner}\n${indent}  ${rectSel}\n${indent}</g>`
    );
  };

  const shapeSvg = (layer: ShapeLayer, indent: string, extra: string, opacity: string, hidden: string): string => {
    const fill = fillFor(layer.fill);
    const stroke = layer.stroke && layer.stroke.width > 0
      ? ` stroke="${layer.stroke.color}" stroke-width="${num(layer.stroke.width)}"${layer.stroke.dash ? ` stroke-dasharray="${layer.stroke.dash.map(num).join(' ')}"` : ''}`
      : '';
    const w = layer.width;
    const h = layer.height;
    let el: string;
    if (layer.shape === 'ellipse') {
      el = `<ellipse cx="${num(w / 2)}" cy="${num(h / 2)}" rx="${num(w / 2)}" ry="${num(h / 2)}" fill="${fill}"${stroke}/>`;
    } else if (layer.shape === 'line') {
      el = `<line x1="0" y1="0" x2="${num(w)}" y2="${num(h)}" stroke="${typeof layer.fill === 'string' && layer.fill !== 'none' ? layer.fill : layer.stroke?.color ?? '#ffffff'}" stroke-width="${num(layer.stroke?.width || Math.max(2, h))}" stroke-linecap="round"/>`;
    } else if (layer.shape === 'triangle') {
      el = `<polygon points="${num(w / 2)},0 ${num(w)},${num(h)} 0,${num(h)}" fill="${fill}"${stroke}/>`;
    } else {
      el = `<rect width="${num(w)}" height="${num(h)}" rx="${num(layer.cornerRadius)}" fill="${fill}"${stroke}/>`;
    }
    return `${indent}<g ${extra} transform="${transformFor(layer)}"${opacity}${hidden}>${el}</g>`;
  };

  const shadowFilter = (shadow: { color: string; blur: number; offsetX: number; offsetY: number }): string => {
    const fid = `sh-${++clipSeq}`;
    clipDefs.push(
      `<filter id="${fid}" x="-30%" y="-30%" width="160%" height="160%">` +
        `<feDropShadow dx="${num(shadow.offsetX)}" dy="${num(shadow.offsetY)}" stdDeviation="${num(Math.max(0, shadow.blur / 2))}" flood-color="${shadow.color}"/>` +
        `</filter>`
    );
    return fid;
  };

  // background
  let background = '';
  if (doc.canvas.background.mode === 'color' && doc.canvas.background.color) {
    background = `<rect width="${W}" height="${H}" fill="${doc.canvas.background.color}"/>`;
  } else if (doc.canvas.background.mode === 'image' && doc.canvas.background.assetRef) {
    const href = resolveAsset(doc.canvas.background.assetRef);
    const blur = doc.canvas.background.blur;
    const filter = blur > 0 ? ` filter="url(#${bgBlur(blur, clipDefs)})"` : '';
    background = href
      ? `<rect width="${W}" height="${H}" fill="#101322"/><image x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice" href="${xmlEscape(href)}"${filter}/>` +
        (blur > 0 ? `<rect width="${W}" height="${H}" fill="#00000055"/>` : '')
      : `<rect width="${W}" height="${H}" fill="#101322"/>`;
  } else if (doc.canvas.background.mode === 'none') {
    background = '';
  }

  // A group renders its members; members must not render again at top level.
  const childIds = new Set<string>();
  for (const l of doc.layers) if (l.type === 'group') for (const cid of l.children) childIds.add(cid);
  const roots = doc.layers.filter((l) => !childIds.has(l.id));

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" data-design-id="${xmlEscape(doc.id)}" data-revision="${doc.revision}">\n` +
    `<defs>\n${[...gradientDefs, ...clipDefs].map((d) => `  ${d}`).join('\n')}\n</defs>\n` +
    (fontDefs.size ? `<style>\n${[...fontDefs].filter((f) => f.startsWith('@font-face')).map((f) => `  ${f}`).join('\n')}\n</style>\n` : '') +
    background +
    `\n` +
    roots.map((l) => layerSvg(l, false, '')).join('\n') +
    `\n</svg>`;
  return svg;
}

function bgBlur(blur: number, defs: string[]): string {
  const fid = `bgblur-${defs.length}`;
  defs.push(`<filter id="${fid}" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${num(blur / 2)}"/></filter>`);
  return fid;
}

function fontFormat(mime: string): string {
  if (mime.includes('woff2')) return 'woff2';
  if (mime.includes('otf')) return 'opentype';
  return 'truetype';
}

function isSystemFamily(family: string): boolean {
  const known = ['arial', 'arial black', 'helvetica', 'segoe ui', 'verdana', 'tahoma', 'trebuchet ms', 'georgia', 'times new roman', 'cambria', 'garamond', 'courier new', 'consolas', 'impact', 'franklin gothic medium', 'palatino linotype', 'lucida sans unicode', 'system-ui', 'sans-serif', 'serif', 'monospace'];
  return known.includes(family.toLowerCase());
}

function clamp(n: number, min: number, max: number): number { return Math.min(max, Math.max(min, n)); }
