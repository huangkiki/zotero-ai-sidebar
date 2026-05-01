import { config } from "../../package.json";

let registeredPaneID: string | null = null;

export async function registerPreferences(): Promise<void> {
  if (registeredPaneID) return;
  registeredPaneID = await Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    id: `${config.addonRef}-prefs`,
    label: "AI 对话",
    src: `chrome://${config.addonRef}/content/preferences.xhtml`,
    image: `chrome://${config.addonRef}/content/icons/ai-chat.svg`,
  });
}

export function unregisterPreferences(): void {
  if (!registeredPaneID) return;
  Zotero.PreferencePanes.unregister(registeredPaneID);
  registeredPaneID = null;
}
