import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from '../ui/App';

let registeredId: string | false | null = null;
const roots = new WeakMap<Element, Root>();

function renderInto(body: HTMLElement, itemID: number | null) {
  const mount = body.querySelector('#zai-root') as HTMLElement | null;
  if (!mount) return;
  let root = roots.get(mount);
  if (!root) {
    root = createRoot(mount);
    roots.set(mount, root);
  }
  root.render(React.createElement(App, { itemID }));
}

const BODY_XHTML =
  '<html:link rel="stylesheet" href="chrome://zotero-ai-sidebar/content/sidebar.css" />' +
  '<html:div id="zai-root" style="height:100%;display:flex;flex-direction:column"></html:div>';

export function registerSidebar() {
  registeredId = Zotero.ItemPaneManager.registerSection({
    paneID: 'zotero-ai-sidebar',
    pluginID: addon.data.config.addonID,
    header: {
      l10nID: `${addon.data.config.addonRef}-sidebar-header`,
      icon: 'chrome://zotero/skin/16/universal/book.svg',
    },
    sidenav: {
      l10nID: `${addon.data.config.addonRef}-sidebar-sidenav`,
      icon: 'chrome://zotero/skin/20/universal/book.svg',
    },
    bodyXHTML: BODY_XHTML,
    onRender: ({ body, item }) => {
      renderInto(body as HTMLElement, item ? item.id : null);
    },
    onItemChange: ({ body, item }) => {
      renderInto(body as HTMLElement, item ? item.id : null);
      return true;
    },
  });
}

export function unregisterSidebar() {
  if (registeredId) {
    Zotero.ItemPaneManager.unregisterSection(registeredId);
    registeredId = null;
  }
}
