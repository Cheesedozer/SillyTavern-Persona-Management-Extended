/**
 * Host frontend detection.
 *
 * PME runs on both upstream SillyTavern and SillyBunny (a SillyTavern fork with a
 * tabbed shell UI). Detect by DOM markers instead of version strings so it keeps
 * working as both evolve.
 */
export function isSillyBunny() {
  return !!document.querySelector(
    "#sb_character_tab_persona, .persona-workspace-tabs, .persona-editor-tabs"
  );
}
