/** The scoped runtime the Chrome extension core hands this module at registration. */
let bound;
export function bind(runtime) {
  bound = runtime;
}
export function runtime() {
  if (!bound) throw new Error("Browser module is not registered");
  return bound;
}
export const settings = () => runtime().settings();
export const enqueueRecords = (records) => runtime().enqueue(records);
export const nextSequence = () => runtime().nextSequence();
export const hasRecord = (id) => runtime().hasRecord(id);
