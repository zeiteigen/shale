/** Popup section for the browser module: library import, live capture, and privacy settings. */
const social = [
  "x.com",
  "twitter.com",
  "reddit.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "linkedin.com",
  "youtube.com",
];
const TEMPLATE = `
  <section data-ref="onboarding" class="card onboarding-card hidden">
    <div class="onboarding-content"><div class="onboarding-header">
      <div><h3>Ready for your first sync</h3>
      <p>Choose exactly what Shale should import in the Browser library section below.</p></div>
    </div></div>
  </section>
  <section class="card import-card">
    <div class="card-header">
      <span class="card-title">Import browser library</span>
      <span class="badge badge-subtle">Choose data</span>
    </div>
    <p class="card-description">Open tabs include readable text, HTML, links, and image references. History and bookmarks only expose URL/title records through Chrome.</p>
    <div class="import-options">
      <label class="checkbox-row"><input type="checkbox" data-ref="importTabs" checked>
        <span><strong>Open tabs</strong><small>Full page content from every window</small></span></label>
      <label class="checkbox-row"><input type="checkbox" data-ref="importBookmarks" checked>
        <span><strong>Bookmarks</strong><small>URLs, titles, folders, and dates</small></span></label>
      <div class="history-option-row">
        <label class="checkbox-row"><input type="checkbox" data-ref="importHistory" checked>
          <span><strong>History</strong><small>URLs, titles, visits, and counts</small></span></label>
        <select data-ref="historyRange" class="select-input">
          <option value="24h">Last 24 Hours</option>
          <option value="7d" selected>Last 7 Days</option>
          <option value="30d">Last 30 Days</option>
          <option value="90d">Last 90 Days</option>
          <option value="all">All available aggregate history</option>
        </select>
      </div>
    </div>
    <label class="checkbox-row"><input type="checkbox" data-ref="historyVisits"><span>Backfill individual visits (up to 500 per URL)</span></label>
    <button data-ref="startImport" class="btn btn-primary btn-full mt-2"><span>Import selected data</span></button>
    <div class="import-actions mt-1">
      <button data-ref="resetSync" class="btn-link" title="Reset state to test initial onboarding again">Show first-sync message again</button>
    </div>
  </section>
  <section class="card session-card">
    <div class="card-header"><span class="card-title">Capture status</span><span class="badge">Live tracking</span></div>
    <div class="session-info">
      <div class="info-row"><span class="label">Collector:</span><span data-ref="collector" class="val code">-</span></div>
      <div class="stats-row">
        <div class="stat-box"><span data-ref="waiting" class="stat-number">0</span><span class="stat-label">Waiting to send</span></div>
        <div class="stat-box"><span data-ref="received" class="stat-number">0</span><span class="stat-label">Received by server</span></div>
      </div>
    </div>
    <div class="form-group mt-2">
      <label for="browserGoal" class="field-label">Researching</label>
      <div class="input-with-button">
        <input id="browserGoal" data-ref="goal" class="text-input" maxlength="300" placeholder="Optional goal for new activity">
        <button data-ref="saveGoal" class="btn btn-sm">Save goal</button>
      </div>
    </div>
  </section>
  <section class="card">
    <div class="card-header"><span class="card-title">Capture now</span></div>
    <div class="action-grid">
      <button data-action="ingest_current_tab" class="btn btn-primary"><span>Capture this page</span></button>
      <button data-action="ingest_all_tabs" class="btn btn-secondary"><span>Capture open tabs</span></button>
      <button data-action="sync_history" class="btn btn-secondary"><span>Sync history (24h)</span></button>
      <button data-action="sync_bookmarks" class="btn btn-secondary"><span>Sync bookmarks</span></button>
    </div>
  </section>
  <details class="card settings-card">
    <summary>Browser privacy</summary>
    <div class="setting-item toggle-row">
      <label for="browserAutoSync" class="toggle-label"><span class="setting-name">Live active page sync</span>
        <span class="setting-desc">Capture navigation and attention; private pages are excluded</span></label>
      <input type="checkbox" id="browserAutoSync" data-ref="autoSync" class="toggle-input">
    </div>
    <div class="setting-item toggle-row">
      <label for="browserSocial" class="toggle-label"><span class="setting-name">Exclude social media</span>
        <span class="setting-desc">Filter X, Reddit, Instagram, etc.</span></label>
      <input type="checkbox" id="browserSocial" data-ref="social" class="toggle-input">
    </div>
    <div class="setting-item form-group">
      <label for="browserExclusions" class="field-label">Custom excluded domains (one per line)</label>
      <textarea id="browserExclusions" data-ref="exclusions" class="textarea-input" rows="2" placeholder="mail.google.com&#10;reddit.com"></textarea>
      <button data-ref="saveExclusions" class="btn btn-sm btn-full mt-1">Update exclusions</button>
    </div>
  </details>`;

export function render(container, popup) {
  container.innerHTML = TEMPLATE;
  const ref = (name) => container.querySelector(`[data-ref="${name}"]`);
  for (const button of container.querySelectorAll("[data-action]"))
    button.addEventListener("click", () =>
      popup.act(() => popup.command(button.dataset.action)),
    );
  ref("resetSync").addEventListener("click", () =>
    popup.act(() => popup.command("reset_sync_state")),
  );
  ref("startImport").addEventListener("click", () =>
    popup.act(() =>
      popup.command("run_full_import", {
        options: {
          importTabs: ref("importTabs").checked,
          importBookmarks: ref("importBookmarks").checked,
          importHistory: ref("importHistory").checked,
          historyRange: ref("historyRange").value,
          includeHistoryVisits: ref("historyVisits").checked,
        },
      }),
    ),
  );
  ref("autoSync").addEventListener("change", () =>
    popup.act(() =>
      chrome.storage.local.set({ autoSyncActive: ref("autoSync").checked }),
    ),
  );
  ref("social").addEventListener("change", () =>
    popup.act(async () => {
      const { excludeDomains = [] } =
        await chrome.storage.local.get("excludeDomains");
      const enabled = ref("social").checked;
      const domains = enabled
        ? [...new Set([...excludeDomains, ...social])]
        : excludeDomains.filter((d) => !social.includes(d));
      await chrome.storage.local.set({
        excludeDomains: domains,
        excludeSocialMedia: enabled,
      });
      ref("exclusions").value = domains.join("\n");
    }),
  );
  ref("saveGoal").addEventListener("click", () =>
    popup.act(() =>
      chrome.storage.local.set({ currentGoal: ref("goal").value.trim() }),
    ),
  );
  ref("saveExclusions").addEventListener("click", () =>
    popup.act(() =>
      chrome.storage.local.set({
        excludeDomains: ref("exclusions")
          .value.split("\n")
          .map((d) => d.trim().toLowerCase())
          .filter(Boolean),
      }),
    ),
  );
  let loaded = false;
  return {
    refresh(status) {
      const counts = status.outbox.counts;
      if (!loaded) {
        ref("exclusions").value = (status.excludeDomains || []).join("\n");
        ref("autoSync").checked = status.autoSyncActive;
        ref("social").checked = status.excludeSocialMedia;
        ref("goal").value = status.currentGoal || "";
        loaded = true;
      }
      ref("collector").textContent = status.collectorId.slice(0, 16);
      ref("waiting").textContent = counts.pending || 0;
      ref("received").textContent =
        (status.totalIngestedCount || 0) + status.outbox.sentCount;
      ref("onboarding").classList.toggle(
        "hidden",
        !!status.initialSyncCompleted,
      );
    },
  };
}
