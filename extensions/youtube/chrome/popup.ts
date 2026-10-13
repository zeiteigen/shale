import type { PopupApi } from "./types";

export function render(container: HTMLElement, popup: PopupApi) {
  const description = document.createElement("p");
  description.textContent = "Watched videos become sources. Full transcript summaries are added after 50% unique playback.";
  const status = document.createElement("p"), button = document.createElement("button");
  button.textContent = "Capture / retry current video";
  button.addEventListener("click", () => popup.act(async () => {
    const result = await popup.command("capture_current");
    if (!result.success) throw new Error(result.error ?? "Capture failed");
    popup.feedback(result.message);
  }));
  container.append(description, status, button);
  return { refresh(value: { title?: string; watchedPercent?: number; subtitles?: string; error?: string }) {
    status.textContent = [value.title, value.watchedPercent === undefined ? "Waiting for playback" : `${value.watchedPercent.toFixed(1)}% uniquely played`,
      value.subtitles, value.error].filter(Boolean).join(" · ");
  } };
}
