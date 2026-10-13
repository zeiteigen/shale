/** Popup section for the AI chats module: per-provider status, capture, and sync. */
import type { PopupApi } from "./types";

interface ProviderRow {
  id: string;
  label: string;
  enabled: boolean;
  api: boolean;
  lastCaptureAt?: number;
  lastTitle?: string;
  lastSyncAt?: number;
  error?: string;
}

const when = (time?: number) => (time ? new Date(time).toLocaleString() : "never");

export function render(container: HTMLElement, popup: PopupApi) {
  container.innerHTML = `
    <section class="card">
      <div class="card-header">
        <span class="card-title">AI chats</span>
        <span class="badge badge-subtle">ChatGPT · Claude · Gemini</span>
      </div>
      <p class="card-description">Conversations are captured when you open them in a signed-in tab. Sync fetches every changed ChatGPT or Claude conversation; Gemini is captured as you view it.</p>
      <button data-ref="capture" class="btn btn-primary btn-full"><span>Capture this chat</span></button>
      <div data-ref="providers"></div>
    </section>`;
  const ref = (name: string) => container.querySelector<HTMLElement>(`[data-ref="${name}"]`)!;
  ref("capture").addEventListener("click", () => popup.act(() => popup.command("capture_current")));
  return {
    refresh(_status: unknown, module?: { status?: { providers?: ProviderRow[] } }) {
      const rows = module?.status?.providers ?? [];
      ref("providers").replaceChildren(...rows.map(row => {
        const item = document.createElement("div");
        item.className = "setting-item";
        const name = document.createElement("strong");
        name.textContent = row.label;
        const detail = document.createElement("p");
        detail.className = "setting-desc";
        detail.textContent = !row.enabled ? "Turned off in the server's ai-chats settings."
          : `Last capture: ${when(row.lastCaptureAt)}${row.lastTitle ? ` (${row.lastTitle})` : ""}.`
            + (row.api ? ` Last full sync: ${when(row.lastSyncAt)}.` : "");
        item.append(name, detail);
        if (row.error && row.enabled) {
          const error = document.createElement("p");
          error.className = "module-notice";
          error.textContent = row.error;
          item.append(error);
        }
        if (row.api && row.enabled) {
          const sync = document.createElement("button");
          sync.className = "btn btn-sm btn-secondary";
          sync.textContent = `Sync ${row.label}`;
          sync.title = "Fetch conversations changed since the last sync; opens a background tab if none is open";
          sync.addEventListener("click", () => popup.act(() => popup.command("sync", { provider: row.id })));
          const resync = document.createElement("button");
          resync.className = "btn-link";
          resync.textContent = "Re-sync everything";
          resync.addEventListener("click", () => popup.act(() => popup.command("resync", { provider: row.id })));
          item.append(sync, resync);
        }
        return item;
      }));
    },
  };
}
