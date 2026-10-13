/** Popup section for the search queries module: the last captured search and a manual capture. */
import type { PopupApi } from "./types";

interface ModuleStatus {
  lastQuery?: string;
  lastEngine?: string;
  lastSearchAt?: number;
  visits?: number;
  error?: string;
  engines?: string[];
}

export function render(container: HTMLElement, popup: PopupApi) {
  container.innerHTML = `
    <section class="card">
      <div class="card-header">
        <span class="card-title">Search queries</span>
        <span class="badge badge-subtle" data-ref="engines"></span>
      </div>
      <p class="card-description">Each search becomes a source. Results you open from it are added as snippets, and Google's AI Overview is kept too.</p>
      <button data-ref="capture" class="btn btn-secondary btn-full"><span>Capture this search</span></button>
      <p class="setting-desc" data-ref="last"></p>
      <p class="module-notice" data-ref="error" hidden></p>
    </section>`;
  const ref = (name: string) => container.querySelector<HTMLElement>(`[data-ref="${name}"]`)!;
  ref("capture").addEventListener("click", () => popup.act(() => popup.command("capture_current")));
  return {
    refresh(_status: unknown, module?: { status?: ModuleStatus }) {
      const status = module?.status ?? {};
      ref("engines").textContent = (status.engines ?? []).join(" · ") || "No engines enabled";
      ref("last").textContent = status.lastQuery
        ? `Last search: “${status.lastQuery}” on ${status.lastEngine} at ${new Date(status.lastSearchAt ?? 0).toLocaleString()}. `
          + `${status.visits ?? 0} opened result(s) captured.`
        : "No searches captured yet.";
      ref("error").hidden = !status.error;
      ref("error").textContent = status.error ?? "";
    },
  };
}
