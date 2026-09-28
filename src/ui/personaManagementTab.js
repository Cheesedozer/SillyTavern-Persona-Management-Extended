import { setPersonaDescription } from "/scripts/personas.js";

import { t } from "../../../../../i18n.js";
import { PME } from "../core/constants.js";
import {
  getAdvancedModeEnabled,
  setAdvancedModeEnabled,
} from "../core/mode.js";
import { log, warn } from "../core/log.js";
import { isSillyBunny } from "../core/host.js";
import { createAdvancedApp } from "./advancedApp.js";

function getPersonaManagementRoot() {
  return document.getElementById("PersonaManagement");
}

function getDefaultBlock() {
  return document.getElementById("persona-management-block");
}

const PME_TITLE = "Persona Management Extended";
const PME_TITLE_CLASS = "pme-native-title";

let cachedNativeIconTitle = /** @type {string|null|undefined} */ (undefined);

function getPersonaManagementTitleSpan(container) {
  const span = container.querySelector("h3 > span:not(.pme-native-title)");
  return span instanceof HTMLSpanElement ? span : null;
}

function getPersonaManagementDrawerIcon() {
  const icon = document.querySelector(
    "#persona-management-button .drawer-icon"
  );
  if (!(icon instanceof HTMLElement)) return null;
  return icon;
}

/**
 * Swap the panel title / drawer tooltip while Advanced mode is on.
 *
 * NOTE: never remove or rewrite `data-i18n` here. SillyTavern's i18n MutationObserver
 * reacts to `data-i18n` attribute changes and throws when the attribute disappears.
 * Instead we hide the native title span and show our own next to it.
 */
function applyPersonaManagementTitle(container, advancedEnabled) {
  const titleSpan = getPersonaManagementTitleSpan(container);
  let pmeSpan = container.querySelector(`h3 > span.${PME_TITLE_CLASS}`);
  const icon = getPersonaManagementDrawerIcon();

  if (advancedEnabled) {
    if (titleSpan) {
      if (!pmeSpan) {
        pmeSpan = document.createElement("span");
        pmeSpan.className = PME_TITLE_CLASS;
        pmeSpan.textContent = PME_TITLE;
        titleSpan.after(pmeSpan);
      }
      titleSpan.classList.add("displayNone");
    }
    if (icon) {
      if (cachedNativeIconTitle === undefined)
        cachedNativeIconTitle = icon.getAttribute("title");
      icon.setAttribute("title", PME_TITLE);
    }
    return;
  }

  pmeSpan?.remove();
  titleSpan?.classList.remove("displayNone");
  if (icon && cachedNativeIconTitle !== undefined) {
    if (cachedNativeIconTitle === null) icon.removeAttribute("title");
    else icon.setAttribute("title", cachedNativeIconTitle);
    cachedNativeIconTitle = undefined;
  }
}

function getOrCreateAdvancedRoot(container) {
  let root = document.getElementById(PME.dom.rootId);
  if (root) return root;

  root = document.createElement("div");
  root.id = PME.dom.rootId;
  root.className = PME.dom.rootClass;
  root.setAttribute("data-pme", "root");
  container.appendChild(root);
  return root;
}

function ensureAdvancedToggle() {
  if (document.getElementById(PME.dom.advancedToggleId)) {
    return;
  }

  const restoreBtn = document.getElementById("personas_restore");
  const buttonBar = restoreBtn?.parentElement;

  if (!buttonBar) {
    // UI not ready yet
    return;
  }

  const label = document.createElement("label");
  label.className = "checkbox_label flexNoGap pme-advanced-toggle";
  label.title = "Switch between Normal and Advanced Persona Management UI";
  label.style.marginLeft = "10px";
  label.style.userSelect = "none";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = PME.dom.advancedToggleId;
  input.checked = getAdvancedModeEnabled();

  const text = document.createElement("span");
  text.textContent = t`Advanced`;

  label.appendChild(input);
  label.appendChild(text);
  buttonBar.appendChild(label);

  input.addEventListener("input", () => {
    setAdvancedModeEnabled(input.checked);
    applyMode();
  });

  log("Advanced mode toggle injected into Persona Management header");
}

