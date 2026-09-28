import { PME } from "./core/constants.js";
import { log } from "./core/log.js";
import { getExtensionSettings, isExtensionEnabled } from "../settings.js";

import { eventSource, event_types, saveSettingsDebounced } from "/script.js";
import {
  power_user,
  persona_description_positions,
} from "/scripts/power-user.js";
import { getContext } from "/scripts/st-context.js";
import {
  getOrCreatePersonaDescriptor,
  user_avatar,
} from "/scripts/personas.js";

const WRAPPER_PLACEHOLDER = "{{PROMPT}}";
const DEFAULT_ADDITIONAL_JOINER_RAW = "\\n\\n";
const DEFAULT_WRAPPER_TEMPLATE = `<tag>${WRAPPER_PLACEHOLDER}</tag>`;

/**
 * We need to apply the patch BEFORE SillyTavern computes `persona` via `getCharacterCardFields()`.
 * That happens before `runGenerationInterceptors()` runs.
 *
 * So we:
 * - apply runtime patch on GENERATION_AFTER_COMMANDS (and keep generate_interceptor as a safety net),
 * - restore as soon as the request payload is built (GENERATE_AFTER_DATA), with
 *   GENERATION_ENDED / GENERATION_STOPPED / a timer as fallbacks,
 * - never touch DOM, only runtime power_user values.
 *
 * `power_user` is persisted as a whole by SillyTavern, so any settings save that happens while
 * patched writes the patched description to disk. Upstream SillyTavern loads that value back
 * as the persona description on the next start. To make that recoverable, the original values
 * are recorded in extension settings (saved in the same payload) while patched, and
 * `recoverStalePatch()` puts them back on startup.
 */

/**
 * @typedef {object} PersonaSnapshot
 * @property {string} persona_description
 * @property {number} persona_description_position
 * @property {number} persona_description_depth
 * @property {number} persona_description_role
 */

/** @type {{active: boolean, snapshot: PersonaSnapshot|null, avatarId?: string, restoreTimer?: number}|null} */
let patchState = null;

function ensurePatchState() {
  patchState ??= { active: false, snapshot: null };
  return patchState;
}

/**
 * @param {any} descriptor
 */
function isLinkedToNative(descriptor) {
  return descriptor?.pme?.linkedToNative !== false;
}

function getPmeSettingsSnapshot(descriptor) {
  const s = descriptor?.pme?.settings;
  return {
    wrapperEnabled: s?.wrapperEnabled === true,
    wrapperTemplate:
      typeof s?.wrapperTemplate === "string"
        ? s.wrapperTemplate
        : DEFAULT_WRAPPER_TEMPLATE,
    additionalJoiner:
      typeof s?.additionalJoiner === "string"
        ? s.additionalJoiner
        : DEFAULT_ADDITIONAL_JOINER_RAW,
  };
}

/**
 * Turns user-friendly escape sequences into real characters.
 * Supports: \n, \r, \t, \\.
 * Unknown sequences keep the escaped character as-is (e.g. "\x" => "x").
 *
 * @param {string} raw
 */
function parseEscapes(raw) {
  const s = String(raw ?? "");
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = s[i + 1];
    if (next === undefined) {
      out += "\\";
      continue;
    }
    i++;
    if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "t") out += "\t";
    else if (next === "\\") out += "\\";
    else out += next;
  }
  return out;
}

/**
 * Prompt text of one item. Documents are wrapped in their label template
 * ({{NAME}} = block title, {{CONTENT}} = extracted text) unless the label is turned off.
 * Returns null for empty items.
 *
 * @param {any} item
 * @returns {string|null}
 */
function getItemPromptText(item) {
  const raw = String(item?.text ?? "");
  // NOTE: emptiness check uses trim(), but the injected value must stay unmodified.
  if (raw.trim().length === 0) return null;
  if (item?.kind !== "document" || item?.doc?.labelEnabled === false) return raw;

  const tpl = String(
    item?.doc?.labelTemplate ?? PME.documents.defaultLabelTemplate
  );
  if (!tpl.trim()) return raw;
  const name = String(item?.title ?? item?.doc?.fileName ?? "");
  // Same fallback as the persona wrapper: never drop the content.
  if (!tpl.includes("{{CONTENT}}")) return `${tpl}${raw}`;
  // Function replacer so "$&"-style sequences in the text are not interpreted.
  return tpl.replace(/\{\{(NAME|CONTENT)\}\}/g, (_m, key) =>
    key === "NAME" ? name : raw
  );
}

