import { BasicTool } from "zotero-plugin-toolkit";
import Addon from "./addon";
import { config } from "../package.json";

// Plugin singleton install. INVARIANT: idempotent — only constructs the
// Addon if `Zotero[addonInstance]` is unset, which happens once per Zotero
// boot. WHY guard: the plugin can be re-loaded (DevTools `Reload Plugin`,
// install/upgrade) and we must not stack multiple Addon instances on the
// same Zotero global; only the first install wins until `onShutdown`
// deletes the entry.
//
// Side effect: defines `ztoolkit` and `addon` as globals readable from
// any module without an import — matches the zotero-plugin-template
// convention so utility files can use `ztoolkit.unregisterAll()` etc.

const basicTool = new BasicTool();

// @ts-expect-error - Plugin instance is not typed
if (!basicTool.getGlobal("Zotero")[config.addonInstance]) {
  _globalThis.addon = new Addon();
  defineGlobal("ztoolkit", () => {
    return _globalThis.addon.data.ztoolkit;
  });
  // @ts-expect-error - Plugin instance is not typed
  Zotero[config.addonInstance] = addon;
}

function defineGlobal(name: Parameters<BasicTool["getGlobal"]>[0]): void;
function defineGlobal(name: string, getter: () => any): void;
function defineGlobal(name: string, getter?: () => any) {
  Object.defineProperty(_globalThis, name, {
    get() {
      return getter ? getter() : basicTool.getGlobal(name);
    },
  });
}
