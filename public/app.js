/* AI Video Clipper — dashboard SPA */
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const main = $('#main');
const nav = $('#nav');

/* ---------- api ---------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: opts.body && !(opts.body instanceof FormData) ? { 'content-type': 'application/json' } : {},
    ...opts,
    body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
  });
  const type = (res.headers.get('content-type') || '');
  const data = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}
const h = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg, kind = 'ok') {
  const el = h(`<div class="t ${kind}">${esc(msg)}</div>`);
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}
function fmtTime(s) {
  if (s == null || isNaN(s)) return '0:00';
  s = Math.round(s);
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
function fmtBytes(n) {
  if (n == null) return '';
  if (n > 1e9) return (n / 1e9).toFixed(1) + ' GB';
  if (n > 1e6) return (n / 1e6).toFixed(1) + ' MB';
  if (n > 1e3) return (n / 1e3).toFixed(0) + ' KB';
  return n + ' B';
}
const STATUS_BADGE = {
  DOWNLOADING: 'amber', UPLOADED: 'gray', TRANSCRIBING: 'blue', ANALYZING: 'blue', FINDING_CLIPS: 'blue', SCORING: 'blue',
  READY: 'green', RENDERING: 'amber', COMPLETED: 'green', FAILED: 'red',
};
function statusBadge(s) { return `<span class="badge ${STATUS_BADGE[s] || 'gray'}">${esc(s)}</span>`; }
const scoreColor = (v) => (v >= 80 ? 'var(--good)' : v >= 55 ? 'var(--warn)' : 'var(--bad)');

/* ---------- auth ---------- */
async function checkAuth() {
  try { return await fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => r.ok); } catch { return false; }
}

/* ---------- router ---------- */
const routes = {
  '/': 'dashboard',
  '/dashboard': 'dashboard',
  '/login': 'login',
  '/projects': 'projects',
  '/clips': 'clips',
  '/settings/ai': 'settingsAi',
  '/settings/prompts': 'settingsPrompts',
  '/settings/clipping': 'settingsClipping',
  '/settings/subtitles': 'settingsSubtitles',
  '/settings/reframe': 'settingsReframe',
  '/settings/render': 'settingsRender',
  '/settings/telegram': 'settingsTelegram',
  '/settings/storage': 'settingsStorage',
  '/settings/system': 'settingsSystem',
};
const paramRoutes = {
  '/projects/': 'projectDetail',
  '/clips/': 'clipDetail',
};
let pollTimer = null;
function stopPoll() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }
function poll(fn, ms = 2500) {
  stopPoll();
  pollTimer = setInterval(fn, ms);
}

async function router() {
  const hash = location.hash.slice(1) || '/';
  stopPoll();
  let authed = await checkAuth();
  const isLogin = hash === '/login';
  if (!authed && !isLogin) return location.hash = '/login';
  if (authed && isLogin) return location.hash = '/';
  nav.classList.toggle('hidden', !authed);
  const page =
    routes[hash] ||
    (paramRoutes['/projects/'] && hash.startsWith('/projects/') ? 'projectDetail' : null) ||
    (paramRoutes['/clips/'] && hash.startsWith('/clips/') ? 'clipDetail' : null);
  if (!page) { location.hash = '/dashboard'; return; }
  highlightNav(hash);
  main.innerHTML = '<div class="loading">Loading…</div>';
  try {
    await PAGES[page](hash);
  } catch (e) {
    console.error(e);
    main.innerHTML = `<div class="card"><h1>Something went wrong</h1><p class="sub mono">${esc(e.message)}</p><a class="btn ghost small" href="#/">Back</a></div>`;
  }
}
window.addEventListener('hashchange', router);

const NAV_ITEMS = [
  { group: '', items: [{ label: '📊 Dashboard', href: '/dashboard' }, { label: '🎞 Projects', href: '/projects' }, { label: '✂️ Clips', href: '/clips' }] },
  { group: 'AI', items: [{ label: 'Models & Routing', href: '/settings/ai' }, { label: 'Prompts', href: '/settings/prompts' }] },
  { group: 'Clipping', items: [{ label: 'Detection & Scoring', href: '/settings/clipping' }, { label: 'Boundaries', href: '/settings/clipping' }] },
  { group: 'Video', items: [{ label: 'Subtitles', href: '/settings/subtitles' }, { label: 'Reframe', href: '/settings/reframe' }, { label: 'Rendering', href: '/settings/render' }] },
  { group: '', items: [{ label: 'Telegram', href: '/settings/telegram' }] },
  { group: 'System', items: [{ label: 'Workers & Health', href: '/settings/system' }, { label: 'Storage & Logs', href: '/settings/storage' }] },
];
function buildNav() {
  const nl = $('#navLinks');
  nl.innerHTML = '';
  for (const { group, items } of NAV_ITEMS) {
    if (group) nl.appendChild(h(`<div class="navGroup">${esc(group)}</div>`));
    for (const it of items) {
      const a = h(`<a class="navItem" href="#${it.href}">${esc(it.label)}</a>`);
      nl.appendChild(a);
    }
  }
}
function highlightNav(hash) {
  $$('.navItem', nav).forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + hash));
}
$('#logoutBtn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  location.hash = '/login';
});

/* ================= PAGES ================= */
const PAGES = {

/* ---------- login ---------- */
async login() {
  main.innerHTML = `
  <div style="max-width:380px;margin:9vh auto">
    <div class="card">
      <h1>🎬 ClipStudio</h1>
      <p class="sub">Sign in to your workspace</p>
      <form id="loginForm">
        <label>Username</label><input type="text" name="username" autocomplete="username" autofocus>
        <label>Password</label><input type="password" name="password" autocomplete="current-password">
        <div class="row" style="margin-top:18px"><button class="btn wide">Log in</button></div>
      </form>
    </div>
  </div>`;
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('/api/auth/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } });
      toast('Welcome back!');
      location.hash = '/dashboard';
    } catch (err) { toast(err.message, 'err'); }
  });
},

/* ---------- dashboard ---------- */
async dashboard() {
  const d = await api('/api/dashboard');
  const q = d.queue;
  const bar = (label, val, pct) => `<div class="scoreRow"><span>${label}</span><div class="bar"><i style="width:${pct}%"></i></div><span>${val}</span></div>`;
  main.innerHTML = `
  <div class="pageHead"><div><h1>Dashboard</h1><p class="sub">Your local AI video clipping workspace</p></div>
    <a class="btn" href="#/projects">+ New project</a></div>
  <div class="grid cols-4">
    <div class="card"><div class="stat">${d.counts.projects}</div><div class="stat-label">Projects</div></div>
    <div class="card"><div class="stat">${d.counts.clips}</div><div class="stat-label">Clips generated</div></div>
    <div class="card"><div class="stat">${d.counts.selected}</div><div class="stat-label">Selected</div></div>
    <div class="card"><div class="stat">${q.running}<div style="font-size:13px;color:var(--muted)">/ ${q.queued} queued</div></div><div class="stat-label">Worker</div></div>
  </div>
  <div class="grid cols-2" style="margin-top:16px">
    <div class="card"><h2>Recent projects</h2>
      ${d.recentProjects.length ? `<table>${d.recentProjects.map((p) => `<tr><td><a href="#/projects/${p.id}">${esc(p.name)}</a></td><td>${statusBadge(p.status)}</td><td class="mono" style="color:var(--muted)">${esc((p.created_at || '').slice(5, 16))}</td></tr>`).join('')}</table>` : '<p class="hint">No projects yet — upload a video to get started.</p>'}
    </div>
    <div class="card"><h2>Job queue</h2>
      ${bar('Queued', q.queued, Math.min(100, q.queued * 12))}
      ${bar('Running', q.running, Math.min(100, q.running * 50))}
      ${bar('Done', q.done, Math.min(100, q.done))}
      ${bar('Failed', q.failed, Math.min(100, q.failed))}
      <div style="margin-top:14px">${d.recentFailedJobs.length ? `<span class="badge red">${d.recentFailedJobs.length} failed job(s)</span> <a href="#/settings/system" class="btn ghost small">View</a>` : '<span class="hint">No failed jobs 🎉</span>'}</div>
    </div>
  </div>`;
},