/**
 * Collect enabled Additional Description texts in the canonical order.
 * Titles/group names are UI-only and must NOT be included in the prompt.
 *
 * @param {any} descriptor
 * @param {any} ctx
 * @returns {string[]}
 */
function collectEnabledAdditionalTexts(descriptor, ctx) {
  const blocks = descriptor?.pme?.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) return [];

  /** @type {string[]} */
  const out = [];

  const currentChatId = String(ctx?.chatId ?? "").trim();
  const currentChidRaw =
    ctx?.characterId ?? ctx?.this_chid ?? ctx?.chid ?? ctx?.character_id;
  const currentChid = Number(currentChidRaw);
  const currentCharacter =
    Number.isFinite(currentChid) && Array.isArray(ctx?.characters)
      ? ctx.characters[currentChid]
      : null;
  const currentCharacterAvatar = String(currentCharacter?.avatar ?? "").trim();
  const currentCharacterDescription = String(
    currentCharacter?.description ?? ""
  );

  function evalMatchRule(query) {
    const q = String(query ?? "").trim();
    if (!q) return false;
    const hay = currentCharacterDescription;
    if (!hay) return false;

    // /pattern/flags
    if (q.startsWith("/")) {
      const lastSlash = q.lastIndexOf("/");
      if (lastSlash > 0) {
        const pattern = q.slice(1, lastSlash);
        const flags = q.slice(lastSlash + 1);
        try {
          const re = new RegExp(pattern, flags);
          return re.test(hay);
        } catch (e) {
          log(
            "Invalid match regex; treating as no-match",
            `{query=${JSON.stringify(q)}, err=${String(e?.message ?? e)}}`
          );
          return false;
        }
      }
    }

    // Plain text match (case-insensitive substring)
    return hay.toLowerCase().includes(q.toLowerCase());
  }

  function isConnectionsMatch(entity) {
    const adv = entity?.adv;
    const c = adv?.connections;
    if (!c || c.enabled !== true) return false;

    const chats = Array.isArray(c.chats) ? c.chats : [];
    const chars = Array.isArray(c.characters) ? c.characters : [];

    const chatOk = currentChatId ? chats.includes(currentChatId) : false;
    const charOk = currentCharacterAvatar
      ? chars.includes(currentCharacterAvatar) ||
        chars.includes(String(currentChid))
      : false;
    return chatOk || charOk;
  }

  function isMatchMatch(entity) {
    const adv = entity?.adv;
    const m = adv?.match;
    if (!m || m.enabled !== true) return false;
    return evalMatchRule(m.query);
  }

  function isAutoEnabled(entity) {
    return !!(entity?.adv?.connections?.enabled || entity?.adv?.match?.enabled);
  }

  function isEntityActive(entity) {
    if (!entity || typeof entity !== "object") return false;
    if (isAutoEnabled(entity)) {
      return isConnectionsMatch(entity) || isMatchMatch(entity);
    }
    return entity.enabled !== false;
  }

  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;

    if (b.type === "item") {
      if (!isEntityActive(b)) continue;
      const text = getItemPromptText(b);
      if (text !== null) out.push(text);
      continue;
    }

    if (b.type === "group") {
      // Group activation gates the entire subtree.
      if (!isEntityActive(b)) continue;
      const items = Array.isArray(b.items) ? b.items : [];
      for (const it of items) {
        if (!it || typeof it !== "object") continue;
        if (!isEntityActive(it)) continue;
        const text = getItemPromptText(it);
        if (text !== null) out.push(text);
      }
    }
  }

  return out;
}

/**
 * Text the host appends to the persona description on its own.
 *
 * SillyBunny composes `power_user.persona_description` as
 * `descriptor.description` + active "Scenario Notes". When PME replaces the base with the
 * unlinked (extended) description, those notes must be carried over, not dropped.
 * On upstream SillyTavern the composed value equals the base, so this returns "".
 *
 * @param {any} descriptor
 */
function getHostAppendedText(descriptor) {
  if (!Array.isArray(descriptor?.appendices) || !descriptor.appendices.length)
    return "";
  const composed = String(power_user?.persona_description ?? "").trim();
  const base = String(descriptor?.description ?? "").trim();
  if (!base) return composed;
  if (!composed.startsWith(base)) return "";
  return composed.slice(base.length).trim();
}

/**
 * Build the final persona description text for generation.
 * - Base comes from native power_user OR from `descriptor.pme.local` when unlinked.
 * - Additional Descriptions are appended in order, only enabled ones.
 *
 * @param {any} descriptor
 */
