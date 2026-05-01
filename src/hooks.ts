import { initLocale } from './utils/locale';
import { createZToolkit } from './utils/ztoolkit';
import {
  registerSidebar,
  registerSidebarForWindow,
  unregisterSidebar,
  unregisterSidebarForWindow,
} from './modules/sidebar';

// Plugin lifecycle hooks invoked by `addon/bootstrap.js`.
//
// INVARIANT on startup ordering (each promise gates the next safely):
//   1. initializationPromise — Zotero core data layer is ready (DB, items).
//   2. unlockPromise        — user-facing UI/data is unlocked (no master pw).
//   3. uiReadyPromise       — main window XUL tree exists; safe to inject.
// Skipping any of these crashes the plugin on cold start with "Zotero is
// not ready yet" because we touch DOM and item APIs immediately.
//
// REF: Zotero source `chrome/content/zotero/xpcom/zotero.js` for promise
//      contract; zotero-plugin-template README for hook signatures.
async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  // Per-window setup BEFORE the global `registerSidebar` so each window
  // has its FTL locale strings and ztoolkit ready by the time the column
  // renders. `registerSidebar` then iterates getMainWindows() again to
  // mount the column DOM in each — it's idempotent (see registerSidebarForWindow).
  await Promise.all(Zotero.getMainWindows().map((win) => onMainWindowLoad(win)));

  registerSidebar();

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(`${addon.data.config.addonRef}-addon.ftl`);
  win.MozXULElement.insertFTLIfNeeded(`${addon.data.config.addonRef}-mainWindow.ftl`);
  registerSidebarForWindow(win);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  unregisterSidebarForWindow(win);
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  ztoolkit.unregisterAll();
  unregisterSidebar();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

// All four hooks below are intentionally empty placeholders required by
// the bootstrap.js dispatch table. WHY keep them: `bootstrap.js` calls
// these unconditionally; removing them would throw on each event. Add
// real bodies here when the plugin starts subscribing to notifiers,
// pref changes, shortcuts, or dialogs.
async function onNotify(
  _event: string,
  _type: string,
  _ids: Array<string | number>,
  _extraData: { [key: string]: unknown },
) {}

async function onPrefsEvent(_type: string, _data: { [key: string]: unknown }) {}

function onShortcuts(_type: string) {}

function onDialogEvents(_type: string) {}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
  onDialogEvents,
};