/* ---------- projects ---------- */
async projects() {
  const { projects } = await api('/api/projects');
  main.innerHTML = `
  <div class="pageHead"><div><h1>Projects</h1><p class="sub">Long videos in, short clips out</p></div></div>
  <div class="dropzone" id="dz">Drop a video here, or click to browse<br><span class="hint">mp4 · mov · mkv · webm · avi</span></div>
  <input type="file" id="file" accept="video/*,.mkv" class="hidden">
  <div class="row" style="margin-top:10px;gap:8px">
    <input type="url" id="url" placeholder="…or paste a YouTube / video URL" style="flex:1" />
    <button class="btn" id="urlBtn">Add from URL</button>
  </div>
  <div id="projList" style="margin-top:18px"></div>`;
  const dz = $('#dz'), file = $('#file');
  dz.addEventListener('click', () => file.click());
  ['dragover', 'dragenter'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) upload(f); });
  file.addEventListener('change', () => file.files[0] && upload(file.files[0]));
  async function upload(f) {
    dz.innerHTML = `Uploading <b>${esc(f.name)}</b>…`;
    const fd = new FormData();
    fd.append('video', f);
    try {
      const { project } = await api('/api/projects', { method: 'POST', body: fd });
      toast('Upload complete — pipeline started');
      location.hash = `#/projects/${project.id}`;
    } catch (e) { toast(e.message, 'err'); dz.innerHTML = 'Upload failed. Drop a video here.'; }
  }
  const urlInput = $('#url'), urlBtn = $('#urlBtn');
  async function fromUrl() {
    const url = urlInput.value.trim();
    if (!url) return;
    urlBtn.disabled = true;
    urlBtn.textContent = 'Starting…';
    try {
      const { project } = await api('/api/projects/url', { method: 'POST', body: { url } });
      toast('Download started — safe to refresh, it runs in the background');
      location.hash = `#/projects/${project.id}`;
    } catch (e) { toast(e.message, 'err'); }
    finally { urlBtn.disabled = false; urlBtn.textContent = 'Add from URL'; }
  }
  urlBtn.addEventListener('click', fromUrl);
  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') fromUrl(); });
  const list = $('#projList');
  async function renderList() {
    const { projects: ps } = await api('/api/projects');
    list.innerHTML = ps.length
      ? `<table><tr><th>Name</th><th>Status</th><th>Duration</th><th>Created</th><th></th></tr>
        ${ps.map((p) => `<tr>
          <td><a href="#/projects/${p.id}"><b>${esc(p.name)}</b></a><div class="mono hint">${esc(p.id)}</div></td>
          <td>${statusBadge(p.status)}
            ${p.status === 'DOWNLOADING' && p.job ? `<div class="progress" style="width:140px;margin-top:6px"><i style="width:${p.job.progress}%"></i></div><div class="hint">${p.job.progress}%</div>` : ''}
            ${p.error ? `<div class="hint">${esc(String(p.error).slice(0, 60))}</div>` : ''}</td>
          <td class="mono">${p.meta ? fmtTime(p.meta.duration) : '—'}</td>
          <td class="mono hint">${esc((p.created_at || '').slice(5, 16))}</td>
          <td><button class="btn ghost small" data-del="${p.id}">🗑</button></td>
        </tr>`).join('')}</table>`
      : '<p class="hint">No projects yet.</p>';
    $$('button[data-del]', list).forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Delete this project and all its files?')) return;
      await api(`/api/projects/${b.dataset.del}`, { method: 'DELETE' });
      toast('Project deleted'); renderList();
    }));
    const active = ps.some((p) => ['DOWNLOADING', 'TRANSCRIBING', 'ANALYZING', 'FINDING_CLIPS', 'SCORING', 'RENDERING'].includes(p.status));
    if (active) poll(renderList, 3000);
  }
  renderList();
},

/* ---------- project detail ---------- */
async projectDetail(hash) {
  const id = hash.split('/')[2];
  const pageHash = `#/projects/${id}`;
  let proj;
  let first = true;
  let sig = {};
  // Update a section only when its content actually changed (avoids rebuilding
  // the video element / transcript on every poll tick).
  const setSection = (sel, html) => {
    const el = $(sel);
    if (!el || sig[sel] === html) return false;
    sig[sel] = html;
    el.innerHTML = html;
    return true;
  };
  const load = async () => {
    const d = await api(`/api/projects/${id}`);
    if (location.hash !== pageHash) return; // navigated away: stop stale poll/render
    proj = d;
    render();
    const active = ['DOWNLOADING', 'TRANSCRIBING', 'ANALYZING', 'FINDING_CLIPS', 'SCORING', 'RENDERING'].includes(proj.project.status);
    if (active) poll(load, 2500);
  };
  const render = () => {
    const p = proj.project, m = proj.meta;
    const jobs = (proj.jobs || []).slice(0, 8);
    const clips = proj.clips || [];
    if (!$('#tr')) {
      // first render for this visit: build the static shell once
      sig = {};
      main.innerHTML = `
      <div class="pageHead">
        <div><a class="hint" href="#/projects">← Projects</a><h1>${esc(p.name)}</h1>
          <div class="row" style="margin-top:6px" id="headMeta"></div>
        </div>
        <div class="row" id="headBtns"></div>
      </div>
      <div id="failBox"></div>
      <div id="dlBox"></div>
      <div class="grid cols-2">
        <div class="card"><h2>Source video</h2><div id="srcBox"></div></div>
        <div class="card"><h2>Pipeline</h2><div id="pipe" class="pipeline"></div><div id="pipeJobs"></div></div>
      </div>
      <div class="grid cols-2" style="margin-top:16px">
        <div class="card"><h2>Transcript</h2><div class="transcript" id="tr"></div></div>
        <div class="card"><h2>Clip candidates <span class="hint" id="clipCount"></span></h2><div id="clips" class="grid" style="gap:10px"></div></div>
      </div>`;
      // delegated listeners on stable containers (sections re-render into them)
      $('#headBtns').addEventListener('click', async (e) => {
        const t = e.target;
        if (t.id === 'rerunBtn') {
          const choice = prompt('Rerun from which stage?\n1) transcription  2) analysis  3) candidates  4) scoring', '1');
          const map = { 1: 'transcription', 2: 'analysis', 3: 'candidates', 4: 'scoring' };
          const stage = map[choice || '1'];
          if (!stage) return;
          await api(`/api/projects/${id}/run`, { method: 'POST', body: { from: stage } });
          toast('Rerunning from ' + stage);
          setTimeout(load, 500);
        } else if (t.id === 'selectBtn') {
          const n = prompt('Select top N clips:', '5');
          if (!n) return;
          try { await api(`/api/projects/${id}/select`, { method: 'POST', body: { top: parseInt(n, 10) } }); toast('Selection updated'); load(); }
          catch (err) { toast(err.message, 'err'); }
        }
      });
      $('#failBox').addEventListener('click', async (e) => {
        if (e.target.id !== 'retryBtn') return;
        await api(`/api/projects/${id}/run`, { method: 'POST', body: { from: 'transcription' } });
        toast('Retrying pipeline'); setTimeout(load, 400);
      });
    }
    setSection('#headMeta', `${statusBadge(p.status)}
      ${m ? `<span class="pill mono">${fmtTime(m.duration)}</span><span class="pill mono">${m.width}×${m.height}</span><span class="pill mono">${m.fps}fps</span><span class="pill mono">${esc(m.vcodec)}${m.acodec ? ' / ' + esc(m.acodec) : ''}</span>` : ''}
      ${proj.transcript ? `<span class="pill mono">🗣 ${esc(proj.transcript.language)} · ${proj.transcript.segmentCount} segments</span>` : ''}`);
    setSection('#headBtns', `${p.status === 'UPLOADED' ? '' : `<button class="btn ghost small" id="rerunBtn">↻ Rerun analysis</button>`}
      <button class="btn ghost small" id="selectBtn">Select top clips</button>`);
    setSection('#failBox', p.status === 'FAILED' ? `<div class="card" style="border-color:var(--bad);margin-bottom:16px">⚠️ ${esc(p.error || 'Pipeline failed')} <button class="btn small" id="retryBtn" style="margin-left:12px">Retry</button></div>` : '');
    const dlJob = jobs.find((j) => j.type === 'download' && ['queued', 'running'].includes(j.status));
    setSection('#dlBox', dlJob ? `<div class="card" style="margin-bottom:16px"><b>⬇ Downloading video…</b>
      <div class="row" style="gap:10px;margin-top:8px"><div class="progress" style="flex:1"><i id="dlBar" style="width:${dlJob.progress}%"></i></div><span class="mono">${dlJob.progress}%</span></div></div>` : '');
    setSection('#srcBox', p.status === 'DOWNLOADING'
      ? '<span class="hint">Download in progress — the video appears here when finished.</span>'
      : `<video controls preload="metadata" src="/api/projects/${id}/source"></video>`);
    const stages = ['SOURCE', 'TRANSCRIBE', 'ANALYZE', 'FIND_CLIPS', 'SCORE', 'READY', 'RENDER'];
    const curIdx = stages.indexOf(p.status === 'UPLOADED' || p.status === 'DOWNLOADING' ? 'SOURCE' : p.status);
    $('#pipe').innerHTML = stages.map((s, i) => {
      const state = i < (curIdx < 0 ? 99 : curIdx) ? 'done' : i === curIdx ? 'cur' : 'todo';
      if (p.status === 'FAILED') return `<div class="scoreRow"><span>${s}</span><div class="bar"><i style="width:${i < (curIdx < 0 ? 0 : curIdx) ? 100 : 0}%"></i></div><span>${state === 'done' ? '✅' : state === 'cur' ? '💥' : ''}</span></div>`;
      return `<div class="scoreRow"><span>${s}</span><div class="bar"><i style="width:${state === 'done' ? 100 : state === 'cur' ? (first ? 8 : 60) : 0}%"></i></div><span>${state === 'done' ? '✅' : state === 'cur' ? '…' : ''}</span></div>`;
    }).join('');
    setSection('#pipeJobs', jobs.length ? `<h2 style="margin-top:18px">Recent jobs</h2><div class="mono hint">${jobs.map((j) => `${j.status === 'done' ? '✅' : j.status === 'failed' ? '❌' : '⏳'} ${j.type} ${j.status === 'running' || j.status === 'queued' ? j.progress + '%' : ''}${j.error ? ' — ' + esc(String(j.error).slice(0, 40)) : ''}`).join('<br>')}</div>` : '');
    if (setSection('#tr', (proj.transcriptFull?.segments || []).map((s, i) =>
      `<div class="seg" data-t="${s.start}" data-i="${i}"><span class="t">${fmtTime(s.start)}</span>${esc(s.text)}</div>`).join('') || '<span class="hint">Transcribing…</span>')) {
      $$('.seg', $('#tr')).forEach((el) => el.addEventListener('click', () => {
        const t = parseFloat(el.dataset.t);
        const v = $('#main video');
        if (v) { v.currentTime = t; v.play().catch(() => {}); }
      }));
    }
    if (setSection('#clips', clips.length ? clips.map((c) => clipCard(c)).join('') : '<span class="hint">No clips on this project yet.</span>')) wireClipCards($('#clips'));
    $('#clipCount').textContent = `(${clips.length})`;
  };
  await load();
  first = false;
},