function buildFinalPersona(descriptor) {
  const linked = isLinkedToNative(descriptor);
  const settings = getPmeSettingsSnapshot(descriptor);
  const joiner = parseEscapes(
    settings.additionalJoiner || DEFAULT_ADDITIONAL_JOINER_RAW
  );

  const hostAppended = linked ? "" : getHostAppendedText(descriptor);
  const localBase = String(descriptor?.pme?.local?.description ?? "");
  const baseRaw = linked
    ? String(power_user?.persona_description ?? "")
    : hostAppended
      ? localBase.trim()
        ? `${localBase}\n\n${hostAppended}`
        : hostAppended
      : localBase;

  const ctx = getContext?.() ?? null;
  const additions = collectEnabledAdditionalTexts(descriptor, ctx);
  // Do NOT trim the combined text; only empty blocks are filtered out.
  const additionsText = additions.join(joiner);

  const baseHasContent = baseRaw.trim().length > 0;
  const finalText = baseHasContent
    ? additionsText
      ? `${baseRaw}${joiner}${additionsText}`
      : baseRaw
    : additionsText;

  const wrappedText =
    settings.wrapperEnabled && String(finalText).trim().length > 0
      ? (() => {
          const tpl = String(
            settings.wrapperTemplate ?? DEFAULT_WRAPPER_TEMPLATE
          );
          if (!tpl) return finalText;
          if (tpl.includes(WRAPPER_PLACEHOLDER)) {
            // Replace ALL occurrences
            return tpl.split(WRAPPER_PLACEHOLDER).join(String(finalText));
          }
          // Fallback: append (keep user data intact, but avoid dropping prompt)
          return `${tpl}${finalText}`;
        })()
      : finalText;

  // Position/depth/role are only overridden when using the unlinked local payload.
  const finalPosition = linked
    ? Number(
        power_user?.persona_description_position ??
          persona_description_positions.IN_PROMPT
      )
    : Number(
        descriptor?.pme?.local?.position ??
          persona_description_positions.IN_PROMPT
      );

  const finalDepth = linked
    ? Number(power_user?.persona_description_depth ?? 2)
    : Number(descriptor?.pme?.local?.depth ?? 2);

  const finalRole = linked
    ? Number(power_user?.persona_description_role ?? 0)
    : Number(descriptor?.pme?.local?.role ?? 0);

  return {
    linked,
    finalText: wrappedText,
    finalPosition,
    finalDepth,
    finalRole,
    hasAnyEffect: Boolean(wrappedText && String(wrappedText).trim().length > 0),
  };
}

/**
 * Text PME would currently append for the active persona (Additional Descriptions and
 * documents that are active in the current chat), joined like in the prompt.
 * Used by the UI to show the per-prompt token cost.
 */
export function getActiveAdditionsText() {
  const descriptor = getOrCreatePersonaDescriptor();
  const joiner = parseEscapes(
    getPmeSettingsSnapshot(descriptor).additionalJoiner ||
      DEFAULT_ADDITIONAL_JOINER_RAW
  );
  return collectEnabledAdditionalTexts(descriptor, getContext?.() ?? null).join(
    joiner
  );
}

function snapshotPowerUser() {
  return {
    persona_description: String(power_user?.persona_description ?? ""),
    persona_description_position: Number(
      power_user?.persona_description_position ??
        persona_description_positions.IN_PROMPT
    ),
    persona_description_depth: Number(
      power_user?.persona_description_depth ?? 2
    ),
    persona_description_role: Number(power_user?.persona_description_role ?? 0),
  };
}

function restorePowerUser(snapshot) {
  if (!snapshot) return;
  power_user.persona_description = snapshot.persona_description;
  power_user.persona_description_position =
    snapshot.persona_description_position;
  power_user.persona_description_depth = snapshot.persona_description_depth;
  power_user.persona_description_role = snapshot.persona_description_role;
}

/**
 * Apply runtime patch (idempotent).
 * @param {string} reason
 */