let nativePersonaListObserver = /** @type {MutationObserver|null} */ (null);
let wasPersonaDrawerOpen = false;
let personaDrawerObserver = /** @type {MutationObserver|null} */ (null);
let app = /** @type {ReturnType<typeof createAdvancedApp>|null} */ (null);

function getOrCreateApp(root) {
  if (app) return app;
  app = createAdvancedApp(root);
  return app;
}

export function applyMode() {
  const container = getPersonaManagementRoot();
  if (!container) return;

  const advancedEnabled = getAdvancedModeEnabled();
  applyPersonaManagementTitle(container, advancedEnabled);

  // Drawer open/close state (so we can auto-scroll only when the UI is opened)
  const drawerOpen = !container.classList.contains("closedDrawer");
  const openingDrawerNow = drawerOpen && !wasPersonaDrawerOpen;
  wasPersonaDrawerOpen = drawerOpen;

  const defaultBlock = getDefaultBlock();
  if (defaultBlock) {
    defaultBlock.classList.toggle("displayNone", advancedEnabled);
  }

  // Host hooks for CSS: hide host-only chrome in Advanced mode, adopt SillyBunny card styling.
  container.classList.toggle("pme-advanced", advancedEnabled);

  const root = getOrCreateAdvancedRoot(container);
  root.classList.toggle("pme-host-sillybunny", isSillyBunny());
  const wasVisible = !root.classList.contains("displayNone");
  root.classList.toggle("displayNone", !advancedEnabled);

  if (advancedEnabled) {
    const autoScroll = !wasVisible || openingDrawerNow;
    getOrCreateApp(root).open({ autoScroll });
  } else {
    // Put back native blocks and clean up our UI when returning to Normal mode
    try {
      app?.destroy();
    } finally {
      app = null;
    }

    // When going back to Normal mode, sync native UI from power_user
    try {
      setPersonaDescription();
    } catch {
      // ignore
    }
  }
}

export function ensurePersonaManagementUI() {
  const container = getPersonaManagementRoot();
  if (!container) {
    return false;
  }

  // Track drawer open/close so auto-scroll happens only on open.
  // This also fixes the case when the drawer is closed and reopened without our code running in-between.
  if (!personaDrawerObserver) {
    personaDrawerObserver = new MutationObserver(() => {
      const drawerOpen = !container.classList.contains("closedDrawer");
      const openedNow = drawerOpen && !wasPersonaDrawerOpen;
      wasPersonaDrawerOpen = drawerOpen;

      if (openedNow && getAdvancedModeEnabled()) {
        const root = document.getElementById(PME.dom.rootId);
        if (!(root instanceof HTMLElement)) return;
        if (root.classList.contains("displayNone")) return;
        getOrCreateApp(root).open({ autoScroll: true });
      }
    });
    personaDrawerObserver.observe(container, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  ensureAdvancedToggle();
  getOrCreateAdvancedRoot(container);

  // Observe native persona list updates and mirror them
  if (!nativePersonaListObserver) {
    const nativeList = document.getElementById("user_avatar_block");
    if (nativeList) {
      nativePersonaListObserver = new MutationObserver(() => {
        if (!getAdvancedModeEnabled()) return;
        const root = document.getElementById(PME.dom.rootId);
        if (!(root instanceof HTMLElement)) return;
        if (root.classList.contains("displayNone")) return;
        getOrCreateApp(root).refreshPersonas({ invalidateCache: true });
      });
      nativePersonaListObserver.observe(nativeList, {
        childList: true,
        subtree: true,
      });
    }
  }

  applyMode();

  return true;
}

export function refreshAdvancedUIIfVisible() {
  const root = document.getElementById(PME.dom.rootId);
  if (!root) return;
  if (root.classList.contains("displayNone")) return;

  try {
    getOrCreateApp(root).refreshAll();
  } catch (e) {
    warn("Failed to refresh advanced UI", e);
  }
}
