import {
  power_user,
  persona_description_positions,
} from "/scripts/power-user.js";
import { saveSettingsDebounced } from "/script.js";
import { getTokenCountAsync } from "/scripts/tokenizers.js";
import { getOrCreatePersonaDescriptor } from "/scripts/personas.js";
import { openWorldInfoEditor } from "/scripts/world-info.js";
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from "/scripts/popup.js";

import { el, setHidden } from "./dom.js";
import { borrowNative, returnAllNative } from "./nativeNodes.js";
import { UI_EVENTS } from "../uiBus.js";
import { t } from "../../../../../../i18n.js";

function clickNative(id) {
  const node = document.getElementById(id);
  if (node instanceof HTMLElement) node.click();
}

/**
 * Base (user-written) persona description of the current persona.
 *
 * NOTE: `power_user.persona_description` is NOT always the base text: SillyBunny composes it
 * as base + active "Scenario Notes". Editing that composed value would bake the notes into
 * the persona description, so edits always start from `descriptor.description`.
 */
function getBaseDescription() {
  const d = getOrCreatePersonaDescriptor();
  return String(d?.description ?? power_user.persona_description ?? "");
}

/**
 * Write a value through a native Persona Management control so the host's own
 * input handler runs (it updates power_user, the descriptor, token counts, and on
 * SillyBunny recomposes Scenario Notes).
 * @param {string} id
 * @param {string|number} value
 * @returns {boolean} false when the native control is missing
 */
function writeNative(id, value) {
  const node = document.getElementById(id);
  if (!node || typeof $ !== "function") return false;
  // eslint-disable-next-line no-undef
  $(node).val(String(value)).trigger("input");
  return true;
}

function makeIconButton(title, iconClass, onClick, { danger = false } = {}) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `menu_button menu_button_icon pme-icon-btn${
    danger ? " pme-danger" : ""
  }`;
  btn.title = title;
  btn.innerHTML = `<i class="fa-solid ${iconClass}"></i>`;
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick(e);
  });
  return btn;
}

