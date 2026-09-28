export const PME = {
  id: "pme",
  storage: {
    advancedModeKey: "pme_advanced_mode",
    personaSortKey: "pme_persona_sort",
  },
  dom: {
    advancedToggleId: "pme_advanced_mode_toggle",
    rootId: "pme_root",
    rootClass: "pme-root",
  },
  interceptor: {
    globalKey: "pmeGenerateInterceptor",
  },
  documents: {
    // {{NAME}} = block title (defaults to the file name), {{CONTENT}} = extracted text
    defaultLabelTemplate: '<document name="{{NAME}}">\n{{CONTENT}}\n</document>',
    defaultTokenWarning: 4000,
  },
};