/* ---------- clips overview ---------- */
async clips() {
  const { clips } = await api('/api/clips');
  main.innerHTML = `
  <div class="pageHead"><div><h1>Clips</h1><p class="sub">All clips across your projects</p></div></div>
  <div id="clipsGrid" class="grid cols-2">${clips.length ? clips.map((c) => clipCard(c)).join('') : '<span class="hint">No clips yet.</span>'}
  </div>
  <table style="margin-top:18px">
    <tr><th>Clip</th><th>Project</th><th>Score</th><th>Window</th><th>Status</th></tr>
    ${clips.map((c) => `<tr>
      <td><a href="#/clips/${c.id}"><b>${esc(c.title || 'Untitled')}</b></a></td>
      <td><a href="#/projects/${c.project_id}">${esc(c.project_id)}</a></td>
      <td style="color:${scoreColor(c.overall)}"><b>${c.overall?.toFixed(0) ?? '?'}</b></td>
      <td class="mono">${fmtTime(c.start)} → ${fmtTime(c.end)}</td>
      <td>${statusBadge(c.status)}</td>
    </tr>`).join('')}</table>`;
  wireClipCards($('#clipsGrid'));
},

/* ---------- clip detail ---------- */
async clipDetail(hash) {
  const id = hash.split('/')[2];
  const load = async () => {
    const d = await api(`/api/clips/${id}`);
    const c = d.clip;
    const proj = d.project;
    const scores = Object.entries(c.scores || {});
    const render = () => {
      main.innerHTML = `
      <div class="pageHead"><div><a class="hint" href="#/clips">← Clips</a><h1>${esc(c.title || 'Untitled clip')}</h1>
        <div class="row" style="margin-top:6px">${statusBadge(c.status)}
          <span class="pill mono">${fmtTime(c.start)} → ${fmtTime(c.end)} (${c.duration.toFixed(1)}s)</span>
          <span class="pill mono">${esc(c.aspect || '9:16')}</span>
          <span class="pill mono">preset: ${esc(c.subtitle_preset || 'default')}</span>
        </div></div>
        <div class="row">
          <button class="btn ghost small" id="pvBtn">👁 Preview</button>
          <button class="btn good small" id="rdBtn">Render final</button>
          <button class="btn ghost small" id="rejBtn">Reject</button>
        </div>
        <div id="rBar" class="progress hidden" style="margin-top:8px;max-width:340px"><i></i></div>
        <div id="rTxt" class="hint mono hidden" style="margin-top:4px"></div></div>
      <div class="grid cols-2">
        <div class="card"><h2>Preview / output</h2>
          <video id="clipVid" controls preload="none"></video>
          <div id="vidStatus" class="hint" style="margin-top:8px"></div>
          <a id="dlLink" class="btn small hidden" href="#" style="margin-top:8px">⬇ Download render</a>
          <div class="row" style="margin-top:12px">
            <label style="margin:0;width:auto">Aspect</label>
            <select id="aspectSel" style="width:120px">
              ${['9:16', '1:1', '16:9'].map((a) => `<option ${a === (c.aspect || '9:16') ? 'selected' : ''}>${a}</option>`).join('')}
            </select>
            <label style="margin:0;width:auto;font-size:12.5px;color:var(--muted)">Subtitle preset</label>
            <select id="presSel" style="width:140px"></select>
            <button class="btn small" id="saveStyle">Save style</button>
          </div>
          <div class="row" style="margin-top:14px">
            <input type="text" id="aiEdit" placeholder="AI re-edit: e.g. “start 5 seconds earlier”, “remove first sentence”, “use 9:16”…">
            <button class="btn small" id="aiEditBtn">✨ Apply</button>
          </div>
          <div class="hint mono" id="aiEditResult" style="margin-top:8px"></div>
        </div>
        <div class="card"><h2>Clip detail</h2>
          ${c.hook ? `<p><b>Hook:</b> ${esc(c.hook)}</p>` : ''}
          ${c.reason ? `<p><b>Why it works:</b> ${esc(c.reason)}</p>` : ''}
          <label>Title</label><input type="text" id="titleIn" value="${esc(c.title || '')}">
          <div class="row" style="margin-top:10px">
            <div style="flex:1"><label>Start (s)</label><input type="number" step="0.1" id="startIn" value="${c.start}"></div>
            <div style="flex:1"><label>End (s)</label><input type="number" step="0.1" id="endIn" value="${c.end}"></div>
            <div style="align-self:flex-end"><button class="btn wide" id="saveWin">Save window</button></div>
          </div>
          <h2 style="margin-top:20px">Score ${c.overall != null ? `<span style="color:${scoreColor(c.overall)}">${c.overall.toFixed(0)}</span>/100` : ''}</h2>
          ${scores.map(([k, v]) => `<div class="scoreRow"><span class="hint">${k}</span><div class="bar"><i style="width:${(v / 10) * 100}%"></i></div><span>${v.toFixed(1)}</span></div>`).join('') || '<span class="hint">not scored</span>'}
          ${proj ? `<p class="hint" style="margin-top:20px">Project: <a href="#/projects/${proj.id}">${esc(proj.name)}</a></p>` : ''}
        </div>
      </div>`;
      // preset list
      const pres = $('#presSel');
      api('/api/settings/subtitles').then((s) => {
        pres.innerHTML = Object.keys(s.presets ?? {}).map((k) => `<option ${k === (c.subtitle_preset || '') ? 'selected' : ''}>${k}</option>`).join('') || '<option>classic</option>';
      }).catch(() => {});
      // player source
      const vid = $('#clipVid'), st = $('#vidStatus');
      const srcFor = (kind) => `/media/${kind === 'preview' ? 'previews' : 'outputs'}/${id}_${kind}.mp4`;
    const trySrcs = async () => {
      for (const kind of ['final', 'preview']) {
          const url = srcFor(kind);
          const head = await fetch(url, { method: 'HEAD', credentials: 'same-origin' }).catch(() => null);
          if (head && head.ok) {
            st.textContent = `${kind === 'preview' ? 'Preview' : 'Final'} render available`;
            if (vid.dataset.src !== url) { vid.dataset.src = url; vid.src = url; }
            const dl = $('#dlLink');
            if (dl) { dl.href = url; dl.download = `${id}_${kind}.mp4`; dl.classList.remove('hidden'); }
            return true;
          }
        }
        st.textContent = 'No render yet — hit Preview or Render.';
        if (vid.hasAttribute('src')) { vid.removeAttribute('src'); delete vid.dataset.src; }
        const dl = $('#dlLink');
        if (dl) dl.classList.add('hidden');
        return false;
      };
      trySrcs();
      $('#saveStyle').addEventListener('click', async () => {
        try {
          await api(`/api/clips/${id}`, { method: 'PATCH', body: { aspect: $('#aspectSel').value, subtitle_preset: $('#presSel').value } });
          toast('Style saved'); load();
        } catch (e) { toast(e.message, 'err'); }
      });
      $('#saveWin').addEventListener('click', async () => {
        const s = parseFloat($('#startIn').value), e2 = parseFloat($('#endIn').value);
        if (isNaN(s) || isNaN(e2)) return toast('Enter valid times', 'err');
        try { await api(`/api/clips/${id}`, { method: 'PATCH', body: { start: s, end: e2, title: $('#titleIn').value } }); toast('Window saved'); load(); }
        catch (err) { toast(err.message, 'err'); }
      });
      $('#pvBtn').addEventListener('click', async () => {
        try {
          await api(`/api/clips/${id}`, { method: 'PATCH', body: { aspect: $('#aspectSel').value, subtitle_preset: $('#presSel').value } });
          await api(`/api/clips/${id}/preview`, { method: 'POST' });
          toast('Preview rendering started'); poll(doPoll, 3000); doPoll();
        }
        catch (e) { toast(e.message, 'err'); }
      });
      $('#rdBtn').addEventListener('click', async () => {
        try {
          await api(`/api/clips/${id}`, { method: 'PATCH', body: { aspect: $('#aspectSel').value, subtitle_preset: $('#presSel').value } });
          await api(`/api/clips/${id}/render`, { method: 'POST', body: { kind: 'final' } });
          toast('Final render started'); poll(doPoll, 3000); doPoll();
        }
        catch (e) { toast(e.message, 'err'); }
      });
      $('#rejBtn').addEventListener('click', async () => {
        try { await api(`/api/clips/${id}/reject`, { method: 'POST' }); toast('Clip rejected'); location.hash = '#/clips'; }
        catch (e) { toast(e.message, 'err'); }
      });
      $('#aiEditBtn').addEventListener('click', async () => {
        const instruction = $('#aiEdit').value.trim();
        if (!instruction) return;
        $('#aiEditBtn').disabled = true;
        $('#aiEditResult').textContent = 'Thinking…';
        try {
          const r = await api(`/api/clips/${id}/ai-edit`, { method: 'POST', body: { instruction } });
          $('#aiEditResult').textContent = r.ok ? `✓ ${r.note}` : `✗ ${r.note}`;
          if (r.ok) { Object.assign(c, r.clip || {}); setTimeout(load, 600); }
        } catch (e) { $('#aiEditResult').textContent = '✗ ' + e.message; toast(e.message, 'err'); }
        $('#aiEditBtn').disabled = false;
      });
    };
    render();
    // poll while rendering, but only re-render the page when the clip status
    // actually changes (keeps the player/inputs stable between ticks)
    const setRenderProgress = (job) => {
      const bar = $('#rBar'), txt = $('#rTxt');
      if (!bar || !txt) return;
      const active = job && ['queued', 'running'].includes(job.status);
      bar.classList.toggle('hidden', !active);
      if (active) {
        const pct = job.status === 'queued' ? 0 : job.progress;
        bar.firstElementChild.style.width = pct + '%';
        txt.style.color = '';
        txt.textContent = `${job.type === 'render_preview' ? 'Preview' : 'Final render'} ${job.status} — ${pct}%`;
        txt.classList.remove('hidden');
      } else if (job && job.status === 'failed' && job.error) {
        txt.style.color = '#e66';
        txt.textContent = `Render failed: ${job.error.slice(0, 160)}`;
        txt.classList.remove('hidden');
      } else {
        txt.classList.add('hidden');
      }
      const pv = $('#pvBtn'), rd = $('#rdBtn');
      if (pv && rd) {
        pv.disabled = !!active; rd.disabled = !!active;
        if (active) {
          const what = job.type === 'render_preview' ? 'Preview' : 'Final';
          const pct = job.status === 'queued' ? '' : ` ${job.progress}%`;
          rd.textContent = `⏳ ${what} ${job.status}${pct}`;
        } else {
          rd.textContent = 'Render final';
        }
      }
    };
    const doPoll = () => {
      api(`/api/clips/${id}`).then((d) => {
        const prev = c.status;
        Object.assign(c, d.clip);
        const rendering = ['RENDERING'].includes(d.project?.status);
        const hasRender = ['previewed', 'rendered_final'].includes(c.status);
        if (c.status !== prev && (rendering || hasRender)) render();
        setRenderProgress(d.job);
        if (!rendering && !hasRender && pollTimer) stopPoll();
      }).catch(() => {});
    };
    poll(doPoll, 3000);
  };
  await load();
},

