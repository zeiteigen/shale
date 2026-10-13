/** Accessed in MAIN world. Never return session context, signed URLs, or cookies to the host. */
export function currentPlayer(videoId: string): any {
  const player = document.querySelector("#movie_player") as any;
  const flexy = document.querySelector("ytd-watch-flexy") as any;
  const candidates = [player?.getPlayerResponse?.(), flexy?.playerData, (globalThis as any).ytInitialPlayerResponse];
  for (let value of candidates) {
    if (typeof value === "string") { try { value = JSON.parse(value); } catch { continue; } }
    if (value?.videoDetails?.videoId === videoId) return value;
  }
}

export function watchData(): any[] {
  const flexy = document.querySelector("ytd-watch-flexy") as any;
  return [flexy?.data, flexy?.data?.response, (globalThis as any).ytInitialData].filter(Boolean);
}