function applyPatch(reason) {
  const st = ensurePatchState();
  if (st.active) return;

  if (!isExtensionEnabled()) return;

  const descriptor = getOrCreatePersonaDescriptor();
  const { finalText, finalPosition, finalDepth, finalRole, hasAnyEffect } =
    buildFinalPersona(descriptor);

  // If nothing to inject/apply, don't touch runtime state.
  if (!hasAnyEffect) return;

  // Respect user disabling persona description entirely.
  if (finalPosition === persona_description_positions.NONE) return;

  const snap = snapshotPowerUser();

  // Avoid no-op patching when nothing changes.
  if (
    String(snap.persona_description) === String(finalText) &&
    Number(snap.persona_description_position) === Number(finalPosition) &&
    Number(snap.persona_description_depth) === Number(finalDepth) &&
    Number(snap.persona_description_role) === Number(finalRole)
  ) {
    return;
  }

  st.snapshot = snap;
  st.avatarId = String(user_avatar ?? "");
  st.active = true;
  getExtensionSettings().pendingRestore = {
    avatarId: st.avatarId,
    snapshot: snap,
    patchedText: finalText,
  };

  power_user.persona_description = finalText;
  power_user.persona_description_position = finalPosition;
  power_user.persona_description_depth = finalDepth;
  power_user.persona_description_role = finalRole;

  log(
    `Applied persona injection (${reason})`,
    `{avatarId=${String(user_avatar ?? "")}, len=${finalText.length}}`
  );

  // Safety net: if for some reason end events don't fire, restore soon.
  if (st.restoreTimer) window.clearTimeout(st.restoreTimer);
  st.restoreTimer = window.setTimeout(() => {
    restorePatch("timer");
  }, 30_000);
}

/**
 * Restore runtime patch (idempotent).
 * @param {string} reason
 */
function restorePatch(reason) {
  const st = ensurePatchState();
  if (!st.active) return;

  try {
    // If the persona was switched while patched, ST has already loaded the new
    // persona's values into power_user. Restoring would clobber them with the old ones.
    if (String(user_avatar ?? "") === st.avatarId) {
      restorePowerUser(st.snapshot);
    }
  } finally {
    st.active = false;
    st.snapshot = null;
    st.avatarId = undefined;
    delete getExtensionSettings().pendingRestore;
    if (st.restoreTimer) {
      window.clearTimeout(st.restoreTimer);
      st.restoreTimer = undefined;
    }
  }

  log(`Restored persona injection (${reason})`);
}

/**
 * Undo a patch that was persisted by a settings save during generation and never restored
 * (e.g. the page was closed mid-generation). Only acts when the stored description is still
 * exactly the patched text, so user edits made since are never overwritten.
 */
function recoverStalePatch() {
  const settings = getExtensionSettings();
  const pending = settings.pendingRestore;
  if (!pending) return;
  delete settings.pendingRestore;

  if (
    !ensurePatchState().active &&
    pending.snapshot &&
    String(user_avatar ?? "") === String(pending.avatarId) &&
    String(power_user?.persona_description ?? "") ===
      String(pending.patchedText ?? "")
  ) {
    restorePowerUser(pending.snapshot);
    log("Recovered persona description from an unfinished generation patch");
  }
  saveSettingsDebounced();
}

let hooksInstalled = false;

/**
 * Register a generate interceptor hook.
 *
 * NOTE: We also install generation lifecycle hooks because `getCharacterCardFields()`
 * (which computes the `persona` string) is called BEFORE `runGenerationInterceptors()`.
 */
export function registerGenerateInterceptor() {
  if (!hooksInstalled) {
    hooksInstalled = true;

    // Apply before prompt fields are captured (critical).
    eventSource.on(
      event_types.GENERATION_AFTER_COMMANDS,
      (_type, _meta, dryRun) => {
        if (dryRun) return;
        applyPatch("GENERATION_AFTER_COMMANDS");
      }
    );

    // Restore right after the prompt payload is built: nothing reads the persona
    // description later, and it keeps the window where a settings save could persist
    // the patched value as small as possible.
    eventSource.on(event_types.GENERATE_AFTER_DATA, (_data, dryRun) => {
      if (dryRun) return;
      restorePatch("GENERATE_AFTER_DATA");
    });

    // Restore in all normal/abort paths.
    eventSource.on(event_types.GENERATION_ENDED, () =>
      restorePatch("GENERATION_ENDED")
    );
    eventSource.on(event_types.GENERATION_STOPPED, () =>
      restorePatch("GENERATION_STOPPED")
    );
    eventSource.on(event_types.APP_READY, recoverStalePatch);
    if (event_types.PERSONA_CHANGED) {
      eventSource.on(event_types.PERSONA_CHANGED, () =>
        restorePatch("PERSONA_CHANGED")
      );
    }
  }

  if (typeof globalThis[PME.interceptor.globalKey] === "function") {
    return;
  }

  globalThis[PME.interceptor.globalKey] = async (
    _chat,
    _contextSize,
    _abort,
    _type
  ) => {
    // Safety net: if for some reason the early hook didn't run, apply here.
    // (This is late for `persona` computed by getCharacterCardFields, but still affects
    // persona extension prompts and other consumers.)
    applyPatch("generate_interceptor");
  };

  log(
    `Registered generate interceptor: globalThis.${PME.interceptor.globalKey} (active)`
  );
}
