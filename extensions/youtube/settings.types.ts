export interface YoutubeSettings {
  enabled?: boolean;
  captureSubtitles?: boolean;
  preferredLanguages?: string[];
  maxVideosPerRun?: number;
  llmModel?: string;
  namespace?: string;
}

export const YOUTUBE_DEFAULTS = {
  enabled: true, captureSubtitles: true, preferredLanguages: ["en"], maxVideosPerRun: 20,
  llmModel: "", namespace: "youtube",
};
