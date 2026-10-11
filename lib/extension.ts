export type CronExtension = {
  name?: string;
  schedule: string;
  script: string;
  /** Run this cron once after the host has finished loading extensions. */
  run_on_startup?: boolean;
  extensionId?: string;
  namespace?: string;
};

export type ExtensionManifest = {
  name: string;
  version: string;
  description: string;
  namespace?: string;
  setup_script?: string;
  subscribe_ingest?: string;
  subscribe_messages?: string;
  checkpoint_recover?: string;
  /** Module exporting an AuthProvider (`auth` or default) for connecting accounts in the web UI. */
  auth_script?: string;
  /** One-time dependency installer run by `bun run setup` (e.g. a Python virtualenv). */
  install_script?: string;
  crons?: CronExtension[];
};

export function isTExtensionManifest(obj: any): obj is ExtensionManifest {
  return (
    obj !== null &&
    typeof obj === "object" &&
    typeof (obj as any).name === "string" &&
    typeof (obj as any).version === "string" &&
    typeof (obj as any).description === "string" &&
    ((obj as any).namespace === undefined ||
      typeof (obj as any).namespace === "string") &&
    ((obj as any).setup_script === undefined ||
      typeof (obj as any).setup_script === "string") &&
    ((obj as any).subscribe_ingest === undefined ||
      typeof (obj as any).subscribe_ingest === "string") &&
    ((obj as any).subscribe_messages === undefined ||
      typeof (obj as any).subscribe_messages === "string") &&
    ((obj as any).subscribe_hook === undefined ||
      typeof (obj as any).subscribe_hook === "string") &&
    ((obj as any).checkpoint_recover === undefined ||
      typeof (obj as any).checkpoint_recover === "string") &&
    ((obj as any).auth_script === undefined ||
      typeof (obj as any).auth_script === "string") &&
    ((obj as any).install_script === undefined ||
      typeof (obj as any).install_script === "string") &&
    ((obj as any).crons === undefined ||
      (Array.isArray((obj as any).crons) &&
        ((obj as any).crons as any[]).every(
          (cron) =>
            cron !== null &&
            typeof cron === "object" &&
            typeof cron.schedule === "string" &&
            typeof cron.script === "string" &&
            (cron.name === undefined || typeof cron.name === "string") &&
            (cron.run_on_startup === undefined ||
              typeof cron.run_on_startup === "boolean"),
        )))
  );
}
