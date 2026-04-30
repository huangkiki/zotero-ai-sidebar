import { initLocale } from './utils/locale';
import { createZToolkit } from './utils/ztoolkit';
import { registerSidebar, unregisterSidebar } from './modules/sidebar';

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  registerSidebar();

  await Promise.all(Zotero.getMainWindows().map((win) => onMainWindowLoad(win)));

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(`${addon.data.config.addonRef}-mainWindow.ftl`);
}

async function onMainWindowUnload(_win: Window): Promise<void> {
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  ztoolkit.unregisterAll();
  unregisterSidebar();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onNotify(
  _event: string,
  _type: string,
  _ids: Array<string | number>,
  _extraData: { [key: string]: unknown },
) {
  // No notifier subscriptions yet.
}

async function onPrefsEvent(_type: string, _data: { [key: string]: unknown }) {
  // Preference pane events handled via React inside the pane itself.
}

function onShortcuts(_type: string) {
  // No keyboard shortcuts registered.
}

function onDialogEvents(_type: string) {
  // No dialogs.
}

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
