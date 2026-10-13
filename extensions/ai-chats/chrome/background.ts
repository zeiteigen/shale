/**
 * AI chats module for the Shale Chrome extension. Captures ChatGPT, Claude, and Gemini
 * conversations from the tabs where the user is signed in and sends them to the `ai-chats`
 * Shale extension:
 * - opening (or continuing) a conversation captures it after a short pause;
 * - a sync job walks ChatGPT's and Claude's conversation lists and fetches what changed;
 * - Gemini, which has no usable history API, is read from the open page.
 */
import {
  AI_CHATS_PROTOCOL_VERSION, MAX_AI_CHAT_RECORDS, PROVIDERS, PROVIDER_IDS, snapshotRecords, validateAiChatBatch,
  type AiChatMessage, type NormalizedConversation, type Provider,
} from "../contract";
import { pageFetch } from "./page-fetch";
import { API_PROVIDERS, LIST_PAGE_SIZE, conversationAt, hostPatterns, isApiProvider } from "./providers";
import type { ModuleDefinition, ModuleJob, ModuleRuntime } from "./types";

/** Let a reply finish streaming before capturing; re-armed by every navigation. */
const CAPTURE_DELAY_MS = 20_000;
/** An open, visible conversation is re-checked this often while the user keeps chatting. */
const RECAPTURE_MS = 3 * 60_000;
const RATE_LIMIT_PAUSE_MS = 5 * 60_000;
const DEFAULT_POLICY = { providers: PROVIDER_IDS as string[], autoSyncMinutes: 360, fetchDelayMs: 1500, maxConversationsPerSync: 1000 };
const PENDING_KEY = "module:ai-chats:pending";

interface Pending { provider: Provider; conversationId: string; dueAt: number }
interface ProviderStatus { lastCaptureAt?: number; lastTitle?: string; lastSyncAt?: number; error?: string }
interface SyncJob extends ModuleJob {
  provider: "chatgpt" | "claude";
  stage: "connect" | "list" | "fetch";
  openTab: boolean;
  tabId?: number;
  openedTab?: number;
  openedAt?: number;
  offset: number;
  since: number;
  newest: number;
  queue: string[];
  listDone: boolean;
  truncated: boolean;
  counts: { listed: number; changed: number; fetched: number; failed: number };
}

class FetchError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const label = (provider: Provider) => PROVIDERS[provider].label;

