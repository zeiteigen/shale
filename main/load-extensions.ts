import { Glob } from "bun";
import { join, dirname } from "node:path";
import {
  isTExtensionManifest,
  type ExtensionManifest,
  CronExtension,
} from "../lib/extension";
import { IngestMaterial } from "../lib/ingest.types";
import { createExtensionSDK, sdkStorage } from "../sdk";

export type IngestHook = import("./ingest-admission").IngestSubscriber & {
  func: (item: IngestMaterial) => Promise<void>;
  reciever_name: string;
};

export const extensionsDir = join(import.meta.dir, "../extensions");
const glob = new Glob("**/manifest.json");

const crons: CronExtension[] = [];
const subscribe_ingest: IngestHook[] = [];
const checkpointRecoverScripts = new Map<string, string>();
const extensionNamespaces = new Map<string, string>();

for await (const file of glob.scan(extensionsDir)) {
  try {
    const manifestPath = join(extensionsDir, file);
    const manifestFile = Bun.file(manifestPath);
    const manifest: ExtensionManifest = JSON.parse(await manifestFile.text());

    if (isTExtensionManifest(manifest)) {
      const extensionFolder = dirname(manifestPath);
      extensionNamespaces.set(manifest.name, manifest.namespace || manifest.name);

      if (manifest.checkpoint_recover) {
        checkpointRecoverScripts.set(
          manifest.name,
          join(extensionFolder, manifest.checkpoint_recover),
        );
      }

      if (manifest.setup_script) {
        try {
          const setupPath = join(extensionFolder, manifest.setup_script);
          const setupModule = await import(setupPath);
          const sdk = createExtensionSDK(
            manifest.name,
            manifest.namespace || manifest.name,
            undefined,
            undefined,
            undefined,
            manifest.name,
            extensionFolder,
          );
          await sdkStorage.run(sdk, async () => {
            if (setupModule) {
              if (typeof setupModule.setup === "function") {
                await setupModule.setup(sdk);
              } else if (typeof setupModule.default === "function") {
                await setupModule.default(sdk);
              } else if (typeof setupModule.init === "function") {
                await setupModule.init(sdk);
              }
            }
          });
        } catch (setupErr) {
          console.error(
            `Error executing setup_script for extension "${manifest.name}":`,
            setupErr,
          );
        }
      }

      if (manifest.subscribe_messages) {
        try {
          const msgPath = join(extensionFolder, manifest.subscribe_messages);
          const msgModule = await import(msgPath);
          const sdk = createExtensionSDK(
            manifest.name,
            manifest.namespace || manifest.name,
            undefined,
            undefined,
            undefined,
            manifest.name,
            extensionFolder,
          );
          await sdkStorage.run(sdk, async () => {
            if (msgModule) {
              if (typeof msgModule.registerMessages === "function") {
                await msgModule.registerMessages(sdk);
              } else if (typeof msgModule.setup === "function") {
                await msgModule.setup(sdk);
              } else if (typeof msgModule.default === "function") {
                await msgModule.default(sdk);
              } else if (typeof msgModule.init === "function") {
                await msgModule.init(sdk);
              }
            }
          });
        } catch (msgErr) {
          console.error(
            `Error executing subscribe_messages for extension "${manifest.name}":`,
            msgErr,
          );
        }
      }

      if (manifest.subscribe_ingest) {
        const entryPath = join(extensionFolder, manifest.subscribe_ingest);
        const entryModule = await import(entryPath);

        if (
          entryModule &&
          entryModule.subscribe &&
          typeof entryModule.subscribe === "function"
        ) {
          if (entryModule.init && typeof entryModule.init === "function") {
            await entryModule.init();
          }
          subscribe_ingest.push({
            func: entryModule.subscribe,
            reciever_name: manifest.name,
            accept: typeof entryModule.accept === "function" ? entryModule.accept : undefined,
            inspect: typeof entryModule.inspect === "function" ? entryModule.inspect : undefined,
            capabilities: typeof entryModule.capabilities === "function" ? entryModule.capabilities : undefined,
          });
        }
      }
      if (manifest.crons) {
        for (const cron of manifest.crons) {
          cron.script = join(extensionFolder, cron.script);
          cron.extensionId = manifest.name;
          cron.namespace = manifest.namespace || manifest.name;
          crons.push(cron);
        }
      }
    } else {
      console.warn(
        "Manifest file at",
        file,
        "was in the /extensions dir but isn't loaded because we failed to recognize it as a valid ParserManifest. Please check the manifest file for correctness.",
      );
    }
  } catch (err) {
    console.error("Error loading extension from file", file, ":", err);
  }
}

export function getCheckpointRecoverScript(
  extensionId: string,
): string | undefined {
  return checkpointRecoverScripts.get(extensionId);
}

export function registerCheckpointRecoverScript(
  extensionId: string,
  scriptPath: string,
): void {
  checkpointRecoverScripts.set(extensionId, scriptPath);
}

export { crons, subscribe_ingest, checkpointRecoverScripts, extensionNamespaces };
