/* Design Studio SPA extension — merges into app.js via window.DesignRoutes /
 * DesignPages / DesignNav. The server renders the SVG (one rendering path);
 * the editor drags layers as live DOM transforms and re-renders through
 * POST /api/designs/preview whenever a change is committed. */
'use strict';

(() => {
  window.DesignRoutes = {
    routes: { '/designs': 'designs', '/templates': 'templates' },
    paramRoutes: { '/designs/': 'designDetail' },
  };
  window.DesignNav = {
    group: 'Design',
    items: [
      { label: '🎨 Designs', href: '/designs' },
      { label: '📐 Templates', href: '/templates' },
    ],
  };

  let doc = null;
  let design = null;
  let selected = null;
  let dirty = false;
  let statusTimer = null;
  let repaintTimer = null;

  const q = (sel, el = document) => el.querySelector(sel);
  const qa = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mainEl = () => document.getElementById('main');

  async function dapi(path, opts = {}) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      headers: opts.body && !(opts.body instanceof FormData) ? { 'content-type': 'application/json' } : {},
      ...opts,
      body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
    });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
  }

  function dtoast(msg, kind = 'ok') {
    if (typeof window.toastFn === 'function') { window.toastFn(msg, kind); return; }
    const el = document.createElement('div');
    el.className = 'ds-toast';
    el.textContent = `${kind === 'err' ? '✗ ' : ''}${msg}`;
    if (kind === 'err') el.style.borderColor = 'var(--bad)';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }

  /* ================= /designs — gallery ================= */
  async function designsPage() {
    document.title = 'Designs';
    const main = mainEl();
    main.innerHTML = `
      <div class="pageHead">
        <h1>Designs</h1>
        <p class="sub">Hybrid AI design studio — editable documents, deterministic layout, real SVG/PNG/JPG/PDF exports.</p>
      </div>
      <div class="card">
        <h2>New design</h2>
        <div class="formCols">
          <label>Brief<textarea id="dsBrief" rows="3" placeholder="e.g. Grand opening promo for a coffee shop, Sat-Sun 9am-9pm, Jl. Sudirman 12, 50% off"></textarea></label>
          <label>Name<input id="dsName" placeholder="Optional — derived from the brief"></label>
          <label>Size<select id="dsSize">
            <option value="1080x1080">Square 1080×1080 (Instagram post)</option>
            <option value="1080x1350">Portrait 1080×1350 (IG feed)</option>
            <option value="1080x1920">Story 1080×1920</option>
            <option value="1200x628">Link 1200×628</option>
            <option value="2480x3508">A4 print 300dpi</option>
            <option value="1280x720">Slide 1280×720</option>
          </select></label>
          <label class="checkbox"><input type="checkbox" id="dsGen" checked> <span>Generate now (works without AI too — deterministic fallback)</span></label>
        </div>
        <div class="row"><button class="btn good" id="dsCreateBtn">Create</button>
        <span class="hint">Facts in the brief (dates, prices, contacts) are protected — generation never rewrites them.</span></div>
      </div>
      <div class="card">
        <div class="row"><h2 style="margin:0">Library</h2><span style="flex:1"></span>
          <input id="dsSearch" placeholder="Search…">
          <select id="dsStatus"><option value="">All statuses</option><option>ready</option><option>generating</option><option>draft</option><option>failed</option></select>
        </div>
        <div id="dsGrid" class="ds-grid"><div class="loading">Loading…</div></div>
      </div>`;

    const reload = async () => {
      const r = await dapi(`/api/designs?q=${encodeURIComponent(q('#dsSearch').value || '')}`);
      const st = q('#dsStatus').value;
      const list = st ? r.designs.filter((d) => d.status === st) : r.designs;
      q('#dsGrid').innerHTML = list.length
        ? list.map((d) => `
          <a class="ds-card ${esc(d.status)}" href="#/designs/${esc(d.id)}">
            <div class="ds-thumb">${d.thumbnail
              ? `<img src="${esc(d.thumbnail)}" alt="" loading="lazy">`
              : `<div class="ds-thumbEmpty" style="background:${esc((d.palette && d.palette[0]) || '#1d2436')}">${d.width}×${d.height}</div>`}</div>
            <div class="ds-cardBody">
              <b>${esc(d.name)}</b>
              <span class="hint">${esc(d.strategy || '—')} · ${d.layerCount} layers · r${d.revision}</span>
              <span class="badge ${d.status === 'ready' ? 'green' : d.status === 'failed' ? 'red' : d.status === 'generating' ? 'amber' : 'gray'}">${esc(d.status)}</span>
            </div>
          </a>`).join('')
        : '<p class="hint">No designs yet. A brief alone is enough to create one.</p>';
    };

    q('#dsCreateBtn').addEventListener('click', async () => {
      const [w, h] = q('#dsSize').value.split('x').map(Number);
      try {
        const r = await dapi('/api/designs', {
          method: 'POST',
          body: { name: q('#dsName').value, brief: q('#dsBrief').value, width: w, height: h, generate: q('#dsGen').checked },
        });
        dtoast(r.jobId ? 'Generation queued…' : 'Design created');
        location.hash = `#/designs/${r.design.id}`;
      } catch (e) { dtoast(e.message, 'err'); }
    });
    q('#dsSearch').addEventListener('input', () => { clearTimeout(reload._t); reload._t = setTimeout(reload, 250); });
    q('#dsStatus').addEventListener('change', reload);
    await reload();
  }

  /* ================= /designs/:id — editor ================= */
  async function designDetail(hash) {
    document.title = 'Design Studio';
    const id = hash.split('/')[2];
    const first = await dapi(`/api/designs/${id}`);
    doc = first.document;
    design = first.design;
    dirty = false;

    const main = mainEl();
    main.innerHTML = `
      <div class="pageHead ds-head">
        <div class="row ds-toolbar">
          <a class="btn ghost small" href="#/designs">← Designs</a>
          <h1 id="dsTitle" contenteditable spellcheck="false">${esc(design.name)}</h1>
          ${design.error ? `<span class="badge red" title="${esc(design.error)}">error</span>` : ''}
          <span id="dsStatusBadge" class="badge ${design.status === 'ready' ? 'green' : design.status === 'generating' ? 'amber' : design.status === 'failed' ? 'red' : 'gray'}">${esc(design.status)}</span>
          <span style="flex:1"></span>
          <span id="dsSaveState" class="hint">r${design.revision}</span>
          <button class="btn good" id="dsSave">💾 Save</button>
        </div>
        <div class="row ds-toolbar">
          <button class="btn" id="dsGenOpen">✨ Generate</button>
          <button class="btn" id="dsExportOpen">⬇ Export</button>
          <button class="btn ghost" id="dsReviewBtn">🔍 Review</button>
          <button class="btn ghost" id="dsRepairBtn">🩹 Auto-repair</button>
          <button class="btn ghost" id="dsThumbBtn">🖼 Thumbnail</button>
          <button class="btn ghost" id="dsVersionsBtn">🕘 Versions</button>
          <button class="btn ghost" id="dsDupBtn">⧉ Duplicate</button>
          <button class="btn ghost small" id="dsTplBtn">Save as template</button>
          <button class="btn ghost small" id="dsDelBtn">Delete</button>
        </div>
      </div>
      <div class="ds-work">
        <div class="ds-stage card">
          <div id="dsCanvas" class="ds-canvaswrap"><div class="loading">Rendering…</div></div>
          <div class="row ds-addrow">
            <button class="btn ghost small" id="dsAddText">+ Text</button>
            <button class="btn ghost small" id="dsAddRect">+ Rectangle</button>
            <button class="btn ghost small" id="dsAddImg">+ Image</button>
            <span style="flex:1"></span>
            <span class="hint">${doc.canvas.width}×${doc.canvas.height}px · drag layers on the canvas · double-click text to edit</span>
          </div>
        </div>
        <aside class="ds-side" id="dsSide">
          <div class="card" id="dsProps"><h2>Properties</h2><p class="hint">Select a layer on the canvas or in the list.</p></div>
          <div class="card"><h2>Layers</h2><div id="dsLayers" class="ds-layers"></div></div>
          <div class="card" id="dsPanelGenerate" style="display:none">
            <h2>Generate with AI</h2>
            <label>Brief<textarea id="dsGenBrief" rows="4"></textarea></label>
            <div class="row">
              <label>Strategy<select id="dsGenStrategy"><option value="">auto</option>${['editorial', 'minimalist', 'modern_promo', 'bold_typography', 'product_showcase', 'event_poster', 'corporate', 'luxury', 'social'].map((s) => `<option>${s}</option>`).join('')}</select></label>
            </div>
            <div class="row"><label>Width<input id="dsGenW" type="number"></label><label>Height<input id="dsGenH" type="number"></label></div>
            <label>Palette (comma-separated hex)<input id="dsGenPalette" placeholder="#101322, #ff5c7a, #ffd400"></label>
            <label class="checkbox"><input type="checkbox" id="dsGenImg"><span>Generate raster background (needs a configured image provider)</span></label>
            <div class="row"><button class="btn good" id="dsGenGo">Generate now</button><span id="dsGenHint" class="hint"></span></div>
          </div>
          <div class="card" id="dsPanelExport" style="display:none">
            <h2>Export</h2>
            <div class="row">
              <label>Format<select id="dsExpFormat"><option>png</option><option>jpg</option><option>svg</option><option>pdf</option></select></label>
              <label>Scale<input id="dsExpScale" type="number" step="0.25" min="0.25" max="4" value="2"></label>
              <label>Quality<input id="dsExpQuality" type="number" min="1" max="100" value="92"></label>
            </div>
            <div class="row"><button class="btn good" id="dsExpGo">Export</button>
            <a id="dsExpLink" class="btn" style="display:none" download>Download</a><span id="dsExpInfo" class="hint"></span></div>
          </div>
          <div class="card" id="dsPanelReview" style="display:none"><h2>Review</h2><div id="dsReviewBox" class="hint">No review yet.</div></div>
          <div class="card" id="dsPanelVersions" style="display:none"><h2>Versions</h2><div id="dsVersionBox" class="hint">Loading…</div></div>
        </aside>
      </div>`;

    q('#dsTitle').addEventListener('blur', (e) => {
      const name = e.target.textContent.trim();
      if (name && name !== design.name) { doc.metadata.title = name; markDirty(); }
    });
    q('#dsSave').addEventListener('click', () => saveDesign(false));
    q('#dsGenOpen').addEventListener('click', () => openPanel('dsPanelGenerate', () => {
      q('#dsGenBrief').value = doc.metadata.brief || design.brief || '';
      q('#dsGenW').value = doc.canvas.width;
      q('#dsGenH').value = doc.canvas.height;
    }));
    q('#dsGenGo').addEventListener('click', async () => {
      try {
        if (dirty) await saveDesign(true);
        await dapi(`/api/designs/${id}/generate`, {
          method: 'POST',
          body: {
            brief: q('#dsGenBrief').value,
            width: Number(q('#dsGenW').value) || undefined,
            height: Number(q('#dsGenH').value) || undefined,
            strategy: q('#dsGenStrategy').value || undefined,
            palette: q('#dsGenPalette').value.split(',').map((s) => s.trim()).filter(Boolean),
            generateImage: q('#dsGenImg').checked,
          },
        });
        dtoast('Generation queued…');
        watchStatus(id);
      } catch (e) { dtoast(e.message, 'err'); }
    });
    q('#dsExportOpen').addEventListener('click', () => openPanel('dsPanelExport'));
    q('#dsExpGo').addEventListener('click', async () => {
      try {
        if (dirty) await saveDesign(true);
        q('#dsExpInfo').textContent = 'Rendering…';
        const r = await dapi(`/api/designs/${id}/export`, {
          method: 'POST',
          body: { format: q('#dsExpFormat').value, scale: Number(q('#dsExpScale').value), quality: Number(q('#dsExpQuality').value) },
        });
        const link = q('#dsExpLink');
        link.href = r.export.url;
        link.style.display = '';
        link.textContent = `Download ${r.export.fileName}`;
        q('#dsExpInfo').textContent = `${r.export.bytes} bytes · ${r.export.width}×${r.export.height}`;
      } catch (e) { q('#dsExpInfo').textContent = ''; dtoast(e.message, 'err'); }
    });
    q('#dsReviewBtn').addEventListener('click', async () => {
      try {
        openPanel('dsPanelReview');
        q('#dsReviewBox').textContent = 'Running deterministic review…';
        await dapi(`/api/designs/${id}/review`, { method: 'POST', body: { ai: false } });
        setTimeout(() => loadReviews(id), 2200);
      } catch (e) { dtoast(e.message, 'err'); }
    });
    q('#dsRepairBtn').addEventListener('click', async () => {
      try {
        if (dirty) await saveDesign(true);
        await dapi(`/api/designs/${id}/repair`, { method: 'POST' });
        dtoast('Auto-repair queued (bounds, overflow)');
        watchStatus(id);
      } catch (e) { dtoast(e.message, 'err'); }
    });
    q('#dsThumbBtn').addEventListener('click', async () => {
      try { await dapi(`/api/designs/${id}/thumbnail`, { method: 'POST' }); dtoast('Thumbnail refreshed'); }
      catch (e) { dtoast(e.message, 'err'); }
    });
    q('#dsVersionsBtn').addEventListener('click', () => { openPanel('dsPanelVersions'); loadVersions(id); });
    q('#dsDupBtn').addEventListener('click', async () => {
      try { const r = await dapi(`/api/designs/${id}/duplicate`, { method: 'POST' }); location.hash = `#/designs/${r.design.id}`; }
      catch (e) { dtoast(e.message, 'err'); }
    });
    q('#dsDelBtn').addEventListener('click', async () => {
      if (!confirm('Delete this design? Its versions are lost too.')) return;
      try { await dapi(`/api/designs/${id}`, { method: 'DELETE' }); location.hash = '#/designs'; }
      catch (e) { dtoast(e.message, 'err'); }
    });
    q('#dsTplBtn').addEventListener('click', async () => {
      try {
        const name = prompt('Template name', design.name);
        if (!name) return;
        await dapi('/api/templates', { method: 'POST', body: { designId: id, name } });
        dtoast('Saved as template');
      } catch (e) { dtoast(e.message, 'err'); }
    });
    q('#dsAddText').addEventListener('click', () => addLayer({
      id: `txt-${Date.now().toString(36)}`, type: 'text', name: 'New text', x: 80, y: 80,
      width: Math.round(doc.canvas.width * 0.6), height: 120, text: 'Double-click to edit',
      style: { fontFamily: 'Arial', fontSize: Math.round(doc.canvas.width * 0.06), fontWeight: 700, lineHeight: 1.2, letterSpacing: 0, align: 'left', color: '#ffffff', uppercase: false, overflow: 'shrink' },
      opacity: 1, visible: true, locked: false, rotation: 0,
    }));
    q('#dsAddRect').addEventListener('click', () => addLayer({
      id: `shp-${Date.now().toString(36)}`, type: 'shape', name: 'Rectangle', x: 100, y: 100, width: 320, height: 320,
      shape: 'rect', fill: '#ff5c7a', cornerRadius: 16, opacity: 1, visible: true, locked: false, rotation: 0,
    }));
    q('#dsAddImg').addEventListener('click', () => openAssetPicker());

    await repaint();
    loadReviews(id);
    if (design.status === 'generating') watchStatus(id);
  }

  /* ---------- editor internals ---------- */
  function markDirty() {
    dirty = true;
    const el = q('#dsSaveState');
    if (el) el.textContent = 'unsaved changes';
  }

  function openPanel(panelId, setup) {
    for (const id of ['dsPanelGenerate', 'dsPanelExport', 'dsPanelReview', 'dsPanelVersions']) {
      const el = q('#' + id);
      if (el) el.style.display = 'none';
    }
    const el = q('#' + panelId);
    if (el) { el.style.display = ''; if (setup) setup(); }
  }

  async function saveDesign(silent) {
    const titleEl = q('#dsTitle');
    if (titleEl && titleEl.textContent.trim()) doc.metadata.title = titleEl.textContent.trim();
    try {
      const r = await dapi(`/api/designs/${design.id}`, { method: 'PUT', body: { document: doc } });
      design = r.design;
      doc = r.document;
      dirty = false;
      const st = q('#dsSaveState');
      if (st) st.textContent = `r${design.revision}`;
      if (!silent) dtoast(`Saved (r${design.revision})`);
      return r;
    } catch (e) { dtoast(e.message, 'err'); throw e; }
  }

  async function repaint() {
    const canvasEl = q('#dsCanvas');
    if (!canvasEl) return;
    try {
      const svg = await dapi('/api/designs/preview', { method: 'POST', body: { document: doc } });
      canvasEl.innerHTML = svg;
      const svgEl = canvasEl.querySelector('svg');
      if (svgEl) { svgEl.style.maxWidth = '100%'; svgEl.style.height = 'auto'; }
      applySelection();
      wireCanvas();
      renderLayerList();
    } catch (e) {
      canvasEl.innerHTML = `<p class="hint">Preview failed: ${esc(e.message)}</p>`;
    }
  }

  function repaintDebounced() {
    clearTimeout(repaintTimer);
    repaintTimer = setTimeout(repaint, 180);
  }

  function selectedLayer() {
    return doc.layers.find((l) => l.id === selected) || null;
  }

  function applySelection() {
    const canvasEl = q('#dsCanvas');
    if (!canvasEl) return;
    qa('[data-ds-sel]', canvasEl).forEach((el) => el.removeAttribute('data-ds-sel'));
    if (selected) {
      const el = canvasEl.querySelector(`[data-layer-id="${CSS.escape(selected)}"]`);
      if (el) el.setAttribute('data-ds-sel', '1');
    }
    propertiesPanel();
  }

  function wireCanvas() {
    const canvasEl = q('#dsCanvas');
    const svgEl = canvasEl.querySelector('svg');
    if (!svgEl) return;
    qa('[data-layer-id]', svgEl).forEach((g) => {
      g.style.cursor = 'pointer';
      g.addEventListener('pointerdown', (ev) => startDrag(ev, g));
      g.addEventListener('dblclick', () => {
        const layer = doc.layers.find((l) => l.id === g.dataset.layerId);
        if (layer && layer.type === 'text') {
          const text = prompt('Edit text', layer.text);
          if (text !== null && text.trim()) { layer.text = text; markDirty(); repaint(); }
        }
      });
    });
  }

  function startDrag(ev, g) {
    ev.preventDefault();
    selected = g.dataset.layerId;
    applySelection();
    const layer = selectedLayer();
    const svgEl = q('#dsCanvas svg');
    if (!layer || layer.locked || !svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    const scale = rect.width / doc.canvas.width;
    const startX = ev.clientX;
    const startY = ev.clientY;
    const move = (e2) => {
      const dx = (e2.clientX - startX) / scale;
      const dy = (e2.clientY - startY) / scale;
      g.style.transform = `translate(${dx}px, ${dy}px)`;
      g.dataset.dx = String(dx);
      g.dataset.dy = String(dy);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const dx = Number(g.dataset.dx || 0);
      const dy = Number(g.dataset.dy || 0);
      g.style.transform = '';
      delete g.dataset.dx;
      delete g.dataset.dy;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        layer.x = Math.round(layer.x + dx);
        layer.y = Math.round(layer.y + dy);
        markDirty();
        repaintDebounced();
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function renderLayerList() {
    const box = q('#dsLayers');
    if (!box) return;
    box.innerHTML = doc.layers.map((l, i) => `
      <div class="ds-layer ${l.id === selected ? 'sel' : ''}" data-id="${esc(l.id)}">
        <span class="ds-layerType">${l.type === 'text' ? 'T' : l.type === 'image' ? '🖼' : l.type === 'group' ? '▣' : '◧'}</span>
        <span class="ds-layerName" title="${esc(l.type === 'text' ? l.text : l.name || l.id)}">${esc(l.type === 'text' ? (l.text || '').slice(0, 36) : l.name || l.id)}</span>
        <button class="btn ghost tiny" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn ghost tiny" data-down="${i}" ${i === doc.layers.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn ghost tiny" data-eye="${i}">${l.visible ? '👁' : '—'}</button>
      </div>`).join('') || '<p class="hint">No layers yet.</p>';
    qa('.ds-layer', box).forEach((row) => row.addEventListener('click', (ev) => {
      const t = ev.target;
      if (t.dataset.up !== undefined || t.dataset.down !== undefined || t.dataset.eye !== undefined) return;
      selected = row.dataset.id;
      applySelection();
    }));
    qa('[data-up]', box).forEach((b) => b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const i = Number(b.dataset.up);
      [doc.layers[i - 1], doc.layers[i]] = [doc.layers[i], doc.layers[i - 1]];
      markDirty(); repaint();
    }));
    qa('[data-down]', box).forEach((b) => b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const i = Number(b.dataset.down);
      [doc.layers[i + 1], doc.layers[i]] = [doc.layers[i], doc.layers[i + 1]];
      markDirty(); repaint();
    }));
    qa('[data-eye]', box).forEach((b) => b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      doc.layers[Number(b.dataset.eye)].visible = !doc.layers[Number(b.dataset.eye)].visible;
      markDirty(); repaint();
    }));
  }

  function addLayer(layer) {
    doc.layers.push(layer);
    selected = layer.id;
    markDirty();
    repaint();
  }

  function openAssetPicker() {
    const existing = q('#dsAssetBox');
    if (existing) existing.remove();
    const box = document.createElement('div');
    box.className = 'card';
    box.id = 'dsAssetBox';
    box.innerHTML = `<h2>Insert image</h2>
      <div id="dsAssetPick" class="ds-assetPicker hint">Loading assets…</div>
      <label>or upload<input type="file" id="dsAssetUpload" accept=".png,.jpg,.jpeg,.webp,.gif"></label>
      <div class="row"><button class="btn ghost small" id="dsAssetClose">Close</button></div>`;
    q('#dsSide').prepend(box);
    q('#dsAssetClose').addEventListener('click', () => box.remove());

    const insert = (asset, docAssetId) => {
      addLayer({
        id: `img-${Date.now().toString(36)}`, type: 'image', name: asset.name, x: 60, y: 60,
        width: Math.min(480, doc.canvas.width - 120), height: Math.min(360, doc.canvas.height - 120),
        assetRef: docAssetId, fit: 'cover', focusX: 0.5, focusY: 0.5, cornerRadius: 0, opacity: 1, visible: true, locked: false, rotation: 0,
      });
      box.remove();
    };

    (async () => {
      try {
        const r = await dapi('/api/design-assets?enabled=1');
        const imgs = r.assets.filter((a) => a.kind !== 'font');
        q('#dsAssetPick').innerHTML = imgs.length
          ? imgs.map((a) => `<button class="ds-assetBtn" data-asset="${esc(a.id)}"><img src="${esc(a.url)}" alt="" loading="lazy"><span>${esc(a.name)}</span></button>`).join('')
          : 'No assets yet — upload one below.';
        qa('[data-asset]', q('#dsAssetPick')).forEach((btn) => btn.addEventListener('click', () => {
          const asset = imgs.find((a) => a.id === btn.dataset.asset);
          const docAsset = { id: `a-${Date.now().toString(36)}`, assetId: asset.id, name: asset.name, mime: asset.mime, width: asset.width || undefined, height: asset.height || undefined, source: 'library' };
          doc.assets.push(docAsset);
          insert(asset, docAsset.id);
          dtoast('Image layer added');
        }));
      } catch (e) { q('#dsAssetPick').textContent = `Failed: ${e.message}`; }
    })();

    q('#dsAssetUpload').addEventListener('change', async (ev) => {
      const f = ev.target.files[0];
      if (!f) return;
      const fd = new FormData();
      fd.append('file', f);
      try {
        const r = await dapi('/api/design-assets', { method: 'POST', body: fd });
        const a = r.asset;
        const docAsset = { id: `a-${Date.now().toString(36)}`, assetId: a.id, name: a.name, mime: a.mime, width: a.width || undefined, height: a.height || undefined, source: 'upload' };
        doc.assets.push(docAsset);
        insert(a, docAsset.id);
        dtoast('Uploaded and inserted');
      } catch (e) { dtoast(e.message, 'err'); }
    });
  }

  function propertiesPanel() {
    const panel = q('#dsProps');
    if (!panel) return;
    const l = selectedLayer();
    if (!l) { panel.innerHTML = '<h2>Properties</h2><p class="hint">Select a layer on the canvas or in the list.</p>'; return; }
    const isHex = (c) => /^#[0-9a-fA-F]{6}$/.test(c || '');
    panel.innerHTML = `<h2>Properties — ${esc(l.name || l.id)}</h2>
      ${l.type === 'text' ? `
        <label>Text<textarea data-k="text" rows="3">${esc(l.text)}</textarea></label>
        <div class="row">
          <label>Size<input type="number" data-style-k="fontSize" value="${l.style.fontSize}"></label>
          <label>Weight<input type="number" data-style-k="fontWeight" value="${l.style.fontWeight}" min="100" max="900" step="100"></label>
        </div>
        <div class="row">
          <label>Font<input data-style-k="fontFamily" value="${esc(l.style.fontFamily)}"></label>
          <label>Color<input type="color" data-style-k="color" value="${isHex(l.style.color) ? l.style.color : '#ffffff'}"></label>
        </div>
        <div class="row">
          <label>Align<select data-style-k="align">${['left', 'center', 'right'].map((a) => `<option ${a === l.style.align ? 'selected' : ''}>${a}</option>`).join('')}</select></label>
          <label class="checkbox"><input type="checkbox" data-style-k="uppercase" ${l.style.uppercase ? 'checked' : ''}><span>UPPERCASE</span></label>
        </div>` : ''}
      ${l.type === 'image' ? `
        <label>Asset<select data-k="assetRef">${doc.assets.map((a) => `<option value="${esc(a.id)}" ${a.id === l.assetRef ? 'selected' : ''}>${esc(a.name || a.assetId)}</option>`).join('')}</select></label>
        <label>Fit<select data-kimage="fit">${['cover', 'contain', 'fill'].map((f) => `<option ${f === l.fit ? 'selected' : ''}>${f}</option>`).join('')}</select></label>` : ''}
      ${l.type === 'shape' ? `
        <label>Fill<input type="color" data-shape-k="fill" value="${isHex(l.fill) ? l.fill : '#888888'}"></label>
        <label>Corner radius<input type="number" data-shape-k="cornerRadius" value="${l.cornerRadius || 0}"></label>` : ''}
      <div class="row"><label>X<input type="number" data-k="x" value="${Math.round(l.x)}"></label><label>Y<input type="number" data-k="y" value="${Math.round(l.y)}"></label></div>
      <div class="row"><label>Width<input type="number" data-k="width" value="${Math.round(l.width)}"></label><label>Height<input type="number" data-k="height" value="${Math.round(l.height)}"></label></div>
      <label>Opacity<input type="range" data-k="opacity" min="0" max="1" step="0.05" value="${l.opacity}"></label>
      <div class="row">
        <label class="checkbox"><input type="checkbox" data-k="locked" ${l.locked ? 'checked' : ''}><span>Locked</span></label>
        <span style="flex:1"></span>
        <button class="btn ghost small" id="dsDelLayer">Delete layer</button>
      </div>`;

    const commit = () => { markDirty(); repaintDebounced(); };
    qa('[data-k]', panel).forEach((inp) => inp.addEventListener('change', () => {
      const key = inp.dataset.k;
      if (key === 'assetRef') l.assetRef = inp.value;
      else if (key === 'opacity') l.opacity = Number(inp.value);
      else if (key === 'locked') l.locked = inp.checked;
      else if (key === 'text') l.text = inp.value;
      else l[key] = Number(inp.value);
      commit();
    }));
    qa('[data-style-k]', panel).forEach((inp) => inp.addEventListener('change', () => {
      const key = inp.dataset.styleK;
      if (inp.type === 'checkbox') l.style[key] = inp.checked;
      else if (inp.type === 'number') l.style[key] = Number(inp.value);
      else l.style[key] = inp.value;
      commit();
    }));
    qa('[data-shape-k]', panel).forEach((inp) => inp.addEventListener('change', () => {
      l[inp.dataset.shapeK] = inp.type === 'number' ? Number(inp.value) : inp.value;
      commit();
    }));
    qa('[data-kimage]', panel).forEach((sel) => sel.addEventListener('change', () => { l.fit = sel.value; commit(); }));
    const del = q('#dsDelLayer');
    if (del) del.addEventListener('click', () => {
      const inGroup = doc.layers.some((g2) => g2.type === 'group' && g2.children.includes(l.id));
      if (inGroup) { dtoast('Remove it from its group first', 'err'); return; }
      doc.layers = doc.layers.filter((x) => x.id !== l.id);
      selected = null;
      markDirty();
      repaint();
    });
  }

  async function loadVersions(id) {
    const box = q('#dsVersionBox');
    if (!box) return;
    try {
      const r = await dapi(`/api/designs/${id}/versions`);
      box.innerHTML = r.versions.length
        ? r.versions.slice(0, 20).map((v) => `<div class="ds-version"><span class="mono">r${v.revision}</span> <span>${esc(v.label || '')}</span><span style="flex:1"></span><button class="btn ghost tiny" data-restore="${v.revision}">Restore</button></div>`).join('')
        : 'No versions yet. Every save snapshots the previous state.';
      qa('[data-restore]', box).forEach((b) => b.addEventListener('click', async () => {
        try {
          const res = await dapi(`/api/designs/${id}/versions/${b.dataset.restore}/restore`, { method: 'POST' });
          doc = res.document;
          design = res.design;
          dirty = false;
          const st = q('#dsSaveState');
          if (st) st.textContent = `r${design.revision}`;
          dtoast(`Restored r${b.dataset.restore}`);
          await repaint();
          loadVersions(id);
        } catch (e) { dtoast(e.message, 'err'); }
      }));
    } catch (e) { box.textContent = e.message; }
  }

  async function loadReviews(id) {
    try {
      const r = await dapi(`/api/designs/${id}/reviews`);
      const box = q('#dsReviewBox');
      if (!box) return;
      const latest = r.reviews[0];
      if (!latest) { box.textContent = 'No review yet — run one, or generate (review runs automatically).'; return; }
      const color = latest.score >= 70 ? 'var(--good)' : latest.score >= 45 ? 'var(--warn)' : 'var(--bad)';
      box.innerHTML = `<div class="row"><b>Score:</b> <span style="color:${color}">${latest.score}/100</span><span class="hint">${esc(latest.source)} · r${latest.revision}</span></div>
        ${(latest.data && latest.data.issues || []).slice(0, 10).map((i) => `<div class="ds-issue sev-${esc(i.severity)}"><b>${esc(i.type)}</b> — ${esc(i.description)}</div>`).join('') || '<div class="hint">No issues found.</div>'}`;
    } catch { /* review panel is optional */ }
  }

  function watchStatus(id) {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(async () => {
      const badge = q('#dsStatusBadge');
      if (!badge) return;
      try {
        const r = await dapi(`/api/designs/${id}`);
        design = r.design;
        badge.textContent = design.status;
        badge.className = `badge ${design.status === 'ready' ? 'green' : design.status === 'generating' ? 'amber' : design.status === 'failed' ? 'red' : 'gray'}`;
        if (design.status === 'generating') { watchStatus(id); return; }
        if (design.status === 'failed') { dtoast(`Generation failed: ${design.error || 'unknown error'}`, 'err'); return; }
        // ready: load the freshly generated document
        doc = r.document;
        dirty = false;
        const st = q('#dsSaveState');
        if (st) st.textContent = `r${design.revision}`;
        await repaint();
        loadReviews(id);
        dtoast('Design updated');
      } catch { /* page gone */ }
    }, 2500);
  }

  /* ================= /templates ================= */
  async function templatesPage() {
    document.title = 'Templates';
    const main = mainEl();
    main.innerHTML = `
      <div class="pageHead"><h1>Templates</h1><p class="sub">Reusable DesignDocuments. Apply one to start a new design instantly.</p></div>
      <div id="tplList" class="ds-grid"><div class="loading">Loading…</div></div>`;
    const load = async () => {
      const r = await dapi('/api/templates');
      q('#tplList').innerHTML = r.templates.length
        ? r.templates.map((t) => `
          <div class="ds-card">
            <div class="ds-cardBody">
              <b>${esc(t.name)}</b>
              <span class="hint">${esc(t.category || '—')} · ${t.layerCount} layers · ${t.width}×${t.height}${t.builtin ? ' · built-in' : ''}</span>
              <div class="row">
                <button class="btn good small" data-apply="${esc(t.id)}">Apply</button>
                <button class="btn ghost small" data-dupt="${esc(t.id)}">Duplicate</button>
                ${t.builtin ? '' : `<button class="btn ghost small" data-delt="${esc(t.id)}">Delete</button>`}
              </div>
            </div>
          </div>`).join('')
        : '<p class="hint">No templates yet — open a design and use “Save as template”.</p>';
      qa('[data-apply]', q('#tplList')).forEach((b) => b.addEventListener('click', async () => {
        try {
          const r2 = await dapi(`/api/templates/${b.dataset.apply}/apply`, { method: 'POST' });
          location.hash = `#/designs/${r2.design.id}`;
        } catch (e) { dtoast(e.message, 'err'); }
      }));
      qa('[data-dupt]', q('#tplList')).forEach((b) => b.addEventListener('click', async () => {
        try { await dapi(`/api/templates/${b.dataset.dupt}/duplicate`, { method: 'POST' }); dtoast('Duplicated'); load(); }
        catch (e) { dtoast(e.message, 'err'); }
      }));
      qa('[data-delt]', q('#tplList')).forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Delete template?')) return;
        try { await dapi(`/api/templates/${b.dataset.delt}`, { method: 'DELETE' }); load(); }
        catch (e) { dtoast(e.message, 'err'); }
      }));
    };
    await load();
  }

  window.DesignPages = { designs: designsPage, designDetail, templates: templatesPage };
})();