/* ---------- settings: AI ---------- */
async settingsAi() {
  const [s, models] = await Promise.all([
    api('/api/settings/ai'),
    api('/api/ai/models').catch(() => ({ models: [] })),
  ]);
  const tasks = ['highlight_detection', 'clip_scoring', 'clip_boundary', 'title_generation', 'subtitle_analysis', 'content_analysis'];
  const opt = (val, m) => `<option ${m === val ? 'selected' : ''}>${esc(m)}</option>`;
  main.innerHTML = `
  <div class="pageHead"><div><h1>AI — Models & Routing</h1><p class="sub">9Router (OpenAI-compatible) configuration. API key stays on the server.</p></div></div>
  <div class="grid cols-2">
    <div class="card"><h2>Connection</h2>
      <label>Base URL</label><input type="text" id="base_url" value="${esc(s.base_url)}">
      <label>API key</label><input type="text" value="${esc(s.api_key || s.api_key_set ? '****' + (s.api_key || '').slice(-4) : '')}" placeholder="leave blank to keep current key">
      <div class="hint">Leave the key blank when saving to keep the existing key.</div>
      <label>Default model</label>
      <input type="text" id="default_model" value="${esc(s.default_model)}" list="modelList">
      <label>Fallback model</label><input type="text" id="fallback_model" value="${esc(s.fallback_model || '')}" list="modelList">
      <datalist id="modelList">${models.models.map((m) => `<option value="${esc(m)}">`).join('')}</datalist>
      <div class="field-grid">
        <div><label>Temperature (0–2)</label><input type="number" step="0.05" id="temperature" value="${s.temperature}"></div>
        <div><label>Max tokens</label><input type="number" step="256" id="max_tokens" value="${s.max_tokens}"></div>
        <div><label>Timeout (ms)</label><input type="number" step="5000" id="timeout_ms" value="${s.timeout_ms}"></div>
        <div><label>Retries</label><input type="number" id="request_retries" value="${s.request_retries}"></div>
      </div>
      <div class="row" style="margin-top:18px">
        <button class="btn" id="saveBtn">Save</button>
        <button class="btn ghost" id="testConn">Test connection</button>
        <span class="hint" id="connStatus"></span>
      </div>
      <div class="row" style="margin-top:10px">
        <input type="text" id="testModelIn" placeholder="Test a specific model (e.g. deepseek-v4.1-flash)" list="modelList" style="flex:1">
        <button class="btn ghost" id="testModel">Test model</button>
        <span class="hint" id="modelStatus"></span>
      </div>
    </div>
    <div class="card"><h2>Task → model routing</h2>
      <p class="hint">Every AI call goes through this table — task names never appear in app code.</p>
      ${tasks.map((t) => `<label>${t}</label>
        <input type="text" data-task="${t}" value="${esc(s.routing?.[t] || s.default_model)}" list="modelList">`).join('')}
      <div class="row" style="margin-top:18px"><button class="btn good" id="saveRouting">Save routing</button></div>
    </div>
  </div>`;
  $('#saveBtn').addEventListener('click', async () => {
    const body = {
      base_url: $('#base_url').value.trim(), template: 0,
      default_model: $('#default_model').value.trim(),
      fallback_model: $('#fallback_model').value.trim(),
      temperature: parseFloat($('#temperature').value),
      max_tokens: parseInt($('#max_tokens').value, 10),
      timeout_ms: parseInt($('#timeout_ms').value, 10),
      request_retries: parseInt($('#request_retries').value, 10),
    };
    try { await api('/api/settings/ai', { method: 'PUT', body }); toast('AI settings saved'); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#saveRouting').addEventListener('click', async () => {
    const routing = {};
    $$('input[data-task]').forEach((i) => (routing[i.dataset.task] = i.value.trim()));
    try { await api('/api/settings/ai', { method: 'PUT', body: { routing } }); toast('Routing saved'); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#testConn').addEventListener('click', async () => {
    $('#connStatus').textContent = 'Testing…';
    const r = await api('/api/settings/ai/test', { method: 'POST' });
    $('#connStatus').innerHTML = r.ok ? `<span style="color:var(--good)">✓ ${r.models.length} models available</span>` : `<span style="color:var(--bad)">✗ ${esc(r.error)}</span>`;
    if (r.ok) toast('9Router reachable');
  });
  $('#testModel').addEventListener('click', async () => {
    const m = $('#testModelIn').value.trim();
    if (!m) return toast('Enter a model name', 'err');
    $('#modelStatus').textContent = 'Testing ' + m + '…';
    const r = await api('/api/settings/ai/test-model', { method: 'POST', body: { model: m } });
    $('#modelStatus').innerHTML = r.ok ? `<span style="color:var(--good)">✓ replied: “${esc(r.reply)}”</span>` : `<span style="color:var(--bad)">✗ ${esc(r.error)}</span>`;
  });
},

/* ---------- settings: prompts ---------- */
async settingsPrompts() {
  const d = await api('/api/prompts');
  main.innerHTML = `
  <div class="pageHead"><div><h1>AI — Prompts</h1><p class="sub">Edit, test, and reset each task's system prompt. Variables use {{braces}}.</p></div></div>
  <div class="row" id="taskTabs" style="margin-bottom:10px">${d.tasks.map((t, i) => `<button class="btn ghost small ${i === 0 ? 'active' : ''}" data-task="${t}" style="border-color:${i === 0 ? 'var(--accent)' : ''}">${t.replace(/_/g, ' ')}</button>`).join('')}</div>
  <div class="card">
    <div id="varHint" class="hint"></div>
    <textarea id="promptText" style="min-height:380px"></textarea>
    <div class="row between" style="margin-top:14px">
      <span class="hint" id="diffNote"></span>
      <div class="row">
        <input type="text" id="testVars" placeholder='test variables JSON, e.g. {"duration": 120}' style="width:320px">
        <button class="btn ghost" id="testBtn">Test prompt</button>
        <button class="btn ghost" id="resetBtn">Restore default</button>
        <button class="btn" id="saveBtn">Save</button>
      </div>
    </div>
    <div id="testOut" class="card" style="background:var(--bg2);margin-top:14px;display:none">
      <h2>Test output</h2><div class="mono" id="testOutText" style="white-space:pre-wrap;font-size:12px"></div>
    </div>
  </div>`;
  let current = d.tasks[0];
  const pt = $('#promptText');
  const setTask = (t) => {
    current = t;
    $$('#taskTabs .btn').forEach((b) => {
      const on = b.dataset.task === t;
      b.classList.toggle('active', on);
      b.style.borderColor = on ? 'var(--accent)' : '';
    });
    api(`/api/prompts/${t}`).then((p) => {
      pt.value = p.text;
      $('#varHint').textContent = 'Variables: ' + p.variables.map((v) => `{{${v}}}`).join('  ');
      $('#diffNote').textContent = p.text.trim() === String(d.defaults[t] || '').trim() ? '● default prompt' : '● customized';
    });
  };
  $$('#taskTabs .btn').forEach((b) => b.addEventListener('click', () => setTask(b.dataset.task)));
  setTask(d.tasks[0]);
  $('#saveBtn').addEventListener('click', async () => {
    try { await api(`/api/prompts/${current}`, { method: 'PUT', body: { text: pt.value } }); toast('Prompt saved'); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#resetBtn').addEventListener('click', async () => {
    if (!confirm('Reset this prompt to the default?')) return;
    const r = await api(`/api/prompts/${current}/reset`, { method: 'POST' });
    pt.value = r.text; $('#diffNote').textContent = '● default prompt';
  });
  $('#testBtn').addEventListener('click', async () => {
    let vars = {};
    try { vars = JSON.parse($('#testVars').value || '{}'); } catch { toast('Vars must be valid JSON', 'err'); return; }
    $('#testBtn').disabled = true; $('#testOut').style.display = 'block';
    $('#testOutText').textContent = 'Running test…';
    try {
      const r = await api(`/api/prompts/${current}/test`, { method: 'POST', body: { variables: vars } });
      $('#testOutText').textContent = `model: ${r.model}\n\n${r.output}`;
    } catch (e) { $('#testOutText').textContent = 'ERROR: ' + e.message; }
    $('#testBtn').disabled = false;
  });
},

/* ---------- settings: clipping ---------- */
async settingsClipping() {
  const s = await api('/api/settings/clipping');
  const w = await api('/api/settings/scoring');
  const pipe = await api('/api/settings/pipeline');
  const langs = [['auto', 'Auto-detect'], ['id', 'Indonesian'], ['en', 'English'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['ar', 'Arabic'], ['es', 'Spanish'], ['pt', 'Portuguese'], ['hi', 'Hindi'], ['de', 'German'], ['fr', 'French']];
  main.innerHTML = `
  <div class="pageHead"><div><h1>Clipping — Detection, Scoring & Boundaries</h1><p class="sub">Clip length limits, dedup threshold, boundary padding and scoring weights.</p></div></div>
  <div class="grid cols-2">
    <div class="card"><h2>Detection & boundaries</h2>
      <div class="field-grid">
        <div><label>Min clip duration (s)</label><input type="number" id="min_clip_duration" value="${s.min_clip_duration}"></div>
        <div><label>Max clip duration (s)</label><input type="number" id="max_clip_duration" value="${s.max_clip_duration}"></div>
        <div><label>Target duration (s)</label><input type="number" id="target_clip_duration" value="${s.target_clip_duration}"></div>
        <div><label>Default top N</label><input type="number" id="top_clips" value="${s.top_clips}"></div>
        <div><label>Overlap threshold (0–1)</label><input type="number" step="0.05" id="overlap_threshold" value="${s.overlap_threshold}"></div>
        <div><label>Max candidates</label><input type="number" id="max_candidates" value="${s.max_candidates}"></div>
        <div><label>Padding before (s)</label><input type="number" step="0.1" id="pad_before" value="${s.pad_before}"></div>
        <div><label>Padding after (s)</label><input type="number" step="0.1" id="pad_after" value="${s.pad_after}"></div>
      </div>
      <button class="btn" id="save" style="margin-top:16px">Save clipping settings</button>
    </div>
    <div class="card"><h2>Scoring weights (% · normalized automatically)</h2>
      ${Object.entries(w).map(([k, v]) => `<div class="scoreRow"><span class="hint">${k}</span><input type="number" class="w" data-k="${k}" value="${v}" style="width:100px"><span>${v}</span></div>`).join('')}
      <div class="row" style="margin-top:14px"><span class="hint" id="wSum"></span><button class="btn" id="saveW">Save weights</button></div>
    </div>
    <div class="card"><h2>Whisper (transcription)</h2>
      <div class="field-grid">
        <div><label>Model</label><select id="whisper_model">
          ${['tiny', 'base', 'small', 'medium'].map((m) => `<option ${m === pipe.whisper_model ? 'selected' : ''}>${m}</option>`).join('')}
        </select></div>
        <div><label>Language</label><select id="whisper_language">
          ${langs.map(([v, l]) => `<option value="${v}" ${v === pipe.whisper_language ? 'selected' : ''}>${l}</option>`).join('')}
        </select></div>
      </div>
      <p class="hint" style="margin-top:8px">Bigger model = more accurate but slower on CPU (small is a good fit for Indonesian). Locking the language is faster and more stable than auto-detect. Applies to the <b>next</b> transcription — use “↻ Rerun analysis” on a project to redo it.</p>
      <button class="btn" id="saveWhisper" style="margin-top:12px">Save whisper settings</button>
    </div>
  </div>`;
  const sum = () => $$('.w').reduce((a, e) => a + (parseFloat(e.value) || 0), 0);
  const updSum = () => { $('#wSum').textContent = `total: ${sum()}% (normalized to 100% on save)`; };
  $$('.w').forEach((e) => e.addEventListener('input', updSum));
  updSum();
  $('#save').addEventListener('click', async () => {
    const body = {};
    for (const k of ['min_clip_duration','max_clip_duration','target_clip_duration','top_clips','overlap_threshold','max_candidates','pad_before','pad_after']) body[k] = parseFloat(document.getElementById(k).value);
    try { await api('/api/settings/clipping', { method: 'PUT', body }); toast('Clipping settings saved'); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#saveW').addEventListener('click', async () => {
    const body = {};
    $$('.w').forEach((e) => (body[e.dataset.k] = parseFloat(e.value)));
    try { await api('/api/settings/scoring', { method: 'PUT', body }); toast('Weights saved'); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#saveWhisper').addEventListener('click', async () => {
    try {
      await api('/api/settings/pipeline', { method: 'PUT', body: { whisper_model: $('#whisper_model').value, whisper_language: $('#whisper_language').value } });
      toast('Whisper settings saved');
    } catch (e) { toast(e.message, 'err'); }
  });
},

/* ---------- settings: subtitles ---------- */
async settingsSubtitles() {
  const s = await api('/api/settings/subtitles');
  const presetKeys = Object.keys(s.presets);
  main.innerHTML = `
  <div class="pageHead"><div><h1>Video — Subtitles</h1><p class="sub">Burned-in SRT/ASS subtitles, presets, and punchline emphasis.</p></div></div>
  <div class="grid cols-2">
    <div class="card"><h2>Global</h2>
      <div class="checkbox"><input type="checkbox" id="enabled" ${s.enabled ? 'checked' : ''}><label for="enabled">Enable subtitles (burned into video)</label></div>
      <label>Default preset</label>
      <select id="preset">${presetKeys.map((k) => `<option ${k === s.preset ? 'selected' : ''}>${k}</option>`).join('')}</select>
      <label>Render engine</label>
      <select id="engine">
        <option value="remotion" ${s.engine !== 'ass' ? 'selected' : ''}>remotion — animated captions</option>
        <option value="ass" ${s.engine === 'ass' ? 'selected' : ''}>ass — ffmpeg burn-in (legacy)</option>
      </select>
      <h2 style="margin-top:22px">Emphasis (punchline words)</h2>
      <div class="checkbox"><input type="checkbox" id="emEnabled" ${s.emphasis.enabled ? 'checked' : ''}><label for="emEnabled">Emphasize matched words</label></div>
      <div class="field-grid">
        <div><label>Emphasis color</label><input type="color" id="emColor" value="${s.emphasis.color}" style="height:38px"></div>
        <div><label>Scale %</label><input type="number" id="emScale" value="${s.emphasis.scale_percent}"></div>
        <div class="checkbox" style="margin-bottom:0"><input type="checkbox" id="emBold" ${s.emphasis.bold ? 'checked' : ''}><label for="emBold">Bold</label></div>
      </div>
      <button class="btn" id="saveGlobal" style="margin-top:16px">Save global</button>
    </div>
    <div class="card"><h2>Presets</h2>
      <div id="presetTabs" class="row" style="margin-bottom:10px">${presetKeys.map((k, i) => `<button class="btn ghost small ${i === 0 ? 'active' : ''}" data-k="${k}">${k}</button>`).join('')}</div>
      <div class="field-grid" id="presetFields"></div>
      <div class="row" style="margin-top:16px">
        <input type="text" id="newPreset" placeholder="New preset name" style="width:160px">
        <button class="btn ghost" id="addPreset">+ Create</button>
        <span style="flex:1"></span><button class="btn" id="savePreset">Save preset</button>
      </div>
    </div>
  </div>`;
  const PF = [
    ['font', 'text'], ['font_size', 'num'], ['position', 'select:bottom;middle;top'], ['margin_v', 'num'],
    ['max_chars_per_line', 'num'], ['max_words_per_line', 'num'], ['max_lines', 'num'],
    ['primary_color', 'color'], ['outline_color', 'color'], ['outline_width', 'num'],
    ['bold', 'check'], ['uppercase', 'check'], ['karaoke', 'check'], ['karaoke_color', 'color'],
    ['animation', 'select:none;fade;typewriter'],
  ];
  const pf = $('#presetFields');
let currentPreset = null;
const renderPreset = () => {
    currentPreset = currentPreset || presetKeys[0];
    const p = s.presets[currentPreset];
    pf.innerHTML = PF.map(([k, type]) => {
      const head = k.replace(/_/g, ' ');
      if (type === 'text') return `<div><label>${head}</label><input data-k="${k}" value="${esc(p[k])}"></div>`;
      if (type === 'num') return `<div><label>${head}</label><input type="number" step="any" data-k="${k}" value="${p[k]}"></div>`;
      if (type === 'color') return `<div><label>${head}</label><input type="color" data-k="${k}" value="${p[k]}" style="height:38px"></div>`;
      if (type === 'check') return `<div class="checkbox"><input type="checkbox" data-k="${k}" ${p[k] ? 'checked' : ''}><label>${head}</label></div>`;
      const [, vals] = type.split(':');
      return `<div><label>${head}</label><select data-k="${k}">${vals.split(';').map((v) => `<option ${v === p[k] ? 'selected' : ''}>${v}</option>`).join('')}</select></div>`;
    }).join('');
  };
  renderPreset();
  $$('#presetTabs .btn').forEach((b) => b.addEventListener('click', () => {
    $$('#presetTabs .btn').forEach((x) => x.classList.toggle('active', x === b));
    currentPreset = b.dataset.k;
    renderPreset();
  }));
  $('#addPreset').addEventListener('click', () => {
    const name = $('#newPreset').value.trim().toLowerCase().replace(/\s+/g, '_');
    if (!name) return toast('Name required', 'err');
    if (s.presets[name]) return toast('Preset exists', 'err');
    s.presets[name] = { ...s.presets[presetKeys[0]] };
    presetKeys.push(name);
    api('/api/settings/subtitles', { method: 'PUT', body: { presets: { [name]: s.presets[name] } } })
      .then(() => { toast(`Preset ${name} created`); router(); })
      .catch((e) => toast(e.message, 'err'));
  });
  $('#saveGlobal').addEventListener('click', async () => {
    const body = {
      enabled: $('#enabled').checked, preset: $('#preset').value, engine: $('#engine').value,
      emphasis: { enabled: $('#emEnabled').checked, color: $('#emColor').value, scale_percent: parseInt($('#emScale').value, 10), bold: $('#emBold').checked },
    };
    try { await api('/api/settings/subtitles', { method: 'PUT', body }); toast('Subtitle settings saved'); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#savePreset').addEventListener('click', async () => {
    const p = { ...s.presets[currentPreset] };
    $$('#presetFields [data-k]').forEach((el) => {
      const k = el.dataset.k;
      const type = el.type;
      if (type === 'checkbox') p[k] = el.checked;
      else if (type === 'number' || type === 'text' || type === 'color') p[k] = type === 'number' ? parseFloat(el.value) : el.value;
      else p[k] = el.value;
    });
    const body = { presets: { [currentPreset]: p } };
    try { await api('/api/settings/subtitles', { method: 'PUT', body }); toast(`Preset ${currentPreset} saved`); }
    catch (e) { toast(e.message, 'err'); }
  });
},

/* ---------- settings: reframe ---------- */
async settingsReframe() {
  const s = await api('/api/settings/reframe');
  main.innerHTML = `
  <div class="pageHead"><div><h1>Video — Reframe</h1><p class="sub">Auto-crop & speaker tracking for vertical/square crops.</p></div></div>
  <div class="card" style="max-width:680px"><h2>Reframing</h2>
    <label>Default aspect ratio</label>
    <select id="aspect">${['9:16', '1:1', '16:9'].map((a) => `<option ${a === s.aspect ? 'selected' : ''}>${a}</option>`).join('')}</select>
    <div class="checkbox"><input type="checkbox" id="face_tracking" ${s.face_tracking ? 'checked' : ''}><label for="face_tracking">Face tracking (OpenCV Haar; falls back to static center crop when no face)</label></div>
    <div class="field-grid">
      <div><label>Sample interval (s)</label><input type="number" step="0.1" id="sample_interval" value="${s.sample_interval}"></div>
      <div><label>Smoothing window</label><input type="number" id="smoothing_window" value="${s.smoothing_window}"></div>
      <div><label>Max pan speed (px/s)</label><input type="number" id="max_speed" value="${s.max_speed}"></div>
      <div><label>Deadzone (px)</label><input type="number" id="deadzone" value="${s.deadzone}"></div>
    </div>
    <p class="hint">Pan is rate-limited to max_speed and suppressed inside the deadzone, so the camera never whips around. One or two speakers: the largest face (area-weighted) wins.</p>
    <button class="btn" id="save" style="margin-top:14px">Save</button>
  </div>`;
  $('#save').addEventListener('click', async () => {
    const body = {
      aspect: $('#aspect').value, face_tracking: $('#face_tracking').checked,
      sample_interval: parseFloat($('#sample_interval').value),
      smoothing_window: parseInt($('#smoothing_window').value, 10),
      max_speed: parseFloat($('#max_speed').value),
      deadzone: parseFloat($('#deadzone').value),
    };
    try { await api('/api/settings/reframe', { method: 'PUT', body }); toast('Reframe settings saved'); }
    catch (e) { toast(e.message, 'err'); }
  });
},

/* ---------- settings: render ---------- */
async settingsRender() {
  const s = await api('/api/settings/render');
  const F = [
    ['width', 'Width'], ['height', 'Height'], ['fps', 'FPS'], ['vcodec', 'Video codec'],
    ['acodec', 'Audio codec'], ['crf', 'CRF'], ['bitrate', 'Video bitrate (blank = use CRF)'],
    ['audio_bitrate', 'Audio bitrate'], ['preset', 'Encoding preset (ultrafast…veryslow)'],
    ['pixel_format', 'Pixel format'], ['container', 'Container'],
    ['preview_width', 'Preview width'], ['preview_height', 'Preview height'], ['preview_crf', 'Preview CRF'],
  ];
  main.innerHTML = `
  <div class="pageHead"><div><h1>Video — Rendering</h1><p class="sub">Final export defaults. Primary target: 1080×1920 @ 30fps H.264/AAC MP4.</p></div></div>
  <div class="card" style="max-width:760px"><h2>Encoding</h2>
    <div class="field-grid">${F.map(([k, label]) => `<div><label>${label}</label><input type="${['crf','fps','preview_crf','width','height','preview_width','preview_height'].includes(k) ? 'number' : 'text'}" id="${k}" value="${esc(s[k])}"></div>`).join('')}</div>
    <button class="btn" id="save" style="margin-top:16px">Save render settings</button>
  </div>`;
  $('#save').addEventListener('click', async () => {
    const body = {};
    for (const [k] of F) { const el = document.getElementById(k); body[k] = ['crf','fps','preview_crf','width','height','preview_width','preview_height'].includes(k) ? parseFloat(el.value) : el.value.trim(); }
    try { await api('/api/settings/render', { method: 'PUT', body }); toast('Render settings saved'); }
    catch (e) { toast(e.message, 'err'); }
  });
},

/* ---------- settings: telegram ---------- */
async settingsTelegram() {
  const [s, health] = await Promise.all([api('/api/settings/telegram'), api('/api/system/health')]);
  const tg = health.items.find((i) => i.name === 'Telegram');
  main.innerHTML = `
  <div class="pageHead"><div><h1>Telegram Bot</h1><p class="sub">A second interface to the same pipeline. Only one Telegram user is allowed (by numeric user id).</p></div></div>
  <div class="grid cols-2">
    <div class="card"><h2>Status</h2>
      <div class="row"><span class="dot ${tg.ok ? 'ok' : 'bad'}"></span><b>${esc(tg.detail)}</b></div>
      ${tg.error ? `<p style="color:var(--bad)">${esc(tg.error)}</p>` : ''}
      <p class="hint">Bot token and allowed user id are set in <span class="mono">.env</span> (secrets stay out of the dashboard).</p>
      <p class="hint">Start the bot process: <span class="mono">pnpm telegram</span></p>
    </div>
    <div class="card"><h2>Behavior</h2>
      <div class="checkbox"><input type="checkbox" id="enabled" ${s.enabled ? 'checked' : ''}><label for="enabled">Enable bot</label></div>
      <div class="checkbox"><input type="checkbox" id="send_progress" ${s.send_progress ? 'checked' : ''}><label for="send_progress">Send progress updates during the pipeline</label></div>
      <button class="btn" id="save">Save</button>
    </div>
  </div>`;
  $('#save').addEventListener('click', async () => {
    try { await api('/api/settings/telegram', { method: 'PUT', body: { enabled: $('#enabled').checked, send_progress: $('#send_progress').checked } }); toast('Telegram settings saved'); }
    catch (e) { toast(e.message, 'err'); }
  });
},

/* ---------- settings: storage ---------- */
async settingsStorage() {
  const [storage, logs] = await Promise.all([api('/api/system/storage'), api('/api/system/logs?limit=120')]);
  main.innerHTML = `
  <div class="pageHead"><div><h1>System — Storage & Logs</h1><p class="sub">Local filesystem usage and structured logs. No cloud storage.</p></div></div>
  <div class="card"><h2>Storage directories</h2>
    <table><tr><th>Dir</th><th>Path</th><th>Size</th></tr>
    ${storage.dirs.map((d) => `<tr><td>${esc(d.name)}</td><td class="mono" style="color:var(--muted)">${esc(d.path)}</td><td class="mono">${fmtBytes(d.size)}</td></tr>`).join('')}
    <tr><td><b>Total</b></td><td></td><td class="mono"><b>${fmtBytes(storage.total)}</b></td></tr></table>
    <p class="hint">Large video files stay on disk — the database only stores metadata + paths.</p></div>
  <div class="card" style="margin-top:16px"><h2>Recent logs</h2>
    <div class="row" style="margin-bottom:10px">
      <select id="logCat" style="width:180px"><option value="">All categories</option>${['AUTH','AI','TRANSCRIPTION','VIDEO','RENDER','TELEGRAM','QUEUE','SYSTEM'].map((c) => `<option>${c}</option>`).join('')}</select>
      <button class="btn ghost small" id="logRefresh">Refresh</button>
    </div>
    <div id="logBox"></div></div>`;
  const renderLogs = (rows) => {
    $('#logBox').innerHTML = rows.map((l) =>
      `<div class="logline"><span class="lvl ${esc(l.level)}">${esc(l.level.toUpperCase())}</span><span style="color:var(--muted)">${esc((l.ts || '').replace('T', ' ').slice(0, 19))}</span> [${esc(l.category)}] ${esc(l.message)}</div>`).join('') || '<span class="hint">No logs.</span>';
  };
  renderLogs(logs.logs);
  const refresh = () => api(`/api/system/logs?limit=120&category=${$('#logCat').value}`).then((r) => renderLogs(r.logs));
  $('#logRefresh').addEventListener('click', refresh);
  $('#logCat').addEventListener('change', refresh);
},

/* ---------- settings: system ---------- */
async settingsSystem() {
  const load = async () => {
    const [health, workers] = await Promise.all([api('/api/system/health'), api('/api/system/workers')]);
    main.innerHTML = `
    <div class="pageHead"><div><h1>System — Workers, Health & Jobs</h1><p class="sub">Queue status, service health, and retry controls.</p></div>
      <div class="row"><button class="btn ghost small" id="runChecks">Re-run health checks</button></div></div>
    <div class="card"><h2>Health</h2>
      ${health.items.map((i) => `<div class="row" style="padding:7px 0;border-bottom:1px solid var(--border)"><span class="dot ${i.ok ? 'ok' : 'bad'}"></span><b style="width:170px">${esc(i.name)}</b><span class="mono" style="color:var(--muted)">${esc(i.detail)}</span>${i.error ? `<span style="color:var(--bad)">${esc(i.error)}</span>` : ''}</div>`).join('')}
      <p class="hint">Checked ${esc(health.checkedAt)}. Each service reports why it is unavailable.</p></div>
    <div class="card" style="margin-top:16px"><h2>Queue</h2>
      <div class="row">
        <span class="pill">driver: ${esc(workers.queue.driver)}</span>
        <span class="pill">queued: ${workers.queue.queued}</span>
        <span class="pill">running: ${workers.queue.running}</span>
        <span class="pill">done: ${workers.queue.done}</span>
        <span class="pill" style="color:var(--bad)">failed: ${workers.queue.failed}</span>
      </div>
      <h2 style="margin-top:18px">Jobs</h2>
      <table><tr><th>Created</th><th>Type</th><th>Project</th><th>Status</th><th>Progress</th><th>Error</th><th></th></tr>
      ${workers.jobs.map((j) => `<tr>
        <td class="mono hint">${esc((j.created_at || '').slice(5, 16))}</td>
        <td>${esc(j.type)}</td>
        <td class="mono">${j.project_id ? `<a href="#/projects/${j.project_id}">${esc(j.project_id)}</a>` : '—'}</td>
        <td>${statusBadge(j.status)}</td>
        <td><div class="progress" style="width:110px"><i style="width:${j.progress}%"></i></div></td>
        <td class="hint mono">${esc(String(j.error || '').slice(0, 60))}</td>
        <td>${j.status === 'failed' ? `<button class="btn ghost small" data-retry="${j.id}">Retry</button>` : ''}</td>
      </tr>`).join('')}</table>
    </div>`;
    $('#runChecks').addEventListener('click', async () => { toast('Running checks…'); setTimeout(load, 600); });
    $$('button[data-retry]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/api/system/workers/${b.dataset.retry}/retry`, { method: 'POST' });
      toast('Job re-queued'); setTimeout(load, 400);
    }));
  };
  await load();
  poll(load, 5000);
},
};

/* ---------- clip card ---------- */
function clipCard(c) {
  return `<div class="clipCard ${c.status === 'selected' ? 'selected' : ''}" data-clip="${c.id}">
    <div class="row between">
      <b>Clip #${String(c.ord ?? 0).padStart(2, '0')}</b>
      ${statusBadge(c.status)}
      <span class="scoreRing" style="color:${scoreColor(c.overall)}">${c.overall != null ? Math.round(c.overall) : '?'}</span>
    </div>
    <p style="margin:8px 0 2px"><b>${esc(c.title || 'Untitled')}</b></p>
    ${c.hook ? `<p class="hint" style="margin:0 0 6px">“${esc(c.hook)}”</p>` : ''}
    <p class="clipMeta mono">${fmtTime(c.start)} → ${fmtTime(c.end)} · ${c.duration?.toFixed(0) ?? (c.end - c.start).toFixed(0)}s</p>
    ${c.reason ? `<p class="hint" style="margin:6px 0 0">${esc(c.reason)}</p>` : ''}
    <div class="row" style="margin-top:12px">
      <a class="btn ghost small" href="#/clips/${c.id}">Open</a>
      <button class="btn ghost small" data-pv="${c.id}">Preview</button>
      <button class="btn good small" data-rd="${c.id}">Render</button>
      <span style="flex:1"></span>
      <button class="btn ghost small" data-sel="${c.id}" data-on="${c.status === 'selected'}">${c.status === 'selected' ? '✓ Selected' : 'Select'}</button>
      <button class="btn ghost small" data-rejax="${c.id}">✗</button>
    </div></div>`;
}
function wireClipCards(scope) {
  $$('[data-pv]', scope).forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/api/clips/${b.dataset.pv}/preview`, { method: 'POST' }); toast('Preview job queued'); setTimeout(router, 2500); }
    catch (e) { toast(e.message, 'err'); }
  }));
  $$('[data-rd]', scope).forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/api/clips/${b.dataset.rd}/render`, { method: 'POST' }); toast('Final render queued'); setTimeout(router, 2500); }
    catch (e) { toast(e.message, 'err'); }
  }));
  $$('[data-sel]', scope).forEach((b) => b.addEventListener('click', async () => {
    try {
      const on = b.dataset.on === 'true';
      await api(`/api/clips/${b.dataset.sel}`, { method: 'PATCH', body: { status: on ? 'candidate' : 'selected' } });
      toast(on ? 'Deselected' : 'Selected'); setTimeout(router, 600);
    } catch (e) { toast(e.message, 'err'); }
  }));
  $$('[data-rejax]', scope).forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/api/clips/${b.dataset.rejax}/reject`, { method: 'POST' }); toast('Rejected'); setTimeout(router, 600); }
    catch (e) { toast(e.message, 'err'); }
  }));
}

/* ---------- boot ---------- */
buildNav();
$('#toast').classList.remove('hidden'); // container is empty
router();
