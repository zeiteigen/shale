export interface WebTask {
  id: string;
  label: string;
  status: "running" | "succeeded" | "failed";
  startedAt: number;
  finishedAt?: number;
  output?: string;
}

/** Manual operations finish independently of the HTTP request or browser tab. */
export class WebTasks {
  private tasks: WebTask[] = [];

  get busy() { return this.tasks.some(task => task.status === "running"); }
  list() { return this.tasks.map(task => ({ ...task })); }

  start(label: string, run: () => Promise<{ output?: string; success?: boolean }>): WebTask {
    if (this.busy) throw new Error("A manual operation is already running.");
    const task: WebTask = { id: crypto.randomUUID(), label, status: "running", startedAt: Date.now() };
    this.tasks = [task, ...this.tasks].slice(0, 50);
    void Promise.resolve().then(run).then(result => {
      task.status = result.success === false ? "failed" : "succeeded";
      task.output = result.output?.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 32_000);
    }).catch(error => {
      task.status = "failed";
      task.output = String(error instanceof Error ? error.message : error).slice(0, 32_000);
    }).finally(() => { task.finishedAt = Date.now(); });
    return { ...task };
  }
}
