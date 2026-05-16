import Uppy from '@uppy/core';
import Tus from '@uppy/tus';

// ── formatters ───────────────────────────────────────────────────────────────
const MIN = 60 * 1000;
const HR  = 60 * MIN;
const DAY = 24 * HR;

function formatBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const decimals = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return v.toFixed(decimals) + ' ' + units[i];
}
function formatBytesShort(n) {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return Math.round(v) + ' ' + units[i];
}
function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 0) {
    const ahead = -diff;
    if (ahead < HR)        return 'in ' + Math.max(1, Math.round(ahead / MIN)) + ' min';
    if (ahead < DAY)       return 'in ' + Math.round(ahead / HR) + ' hr';
    if (ahead < 30 * DAY)  return 'in ' + Math.round(ahead / DAY) + ' days';
    if (ahead < 365 * DAY) return 'in ' + Math.round(ahead / (30 * DAY)) + ' months';
    return 'in ' + Math.round(ahead / (365 * DAY)) + ' years';
  }
  if (diff < 45 * 1000) return 'just now';
  if (diff < HR)        return Math.round(diff / MIN) + ' min ago';
  if (diff < 2 * HR)    return '1 hour ago';
  if (diff < DAY)       return Math.round(diff / HR) + ' hours ago';
  if (diff < 2 * DAY)   return 'yesterday';
  if (diff < 7 * DAY)   return Math.round(diff / DAY) + ' days ago';
  if (diff < 30 * DAY) {
    const w = Math.round(diff / (7 * DAY));
    return w + (w === 1 ? ' week ago' : ' weeks ago');
  }
  if (diff < 60 * DAY)  return 'last month';
  if (diff < 365 * DAY) return Math.round(diff / (30 * DAY)) + ' months ago';
  return Math.round(diff / (365 * DAY)) + ' years ago';
}
function formatFullDate(ts) {
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}
function chipText(filename) {
  const parts = filename.toLowerCase().split('.');
  if (parts.length < 2) return 'FILE';
  const last = parts[parts.length - 1];
  const prev = parts[parts.length - 2];
  if ((last === 'gz' || last === 'bz2' || last === 'xz') && prev === 'tar') return 'TGZ';
  if (last.length <= 4) return last;
  return last.slice(0, 3);
}
function fileType(filename) {
  const parts = filename.toLowerCase().split('.');
  return parts.length < 2 ? '' : parts[parts.length - 1];
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── state ────────────────────────────────────────────────────────────────────
const root = document.getElementById('root');
const SHARE_ID = root.dataset.shareId;
const SHARE_NAME = root.dataset.shareName;

const state = {
  share: null,
  files: [],
  uploading: new Map(), // uppyFileId -> { id, name, size, uploaded, rate, state, error }
  freshIds: new Set(),
  pageDrag: false,
};

// ── refresh from server ──────────────────────────────────────────────────────
async function refresh() {
  try {
    const res = await fetch(`/${SHARE_ID}/files`, { cache: 'no-store' });
    if (!res.ok) throw new Error('refresh failed');
    const data = await res.json();
    state.share = data.share;
    state.files = data.files;
    render();
  } catch (e) {
    console.error('refresh failed', e);
  }
}

// ── render ───────────────────────────────────────────────────────────────────
function render() {
  if (!state.share) {
    root.innerHTML = '<div class="page"><div class="empty-list">Loading…</div></div>';
    return;
  }
  const share = state.share;
  const now = Date.now();
  const expired = share.expires_at && share.expires_at < now;
  const full = share.bytes_used >= share.max_size_bytes;
  const readOnly = expired || full;
  const usagePct = Math.min(100, (share.bytes_used / share.max_size_bytes) * 100);
  const usageClass = usagePct >= 95 ? 'full' : usagePct >= 75 ? 'warn' : '';

  const uploadingArr = Array.from(state.uploading.values());
  const filesCount = state.files.length;
  const compact = filesCount + uploadingArr.length > 0;

  const html = `
    <div class="drop-overlay${state.pageDrag && !readOnly ? ' show' : ''}">
      <div class="drop-overlay-card">Drop to add to this share</div>
    </div>
    <main class="page">
      <header class="share-header">
        <h1 class="share-name">${escapeHtml(share.name)}</h1>
      </header>

      ${expired ? `
        <div class="banner">
          <div class="banner-icon">!</div>
          <div>
            <div class="banner-title">This share expired ${escapeHtml(relativeTime(share.expires_at))}.</div>
            <div class="banner-body">Existing files are still downloadable. Ask the owner if you have more files to send.</div>
          </div>
        </div>` : ''}

      ${full && !expired ? `
        <div class="banner amber">
          <div class="banner-icon">!</div>
          <div>
            <div class="banner-title">This share is full.</div>
            <div class="banner-body">
              ${escapeHtml(formatBytes(share.bytes_used))} of ${escapeHtml(formatBytes(share.max_size_bytes))} used.
              Existing files remain available; new uploads are disabled until space is freed.
            </div>
          </div>
        </div>` : ''}

      ${!readOnly ? `
        <div class="dropzone${compact ? ' compact' : ''}" id="dropzone" role="button" tabindex="0">
          <div class="dropzone-glyph" aria-hidden="true"></div>
          <div class="dropzone-title" id="dropzone-title">Drop files to upload</div>
          <div class="dropzone-sub">or <button type="button" id="browse-btn">browse from your computer</button></div>
          ${!compact ? `
            <div class="dropzone-hint">
              <span><i class="hint-dot"></i>uploads start automatically</span>
              <span><i class="hint-dot"></i>resumes after disconnects</span>
              <span><i class="hint-dot"></i>files of any size</span>
            </div>` : ''}
          <input type="file" id="file-input" multiple hidden />
        </div>` : ''}

      <div class="usage-strip">
        <div class="usage-strip-row">
          <span title="${share.bytes_used.toLocaleString()} bytes">
            <strong>${escapeHtml(formatBytes(share.bytes_used))}</strong>
            <span class="usage-strip-of"> of ${escapeHtml(formatBytesShort(share.max_size_bytes))} used</span>
          </span>
          <span class="usage-strip-pct">${usagePct.toFixed(usagePct < 10 ? 1 : 0)}%</span>
        </div>
        <div class="usage-bar ${usageClass}"><i style="width:${usagePct}%"></i></div>
      </div>

      ${uploadingArr.length > 0 ? `
        <div class="section-head">
          <div class="section-title">Uploading <span class="count">${uploadingArr.length}</span></div>
          <div class="section-meta">resumable · auto-retry on disconnect</div>
        </div>
        <div class="uploading-list">
          ${uploadingArr.map(renderUploadingRow).join('')}
        </div>` : ''}

      <div class="section-head">
        <div class="section-title">Files <span class="count">${filesCount}</span></div>
        ${filesCount > 0 ? `<div class="section-meta">newest first · click a name to download</div>` : ''}
      </div>

      ${filesCount === 0
        ? `<div class="empty-list">No files uploaded yet</div>`
        : `<ul class="file-list">${state.files.map(renderFileRow).join('')}</ul>`}
    </main>
  `;
  root.innerHTML = html;

  // wire interactions
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  if (dropzone && fileInput) {
    dropzone.addEventListener('click', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      fileInput.click();
    });
    document.getElementById('browse-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput.click();
    });
    fileInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length) addFiles(files);
      e.target.value = '';
    });
  }
  // retry buttons
  for (const btn of root.querySelectorAll('.retry-btn')) {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      uppy.retryUpload(id).catch((e) => console.error('retry failed', e));
    });
  }
  // download links
  for (const a of root.querySelectorAll('.file-row')) {
    a.addEventListener('click', () => {
      state.freshIds.delete(a.dataset.id);
    });
  }
}

