// Script run cards the viewer closed (hidden-ids.ts). A running script hidden
// for longer than a week has outlived anyone's memory of hiding it.
import { hiddenIdStore } from "./hidden-ids";

const store = hiddenIdStore("opensession-hidden-script-runs");

export function hiddenScriptRunIds(now = Date.now()): Set<string> {
  return store.ids(now);
}

export function hideScriptRun(id: string, now = Date.now()): void {
  store.hide(id, now);
}
