/**
 * Small read-only browser queue viewer.
 *
 * Run with: bun run scripts/browser-queue-viewer.ts
 * Then open: http://localhost:7426
 */
import { createExtensionSDK } from "../sdk";

const port = Number(process.env.SHALE_QUEUE_VIEWER_PORT) || 7426;
const sdk = createExtensionSDK("browser", "browser");

type QueueItem = {
  id?: string;
  receivedAt?: number;
  payload?: Record<string, unknown>;
};

function getQueue(): QueueItem[] {
  const row = sdk.database
    .query<{ value: string }, { $extension_id: string; $state_key: string }>(
      "SELECT value FROM extension_state WHERE extension_id = $extension_id AND state_key = $state_key",
    )
    .get({ $extension_id: "browser", $state_key: "pending-ingest" });
  if (!row?.value) return [];
  try {
    const queue = JSON.parse(row.value);
    return Array.isArray(queue) ? queue : [];
  } catch {
    return [];
  }
}

function queueResponse(): Response {
  const queue = getQueue();
  const counts = queue.reduce<Record<string, number>>((result, item) => {
    const type = String(item.payload?.type || "unknown");
    result[type] = (result[type] || 0) + 1;
    return result;
  }, {});
  return Response.json({
    queue,
    counts,
    generatedAt: Date.now(),
  });
}

const html = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Shale · Browser Queue</title>
  <style>
    :root { color-scheme: dark; --bg:#0b1020; --card:#151d31; --line:#2a3857; --text:#edf3ff; --muted:#9eacc7; --accent:#73a7ff; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif; }
    main { width:min(1100px,calc(100% - 32px)); margin:28px auto; }
    header { display:flex; gap:16px; justify-content:space-between; align-items:end; margin-bottom:18px; }
    h1 { margin:0; font-size:24px; } h1 span { color:var(--accent); }
    .subtitle,.muted { color:var(--muted); }
    .toolbar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-bottom:14px; }
    input { width:min(440px,100%); background:var(--card); border:1px solid var(--line); border-radius:7px; color:var(--text); padding:9px 11px; }
    button { border:1px solid var(--line); border-radius:7px; color:var(--text); background:var(--card); padding:8px 12px; cursor:pointer; }
    button:hover { border-color:var(--accent); } button:disabled { opacity:.6; cursor:wait; }
    .summary { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:16px; }
    .pill { border:1px solid var(--line); border-radius:999px; padding:5px 10px; color:var(--muted); background:#11192b; }
    .pill strong { color:var(--text); }
    #queue { display:grid; gap:10px; }
    details { background:var(--card); border:1px solid var(--line); border-radius:9px; overflow:hidden; }
    summary { display:flex; gap:10px; justify-content:space-between; align-items:center; cursor:pointer; padding:12px 14px; list-style:none; }
    summary::-webkit-details-marker { display:none; }
    .type { color:var(--accent); font-weight:650; } .time { color:var(--muted); font-size:12px; }
    pre { margin:0; border-top:1px solid var(--line); padding:14px; max-height:420px; overflow:auto; white-space:pre-wrap; word-break:break-word; color:#d4def3; }
    .empty { border:1px dashed var(--line); border-radius:9px; padding:30px; text-align:center; color:var(--muted); }
    footer { margin-top:16px; color:var(--muted); font-size:12px; }
  </style>
</head>
<body><main>
  <header><div><h1><span>SHALE</span> Browser Queue</h1><div class="subtitle">Read-only view of pending browser captures</div></div><div id="updated" class="time">Loading…</div></header>
  <div class="toolbar"><input id="filter" type="search" placeholder="Filter by type, URL, title, or payload…" autocomplete="off"><button id="refresh">Refresh</button><label class="muted"><input id="auto" type="checkbox" checked style="width:auto;vertical-align:middle"> Auto-refresh (5s)</label></div>
  <div id="summary" class="summary"></div><section id="queue" aria-live="polite"></section>
  <footer>The queue is drained by the browser extension cron. This page never changes it.</footer>
</main>
<script>
  const queue = document.querySelector('#queue'), summary = document.querySelector('#summary'), filter = document.querySelector('#filter'), updated = document.querySelector('#updated');
  let items = [];
  const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const formatTime = (time) => time ? new Date(time).toLocaleString() : 'Unknown time';
  function render() {
    const query = filter.value.trim().toLowerCase();
    const visible = items.filter((item) => !query || JSON.stringify(item).toLowerCase().includes(query));
    const counts = items.reduce((out, item) => { const type = item.payload?.type || 'unknown'; out[type] = (out[type] || 0) + 1; return out; }, {});
    summary.innerHTML = '<span class="pill"><strong>' + items.length + '</strong> pending item' + (items.length === 1 ? '' : 's') + '</span>' + Object.entries(counts).map(([type, count]) => '<span class="pill">' + esc(type) + ': <strong>' + count + '</strong></span>').join('');
    if (!visible.length) { queue.innerHTML = '<div class="empty">' + (items.length ? 'No queue items match this filter.' : 'The browser queue is empty.') + '</div>'; return; }
    queue.innerHTML = visible.map((item, index) => { const payload = item.payload || {}; const type = payload.type || 'unknown'; return '<details><summary><span><span class="type">' + esc(type) + '</span> <span class="muted">' + esc(item.id || ('item-' + index)) + '</span></span><span class="time">' + esc(formatTime(item.receivedAt)) + '</span></summary><pre>' + esc(JSON.stringify(item, null, 2)) + '</pre></details>'; }).join('');
  }
  async function refresh() { try { const response = await fetch('/api/queue', { cache:'no-store' }); if (!response.ok) throw new Error('HTTP ' + response.status); const data = await response.json(); items = data.queue || []; updated.textContent = 'Updated ' + new Date(data.generatedAt).toLocaleTimeString(); render(); } catch (error) { updated.textContent = 'Error: ' + error.message; queue.innerHTML = '<div class="empty">Could not read the queue. Is Shale running?</div>'; } }
  filter.addEventListener('input', render); document.querySelector('#refresh').addEventListener('click', refresh); setInterval(() => { if (document.querySelector('#auto').checked) refresh(); }, 5000); refresh();
</script></body></html>`;

if (import.meta.main) {
  Bun.serve({
    port,
    routes: {
      "/": () => new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
      "/api/queue": () => queueResponse(),
    },
  });
  console.log(`Shale browser queue viewer: http://localhost:${port}`);
}