function renderUploadingRow(item) {
  const pct = Math.min(100, item.size > 0 ? (item.uploaded / item.size) * 100 : 0);
  let meta;
  if (item.state === 'error') {
    meta = 'Connection lost · will resume';
  } else if (item.state === 'paused') {
    meta = formatBytes(item.uploaded) + ' / ' + formatBytes(item.size) + ' · paused';
  } else if (pct >= 99.9) {
    meta = 'Finalizing…';
  } else if (item.rate > 0) {
    const remaining = item.size - item.uploaded;
    const eta = Math.ceil(remaining / item.rate);
    meta = formatBytes(item.uploaded) + ' / ' + formatBytes(item.size) +
      ' · ' + formatBytesShort(item.rate) + '/s' +
      (eta ? ' · ' + (eta >= 60 ? Math.ceil(eta / 60) + ' min' : eta + 's') + ' left' : '');
  } else {
    meta = formatBytes(item.uploaded) + ' / ' + formatBytes(item.size);
  }
  return `
    <div class="uploading-row" data-state="${item.state}">
      <div class="uploading-row-head">
        <div class="uploading-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
        <div class="uploading-meta">
          ${Math.round(pct)}%
          ${item.state === 'error' ? `<button class="retry-btn" data-id="${escapeHtml(item.id)}">retry</button>` : ''}
        </div>
      </div>
      <div class="uploading-bar"><i style="--p:${pct}%"></i></div>
      <div class="uploading-detail">${escapeHtml(meta)}</div>
    </div>
  `;
}