export function createCurrentPersonaPanel({ getPersonaName, bus }) {
  const root = el("div", "pme-card pme-current");

  function getDescriptor() {
    return getOrCreatePersonaDescriptor();
  }

  /**
   * @param {any} d
   */
  function ensurePme(d) {
    d.pme ??= {};
    if (typeof d.pme !== "object") d.pme = {};
    // Default: keep legacy behavior (linked) unless explicitly turned off.
    if (typeof d.pme.linkedToNative !== "boolean") d.pme.linkedToNative = true;
    d.pme.local ??= {};
    if (typeof d.pme.local !== "object") d.pme.local = {};
    d.pme.local.description ??= "";
    d.pme.local.position ??= persona_description_positions.IN_PROMPT;
    d.pme.local.depth ??= 2;
    d.pme.local.role ??= 0;
  }

  function isLinked() {
    const d = getDescriptor();
    ensurePme(d);
    return d.pme.linkedToNative !== false;
  }

  function snapshotNativeToLocal() {
    const d = getDescriptor();
    ensurePme(d);
    d.pme.local.description = getBaseDescription();
    d.pme.local.position = Number(
      power_user.persona_description_position ??
        persona_description_positions.IN_PROMPT
    );
    d.pme.local.depth = Number(power_user.persona_description_depth ?? 2);
    d.pme.local.role = Number(power_user.persona_description_role ?? 0);
  }

  function applyLocalToNative() {
    const d = getDescriptor();
    ensurePme(d);

    setLinkedValue("description", String(d.pme.local.description ?? ""));
    setLinkedValue("position", Number(d.pme.local.position));
    setLinkedValue("depth", Number(d.pme.local.depth));
    setLinkedValue("role", Number(d.pme.local.role));

    bus?.emit(UI_EVENTS.PERSONA_DESC_CHANGED, {});
  }

  const LINKED_FIELDS = {
    description: {
      nativeId: "persona_description",
      powerKey: "persona_description",
      descKey: "description",
    },
    position: {
      nativeId: "persona_description_position",
      powerKey: "persona_description_position",
      descKey: "position",
    },
    depth: {
      nativeId: "persona_depth_value",
      powerKey: "persona_description_depth",
      descKey: "depth",
    },
    role: {
      nativeId: "persona_depth_role",
      powerKey: "persona_description_role",
      descKey: "role",
    },
  };

  /**
   * Update a field of the original (linked) persona.
   * Prefers the native control so the host's handler owns persistence; falls back to
   * writing power_user + descriptor directly if the control is missing.
   * @param {keyof typeof LINKED_FIELDS} field
   * @param {string|number} value
   */
  function setLinkedValue(field, value) {
    const f = LINKED_FIELDS[field];
    if (writeNative(f.nativeId, value)) return;
    const d = getDescriptor();
    power_user[f.powerKey] = value;
    d[f.descKey] = value;
    saveSettingsDebounced();
  }

  // Header
  const header = el("div", "pme-current-top");
  const titleEl = el("div", "pme-current-title", t`[Persona Name]`);
  const buttons = el("div", "pme-current-buttons");

  buttons.appendChild(
    makeIconButton(t`Rename Persona`, "fa-pencil", () => {
      clickNative("persona_rename_button");
      window.setTimeout(
        () => bus?.emit(UI_EVENTS.PERSONA_LIST_INVALIDATED, {}),
        150
      );
    })
  );
  buttons.appendChild(
    makeIconButton(t`Click to set user name for all messages`, "fa-sync", () =>
      clickNative("sync_name_button")
    )
  );

  let panelApi = /** @type {any} */ (null);

  buttons.appendChild(
    makeIconButton(
      t`Sync with original persona (toggle)`,
      "fa-lock",
      async () => {
        const d = getDescriptor();
        ensurePme(d);
        const linked = isLinked();

        // Turning OFF: detach and snapshot current native values into local storage.
        if (linked) {
          snapshotNativeToLocal();
          d.pme.linkedToNative = false;
          saveSettingsDebounced();
          panelApi?.update();
          return;
        }

        // Turning ON: ask which side becomes canonical.
        // Ensure local has something even if user never edited it.
        if (!d.pme.local?.description) snapshotNativeToLocal();

        const content = el("div", "");
        content.appendChild(
          el(
            "div",
            "",
            t`Enable sync with the original persona?\n\nChoose which data should be treated as the source of truth:`
          )
        );

        const result = await callGenericPopup(content, POPUP_TYPE.TEXT, "", {
          okButton: false,
          cancelButton: t`Cancel`,
          customButtons: [
            { text: t`Use original`, result: POPUP_RESULT.CUSTOM1 },
            { text: t`Use extended`, result: POPUP_RESULT.CUSTOM2 },
          ],
        });

        if (result === POPUP_RESULT.CANCELLED) return;

        if (result === POPUP_RESULT.CUSTOM1) {
          // Original wins: overwrite local to match native, then link.
          snapshotNativeToLocal();
          d.pme.linkedToNative = true;
          saveSettingsDebounced();
          panelApi?.update();
          return;
        }

        if (result === POPUP_RESULT.CUSTOM2) {
          // Extended wins: push local -> native, then link.
          d.pme.linkedToNative = true;
          applyLocalToNative();
          panelApi?.update();
        }
      }
    )
  );
  const linkBtn = /** @type {HTMLButtonElement} */ (buttons.lastElementChild);

  buttons.appendChild(
    makeIconButton(t`Persona Lore`, "fa-globe", (e) => {
      // Match native ST behavior: Alt+Click opens the selected lorebook itself.
      const selectedLorebook = String(
        power_user.persona_description_lorebook ?? ""
      ).trim();
      if (e?.altKey && selectedLorebook) {
        openWorldInfoEditor(selectedLorebook);
        return;
      }
      clickNative("persona_lore_button");
    })
  );
  const loreBtn = /** @type {HTMLButtonElement} */ (buttons.lastElementChild);
  buttons.appendChild(
    makeIconButton(t`Change Persona Image`, "fa-image", () => {
      clickNative("persona_set_image_button");
      window.setTimeout(
        () => bus?.emit(UI_EVENTS.PERSONA_LIST_INVALIDATED, {}),
        250
      );
    })
  );
  // SillyBunny-only: "Create character from persona"
  if (document.getElementById("persona_to_character_button")) {
    buttons.appendChild(
      makeIconButton(t`Create Character from Persona`, "fa-address-card", () => {
        clickNative("persona_to_character_button");
      })
    );
  }
  buttons.appendChild(
    makeIconButton(t`Duplicate Persona`, "fa-clone", () => {
      clickNative("persona_duplicate_button");
      window.setTimeout(
        () => bus?.emit(UI_EVENTS.PERSONA_LIST_INVALIDATED, {}),
        250
      );
    })
  );
  buttons.appendChild(
    makeIconButton(
      t`Delete Persona`,
      "fa-skull",
      () => {
        clickNative("persona_delete_button");
        window.setTimeout(
          () => bus?.emit(UI_EVENTS.PERSONA_LIST_INVALIDATED, {}),
          350
        );
      },
      { danger: true }
    )
  );

  header.appendChild(titleEl);
  header.appendChild(buttons);
  root.appendChild(header);

  // SillyBunny-only: persona lock status chips (borrowed from the native UI in update()).
  const chipsSlot = el("div", "pme-native-chips");
  root.appendChild(chipsSlot);

  // Description header
  const descHeader = el("div", "pme-section-header");
  descHeader.appendChild(el("div", "pme-section-title", t`Persona Description`));
  const maxBtn = document.createElement("i");
  maxBtn.className = "editor_maximize fa-solid fa-maximize right_menu_button";
  maxBtn.title = t`Expand the editor`;
  maxBtn.setAttribute("data-for", "pme_persona_description");
  descHeader.appendChild(maxBtn);
  root.appendChild(descHeader);

  const textarea = document.createElement("textarea");
  textarea.id = "pme_persona_description";
  textarea.className = "text_pole textarea_compact pme-current-textarea";
  textarea.rows = 8;
  textarea.placeholder = t`Example:\n[{{user}} is a 28-year-old Romanian cat girl.]`;
  textarea.autocomplete = "off";
  root.appendChild(textarea);

  // SillyBunny-only: "Scenario Notes" (persona appendices). They are part of the prompt
  // (composed into power_user.persona_description), so they must stay reachable in Advanced mode.
  const appendicesSlot = el("div", "pme-native-appendices");
  root.appendChild(appendicesSlot);

  function borrowSillyBunnyBlocks() {
    const chips = document.getElementById("persona_selected_chips");
    setHidden(chipsSlot, !borrowNative(chips, chipsSlot));
    const appendices = document.querySelector(".persona-appendices-block");
    setHidden(appendicesSlot, !borrowNative(appendices, appendicesSlot));
  }

  // Position + tokens header
  const posHeader = el("div", "pme-position-header");
  posHeader.appendChild(el("div", "pme-section-title", t`Position`));
  const tokenBox = el("div", "pme-token-box");
  tokenBox.appendChild(el("span", "", t`Tokens: `));
  const tokenCount = el("span", "pme-token-count", "0");
  tokenBox.appendChild(tokenCount);
  posHeader.appendChild(tokenBox);
  root.appendChild(posHeader);

  // Position row
  const posRow = el("div", "pme-position-row");

  const posSelect = document.createElement("select");
  posSelect.className = "pme-position-select";
  posSelect.innerHTML = `
    <option value="${persona_description_positions.NONE}">${t`None (disabled)`}</option>
    <option value="${persona_description_positions.IN_PROMPT}">${t`In Story String / Prompt Manager`}</option>
    <option value="${persona_description_positions.TOP_AN}">${t`Top of Author's Note`}</option>
    <option value="${persona_description_positions.BOTTOM_AN}">${t`Bottom of Author's Note`}</option>
    <option value="${persona_description_positions.AT_DEPTH}">${t`In-chat @ Depth`}</option>
  `;
  posRow.appendChild(posSelect);

  const depthWrap = el("div", "pme-depth-wrap");
  const depthLabel = el("label", "pme-depth-label", t`Depth:`);
  const depthInput = document.createElement("input");
  depthInput.type = "number";
  depthInput.min = "0";
  depthInput.max = "9999";
  depthInput.step = "1";
  depthInput.className = "text_pole pme-depth-input";
  depthLabel.appendChild(depthInput);
  depthWrap.appendChild(depthLabel);

  const roleLabel = el("label", "pme-depth-label", t`Role:`);
  const roleSelect = document.createElement("select");
  roleSelect.className = "text_pole pme-role-select";
  roleSelect.innerHTML = `
    <option value="0">${t`System`}</option>
    <option value="1">${t`User`}</option>
    <option value="2">${t`Assistant`}</option>
  `;
  roleLabel.appendChild(roleSelect);
  depthWrap.appendChild(roleLabel);

  posRow.appendChild(depthWrap);
  root.appendChild(posRow);

  function updateDepthVisibility() {
    const v = Number(posSelect.value);
    setHidden(depthWrap, v !== persona_description_positions.AT_DEPTH);
  }

  function syncLinkButtonState() {
    const linked = isLinked();
    linkBtn?.classList.toggle("world_set", linked);
    const icon = linkBtn?.querySelector("i");
    if (icon)
      icon.className = `fa-solid ${linked ? "fa-lock" : "fa-lock-open"}`;
    linkBtn.title = linked
      ? t`Sync with original persona: ON`
      : t`Sync with original persona: OFF (editing extended version separately)`;
  }

  function syncLorebookState() {
    // Match SillyTavern native behavior: `#persona_lore_button` toggles `.world_set`.
    // `.world_set` is styled in ST as "active/green".
    const hasLorebook = !!String(
      power_user.persona_description_lorebook ?? ""
    ).trim();
    loreBtn?.classList.toggle("world_set", hasLorebook);
  }

  // Token counting (debounced)
  let tokenTimer = /** @type {number|undefined} */ (undefined);
  const refreshTokens = () => {
    if (tokenTimer) window.clearTimeout(tokenTimer);
    tokenTimer = window.setTimeout(async () => {
      try {
        const count = await getTokenCountAsync(String(textarea.value ?? ""));
        tokenCount.textContent = String(count);
      } catch {
        tokenCount.textContent = "0";
      }
    }, 250);
  };

  // Inputs -> ST model
  let lastDescValue = "";
  const onDescInput = () => {
    const next = String(textarea.value ?? "");
    if (next === lastDescValue) return;
    lastDescValue = next;

    const d = getDescriptor();
    ensurePme(d);

    if (isLinked()) {
      setLinkedValue("description", next);
    } else {
      d.pme.local.description = next;
      saveSettingsDebounced();
    }
    refreshTokens();
    bus?.emit(UI_EVENTS.PERSONA_DESC_CHANGED, {});
  };

  textarea.addEventListener("input", onDescInput);
  try {
    // ST "Expand editor" uses jQuery `.trigger('input')` on the original element.
    // Native listener is not guaranteed to receive that trigger, so we bind both.
    // eslint-disable-next-line no-undef
    if (typeof $ === "function") $(textarea).on("input", onDescInput);
  } catch {
    // ignore
  }

  posSelect.addEventListener("input", () => {
    const d = getDescriptor();
    ensurePme(d);
    if (isLinked()) {
      setLinkedValue("position", Number(posSelect.value));
    } else {
      d.pme.local.position = Number(posSelect.value);
      saveSettingsDebounced();
    }
    updateDepthVisibility();
  });

  depthInput.addEventListener("input", () => {
    const d = getDescriptor();
    ensurePme(d);
    if (isLinked()) {
      setLinkedValue("depth", Number(depthInput.value));
    } else {
      d.pme.local.depth = Number(depthInput.value);
      saveSettingsDebounced();
    }
  });

  roleSelect.addEventListener("input", () => {
    const d = getDescriptor();
    ensurePme(d);
    if (isLinked()) {
      setLinkedValue("role", Number(roleSelect.value));
    } else {
      d.pme.local.role = Number(roleSelect.value);
      saveSettingsDebounced();
    }
  });

  // After opening the native lorebook picker, re-check selection (it may change asynchronously).
  loreBtn?.addEventListener("click", () => {
    window.setTimeout(syncLorebookState, 250);
    window.setTimeout(syncLorebookState, 800);
  });

  panelApi = {
    el: root,
    mount() {
      this.update();
    },
    destroy() {
      returnAllNative();
    },
    update() {
      borrowSillyBunnyBlocks();
      // Update header title
      titleEl.textContent = String(getPersonaName?.() ?? t`[Persona Name]`);

      const d = getDescriptor();
      ensurePme(d);
      const linked = isLinked();
      syncLinkButtonState();

      // Update inputs from selected source (native or local)
      textarea.value = linked
        ? getBaseDescription()
        : String(d.pme.local.description ?? "");
      lastDescValue = textarea.value;

      const currentPos = linked
        ? Number(
            power_user.persona_description_position ??
              persona_description_positions.IN_PROMPT
          )
        : Number(
            d.pme.local.position ?? persona_description_positions.IN_PROMPT
          );
      posSelect.value = String(currentPos);

      depthInput.value = String(
        linked
          ? Number(power_user.persona_description_depth ?? 2)
          : Number(d.pme.local.depth ?? 2)
      );
      roleSelect.value = String(
        linked
          ? Number(power_user.persona_description_role ?? 0)
          : Number(d.pme.local.role ?? 0)
      );
      updateDepthVisibility();
      refreshTokens();
      syncLorebookState();
    },
  };

  return panelApi;
}
