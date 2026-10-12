import { mkdir } from "node:fs/promises";
import { getSDK } from "@shale/sdk";
import { resolveDataPath } from "@shale/sdk/chat/paths";
import { emailSettings } from "./connector";

export async function run() {
  const settings = emailSettings(getSDK(import.meta.dir));
  const child = Bun.spawn([settings.pythonBin || "python3", "-c",
    "import sys, imaplib, email, mailbox; sys.exit(0 if sys.version_info >= (3, 10) else 1)"],
    { stdio: ["ignore", "ignore", "ignore"] });
  if (await child.exited !== 0) throw new Error("Email ingestion requires Python 3.10+ (configure pythonBin if needed).");
  await mkdir(resolveDataPath(settings.importDir!), { recursive: true });
  console.log("Email ingestion ready: Python standard library available; import folder created.");
}

if (import.meta.main) await run();
export default run;