function renderFileRow(f) {
  const fresh = state.freshIds.has(f.id);
  const t = fileType(f.name);
  const href = `/${SHARE_ID}/files/${encodeURIComponent(f.id)}`;
  return `
    <li>
      <a class="file-row${fresh ? ' fresh' : ''}" href="${href}" download="${escapeHtml(f.name)}" data-id="${escapeHtml(f.id)}">
        <span class="file-chip" data-type="${escapeHtml(t)}">${escapeHtml(chipText(f.name))}</span>
        <span class="file-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
        <span class="file-size">${escapeHtml(formatBytes(f.size_bytes))}</span>
        <span class="file-time" title="${escapeHtml(formatFullDate(f.uploaded_at))}">${escapeHtml(relativeTime(f.uploaded_at))}</span>
        <span class="file-action" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none">
            <path d="M8 2.5v8m0 0L4.5 7m3.5 3.5L11.5 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M2.5 12.5v.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          </svg>
        </span>
      </a>
    </li>
  `;
}

// ── Uppy ─────────────────────────────────────────────────────────────────────
const uppy = new Uppy({
  autoProceed: true,
  allowMultipleUploadBatches: true,
  meta: { shareId: SHARE_ID },
});
uppy.use(Tus, {
  endpoint: '/api/tus',
  retryDelays: [0, 1000, 3000, 5000, 10000, 20000],
  chunkSize: 16 * 1024 * 1024,
  removeFingerprintOnSuccess: true,
});

function addFiles(files) {
  for (const file of files) {
    try {
      uppy.addFile({
        name: file.name,
        type: file.type,
        data: file,
        meta: { shareId: SHARE_ID, filename: file.name },
      });
    } catch (err) {
      console.error('addFile failed', err);
    }
  }
}

uppy.on('file-added', (file) => {
  state.uploading.set(file.id, {
    id: file.id,
    name: file.name,
    size: file.size || 0,
    uploaded: 0,
    rate: 0,
    state: 'uploading',
    lastTick: Date.now(),
    lastBytes: 0,
  });
  render();
});
uppy.on('upload-progress', (file, progress) => {
  const item = state.uploading.get(file.id);
  if (!item) return;
  const uploaded = progress.bytesUploaded || 0;
  const now = Date.now();
  const dt = (now - item.lastTick) / 1000;
  if (dt > 0.4) {
    const rate = (uploaded - item.lastBytes) / dt;
    item.rate = Math.max(0, rate);
    item.lastTick = now;
    item.lastBytes = uploaded;
  }
  item.uploaded = uploaded;
  item.state = 'uploading';
  render();
});
uppy.on('upload-success', (file) => {
  state.uploading.delete(file.id);
  state.freshIds.add(file.id); // will not match server file ID but harmless
  refresh();
});
uppy.on('upload-error', (file, err) => {
  const item = state.uploading.get(file.id);
  if (item) {
    item.state = 'error';
    item.rate = 0;
    item.error = err?.message || String(err);
    render();
  }
});
uppy.on('upload-retry', (fileId) => {
  const item = state.uploading.get(fileId);
  if (item) {
    item.state = 'uploading';
    item.error = null;
    render();
  }
});
uppy.on('error', (err) => {
  console.error('uppy error', err);
});

// ── window-level drag-and-drop ───────────────────────────────────────────────
{
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    depth++;
    if (depth === 1) { state.pageDrag = true; render(); }
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) { state.pageDrag = false; render(); }
  });
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    state.pageDrag = false;
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length) addFiles(files);
    render();
  });
}

// ── live timestamps tick every 30s ───────────────────────────────────────────
setInterval(() => {
  if (state.files.length > 0 || state.uploading.size > 0) render();
}, 30 * 1000);

// ── follow prefers-color-scheme changes ──────────────────────────────────────
try {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', (e) => {
    document.documentElement.dataset.theme = e.matches ? 'dark' : 'light';
  });
} catch (e) {}

// ── boot ─────────────────────────────────────────────────────────────────────
render();
refresh();