export default function register(runtime: ModuleRuntime): ModuleDefinition {
  const policy = async () => ({ ...DEFAULT_POLICY, ...(await runtime.policy()) });
  const providerEnabled = async (provider: Provider) => (await policy()).providers.includes(provider);

  async function setStatus(provider: Provider, patch: ProviderStatus) {
    const all = await runtime.storage.get<Record<string, ProviderStatus>>("status", {});
    await runtime.storage.set("status", { ...all, [provider]: { ...all[provider], ...patch } });
  }

  async function fetchApi(tabId: number, provider: "chatgpt" | "claude", path: string) {
    const result = await runtime.execInTab(tabId, pageFetch, [provider, path]);
    if (!result?.ok) throw new FetchError(result?.error ?? "The page returned nothing", result?.status ?? 0);
    return result.data;
  }

  /** Queue a conversation's snapshot records; unchanged content yields known ids and is skipped. */
  async function queueConversation(conversation: NormalizedConversation, captureMethod: "api" | "dom") {
    const times = conversation.messages.map(m => m.sentAt ?? 0);
    // Page captures never prune, so they need no ordering; API captures order by the site's update time.
    const revision = captureMethod === "api" ? conversation.updatedAt ?? Math.max(0, ...times) : 0;
    const records = await snapshotRecords(conversation, { captureMethod, revision });
    const fresh = [];
    for (const record of records) if (!(await runtime.hasRecord(record.recordId))) fresh.push(record);
    for (let i = 0; i < fresh.length; i += MAX_AI_CHAT_RECORDS) await runtime.enqueue(fresh.slice(i, i + MAX_AI_CHAT_RECORDS));
    return fresh.length;
  }

  async function readConversation(tabId: number, provider: Provider, conversationId: string) {
    if (isApiProvider(provider)) {
      const api = API_PROVIDERS[provider];
      return { conversation: api.normalize(await fetchApi(tabId, provider, api.conversationPath(conversationId)), conversationId),
        method: "api" as const };
    }
    const page = await runtime.inject<{ error?: string; conversationId: string; title: string; url: string;
      messages: AiChatMessage[] }>(tabId, "gemini-dom");
    if (!page || page.error) throw new Error(page?.error ?? "Could not read the Gemini page");
    return { conversation: { provider, conversationId: page.conversationId, title: page.title, url: page.url,
      messages: page.messages } satisfies NormalizedConversation, method: "dom" as const };
  }

  async function captureTab(tab: chrome.tabs.Tab) {
    const target = conversationAt(tab.url);
    if (!target || tab.id === undefined) return { success: false, skipped: true, reason: "This tab is not an AI chat conversation" };
    if (tab.incognito) return { success: false, skipped: true, reason: "Private browsing excluded" };
    if (!(await providerEnabled(target.provider)))
      return { success: false, skipped: true, reason: `${label(target.provider)} capture is turned off in ai-chats settings` };
    try {
      const { conversation, method } = await readConversation(tab.id, target.provider, target.conversationId);
      const queued = await queueConversation(conversation, method);
      await setStatus(target.provider, { lastCaptureAt: Date.now(), lastTitle: conversation.title, error: "" });
      return { success: true, queued: queued > 0, title: conversation.title, message: queued ? undefined : "Already up to date." };
    } catch (error) {
      await setStatus(target.provider, { error: (error as Error).message });
      throw error;
    }
  }

  // Captures wait out a short delay; the plan survives a service-worker restart in session storage.
  async function pending(): Promise<Record<string, Pending>> {
    const saved = await chrome.storage.session.get(PENDING_KEY);
    return (saved[PENDING_KEY] as Record<string, Pending> | undefined) ?? {};
  }
  async function schedule(tabId: number, url: string | undefined, delay = CAPTURE_DELAY_MS) {
    const target = conversationAt(url);
    const plan = await pending();
    if (target) plan[tabId] = { ...target, dueAt: Date.now() + delay };
    else delete plan[tabId];
    await chrome.storage.session.set({ [PENDING_KEY]: plan });
    if (target) setTimeout(() => capturePending().catch(error => runtime.log(error)), delay + 500);
  }
  let capturing: Promise<void> | undefined;
  function capturePending() {
    return (capturing ??= (async () => {
      const plan = await pending();
      for (const [tabId, entry] of Object.entries(plan)) {
        if (entry.dueAt > Date.now()) continue;
        delete plan[tabId];
        await chrome.storage.session.set({ [PENDING_KEY]: plan });
        let tab: chrome.tabs.Tab;
        try { tab = await chrome.tabs.get(Number(tabId)); } catch { continue; }
        const current = conversationAt(tab.url);
        if (current?.conversationId !== entry.conversationId) continue;
        try { await captureTab(tab); } catch (error) { runtime.log(`Capture failed for ${tab.url}:`, error); }
      }
      await runtime.deliver();
    })().finally(() => { capturing = undefined; }));
  }

  /** Visible conversations are re-checked while open; replies arrive without a navigation. */
  async function recaptureVisible() {
    const tabs = await chrome.tabs.query({ active: true, url: PROVIDER_IDS.flatMap(hostPatterns) });
    const seen = await runtime.storage.get<Record<string, number>>("recapturedAt", {});
    for (const tab of tabs.slice(0, 5)) {
      const target = conversationAt(tab.url);
      if (!target || tab.id === undefined || tab.incognito) continue;
      const key = `${target.provider}:${target.conversationId}`;
      if (Date.now() - (seen[key] ?? 0) < RECAPTURE_MS) continue;
      seen[key] = Date.now();
      await schedule(tab.id, tab.url, 0);
    }
    // Forget entries for conversations that are long closed.
    for (const [key, at] of Object.entries(seen)) if (Date.now() - at > 86_400_000) delete seen[key];
    await runtime.storage.set("recapturedAt", seen);
    await capturePending();
  }

  async function providerTab(provider: Provider) {
    return (await chrome.tabs.query({ url: hostPatterns(provider) })).find(tab => !tab.incognito && tab.id !== undefined);
  }

  async function startSync(provider: "chatgpt" | "claude", openTab: boolean) {
    const since = await runtime.storage.get<number>(`syncedThrough:${provider}`, 0);
    return runtime.createJob("sync", {
      provider, stage: "connect", openTab, offset: 0, since, newest: since, queue: [], listDone: false, truncated: false,
      counts: { listed: 0, changed: 0, fetched: 0, failed: 0 },
    });
  }

  async function autoSync() {
    const { autoSyncMinutes } = await policy();
    if (!(autoSyncMinutes > 0)) return;
    for (const provider of ["chatgpt", "claude"] as const) {
      if (!(await providerEnabled(provider)) || !(await providerTab(provider))) continue;
      const last = await runtime.storage.get<number>(`lastAutoSync:${provider}`, 0);
      if (Date.now() - last < autoSyncMinutes * 60_000) continue;
      await runtime.storage.set(`lastAutoSync:${provider}`, Date.now());
      await startSync(provider, false);
      await runtime.resume();
    }
  }

  async function closeOpenedTab(job: SyncJob) {
    if (job.openedTab === undefined) return;
    try { await chrome.tabs.remove(job.openedTab); } catch {}
    job.openedTab = undefined;
  }

  async function syncStep(job: SyncJob) {
    try {
      await advanceSync(job);
    } catch (error) {
      await closeOpenedTab(job);
      await setStatus(job.provider, { error: (error as Error).message });
      throw error;
    }
  }

  async function advanceSync(job: SyncJob) {
    const api = API_PROVIDERS[job.provider];
    if (!(await providerEnabled(job.provider))) throw new Error(`${label(job.provider)} capture is turned off in ai-chats settings`);
    if (job.stage !== "connect" && (job.tabId === undefined || !(await chrome.tabs.get(job.tabId).catch(() => undefined)))) {
      job.tabId = undefined;
      job.stage = "connect";
    }
    if (job.stage === "connect") {
      if (job.openedTab !== undefined) {
        const tab = await chrome.tabs.get(job.openedTab).catch(() => undefined);
        if (!tab) throw new Error(`The ${label(job.provider)} tab opened for syncing was closed`);
        if (tab.status !== "complete") {
          if (Date.now() - (job.openedAt ?? 0) > 60_000) throw new Error(`${api.home} did not finish loading`);
          await sleep(1000);
          return;
        }
        job.tabId = job.openedTab;
      } else {
        const tab = await providerTab(job.provider);
        if (tab) job.tabId = tab.id;
        else if (job.openTab) {
          const opened = await chrome.tabs.create({ url: api.home, active: false });
          job.openedTab = opened.id;
          job.openedAt = Date.now();
          return;
        } else {
          job.state = "completed";
          job.warnings = [`Open ${label(job.provider)} in a tab to sync.`];
          return;
        }
      }
      job.stage = job.listDone ? "fetch" : "list";
      return;
    }
    const { maxConversationsPerSync, fetchDelayMs } = await policy();
    if (job.stage === "list") {
      const { items, done } = api.parseList(
        await fetchApi(job.tabId!, job.provider, api.listPath(job.offset, LIST_PAGE_SIZE)), LIST_PAGE_SIZE);
      // An endpoint that ignores paging returns the same page again; nothing new ends the scan.
      const queued = new Set(job.queue);
      const repeated = items.length > 0 && items.every(item => queued.has(item.id));
      job.counts.listed += repeated ? 0 : items.length;
      job.offset += items.length;
      let reachedSynced = repeated;
      for (const item of repeated ? [] : items) {
        job.newest = Math.max(job.newest, item.updatedAt);
        // Lists are newest first, so the first already-synced conversation ends the scan.
        if (item.updatedAt <= job.since) { reachedSynced = true; break; }
        if (job.queue.length + job.counts.fetched >= maxConversationsPerSync) { job.truncated = true; break; }
        job.queue.push(item.id);
        job.counts.changed++;
      }
      if (done || reachedSynced || job.truncated || !items.length) {
        job.stage = "fetch";
        job.listDone = true;
      }
      return;
    }
    const id = job.queue[0];
    if (id === undefined) {
      if (!job.truncated) await runtime.storage.set(`syncedThrough:${job.provider}`, Math.max(job.since, job.newest));
      await closeOpenedTab(job);
      await setStatus(job.provider, { lastSyncAt: Date.now(), error: "" });
      job.state = "completed";
      return;
    }
    if (job.counts.fetched || job.counts.failed) await sleep(fetchDelayMs);
    try {
      const conversation = api.normalize(await fetchApi(job.tabId!, job.provider, api.conversationPath(id)), id);
      await queueConversation(conversation, "api");
      job.counts.fetched++;
      job.queue.shift();
      await runtime.deliver();
    } catch (error) {
      const status = error instanceof FetchError ? error.status : 0;
      if (status === 429) {
        job.yieldUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
        job.warnings = [`${label(job.provider)} is rate limiting requests; resuming in a few minutes.`];
        return;
      }
      if (status === 401 || status === 403) throw error;
      job.queue.shift();
      job.counts.failed++;
      job.warnings = [...job.warnings, `${id}: ${(error as Error).message}`].slice(-5);
    }
  }

  function summary(job: ModuleJob) {
    const sync = job as SyncJob;
    const c = sync.counts;
    const stage = sync.stage === "fetch" ? `${sync.queue.length} left to fetch` : sync.stage === "list" ? "listing conversations" : "connecting";
    return `${label(sync.provider)} sync ${sync.state}${sync.state === "running" ? ` (${stage})` : ""}: `
      + `${c.changed} changed of ${c.listed} listed, ${c.fetched} fetched, ${c.failed} failed. ${sync.error || sync.warnings.join(" ")}`;
  }

  return {
    id: "ai-chats",
    label: "AI chats",
    protocol: { batchType: "ai_chat_batch", version: AI_CHATS_PROTOCOL_VERSION, validate: validateAiChatBatch },
    claims: { hosts: PROVIDER_IDS.flatMap(provider => [...PROVIDERS[provider].hosts]) },
    wake: () => capturePending(),
    async status() {
      const saved = await runtime.storage.get<Record<string, ProviderStatus>>("status", {});
      const { providers } = await policy();
      return {
        providers: PROVIDER_IDS.map(id => ({
          id, label: label(id), enabled: providers.includes(id), api: isApiProvider(id), ...saved[id],
        })),
      };
    },
    listeners: {
      navigation(details) {
        if (details.frameId !== 0) return;
        return schedule(details.tabId, details.url);
      },
      tabComplete: (tabId, tab) => schedule(tabId, tab.url),
      async alarm() {
        await recaptureVisible();
        await autoSync();
      },
    },
    actions: {
      async capture_current() {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) throw new Error("No active tab");
        const result = await captureTab(tab);
        if (!result.success) throw new Error(result.reason);
        return result;
      },
      async sync(request) {
        const provider = request.provider as Provider;
        if (!isApiProvider(provider)) throw new Error("Only ChatGPT and Claude can sync their whole history");
        if (!(await providerEnabled(provider))) throw new Error(`${label(provider)} capture is turned off in ai-chats settings`);
        const job = await startSync(provider, true);
        return { success: true, jobId: job.id };
      },
      async resync(request) {
        const provider = request.provider as Provider;
        if (!isApiProvider(provider)) throw new Error("Only ChatGPT and Claude can sync their whole history");
        await runtime.storage.set(`syncedThrough:${provider}`, 0);
        const job = await startSync(provider, true);
        return { success: true, jobId: job.id };
      },
    },
    jobs: {
      sync: { step: job => syncStep(job as SyncJob), summary, stepsPerWake: 30 },
    },
  };
}
