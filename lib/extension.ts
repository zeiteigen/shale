export type CronExtension = {
  schedule: string;
  script: string;
};

export type ExtensionManifest = {
  name: string;
  version: string;
  description: string;
  setup_script?: string;
  subscribe_ingest?: string;
  crons?: CronExtension[];
};

export function isTExtensionManifest(obj: any): obj is ExtensionManifest {
  return (
    obj !== null &&
    typeof obj === "object" &&
    typeof (obj as any).name === "string" &&
    typeof (obj as any).version === "string" &&
    typeof (obj as any).description === "string" &&
    ((obj as any).setup_script === undefined ||
      typeof (obj as any).setup_script === "string") &&
    ((obj as any).subscribe_hook === undefined ||
      typeof (obj as any).subscribe_hook === "string") &&
    ((obj as any).crons === undefined ||
      (Array.isArray((obj as any).crons) &&
        ((obj as any).crons as any[]).every(
          (cron) =>
            cron !== null &&
            typeof cron === "object" &&
            typeof cron.schedule === "string" &&
            typeof cron.script === "string",
        )))
  );
}
