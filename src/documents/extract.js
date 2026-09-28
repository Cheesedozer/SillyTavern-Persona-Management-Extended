/**
 * Persona documents: turn an uploaded file into plain text.
 *
 * Text is extracted once on upload and stored in the persona (see personaStore),
 * the original file is not kept.
 */

import {
  extractTextFromEpub,
  extractTextFromMarkdown,
  extractTextFromOffice,
  extractTextFromPDF,
} from "/scripts/utils.js";

/** Plain-text formats read as-is. */
const TEXT_EXTENSIONS = ["txt", "text", "log", "csv", "json", "yaml", "yml"];

/** @type {Record<string, (file: File) => Promise<string>>} */
const EXTRACTORS = {
  md: extractTextFromMarkdown,
  markdown: extractTextFromMarkdown,
  html: extractTextFromHtml,
  htm: extractTextFromHtml,
  pdf: extractTextFromPDF,
  epub: extractTextFromEpub,
  docx: extractTextFromDocx,
};

export const DOCUMENT_ACCEPT = [...TEXT_EXTENSIONS, ...Object.keys(EXTRACTORS)]
  .map((ext) => `.${ext}`)
  .join(",");

/**
 * @param {string} name
 */
function getExtension(name) {
  const match = /\.([a-z0-9]+)$/i.exec(String(name ?? ""));
  return match ? match[1].toLowerCase() : "";
}

/**
 * @param {File} file
 */
export function isSupportedDocument(file) {
  const ext = getExtension(file?.name);
  return TEXT_EXTENSIONS.includes(ext) || ext in EXTRACTORS;
}

/**
 * Extract plain text from a supported file.
 * @param {File} file
 * @returns {Promise<string>}
 */
export async function extractDocumentText(file) {
  const ext = getExtension(file.name);
  let text;
  if (TEXT_EXTENSIONS.includes(ext)) {
    text = await file.text();
  } else if (ext in EXTRACTORS) {
    text = await EXTRACTORS[ext](file);
  } else {
    throw new Error(`Unsupported file type: .${ext || "?"}`);
  }
  return normalizeText(text);
}

/**
 * @param {string} text
 */
function normalizeText(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * DOCX without the Office server plugin: a .docx is a zip whose body lives in
 * `word/document.xml`. Paragraph text, tabs and line breaks are kept; formatting is dropped.
 * Falls back to SillyTavern's Office plugin extractor if the zip can't be read.
 *
 * @param {File} file
 * @returns {Promise<string>}
 */
async function extractTextFromDocx(file) {
  try {
    if (!("JSZip" in window)) await import("/lib/jszip.min.js");
    // eslint-disable-next-line no-undef
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const xml = await zip.file("word/document.xml")?.async("string");
    if (!xml) throw new Error("word/document.xml not found");

    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const paragraphs = [];
    for (const p of Array.from(doc.getElementsByTagNameNS(W, "p"))) {
      let line = "";
      const walk = (node) => {
        for (const child of Array.from(node.childNodes)) {
          if (child.namespaceURI !== W) continue;
          if (child.localName === "t") line += child.textContent ?? "";
          else if (child.localName === "tab") line += "\t";
          else if (child.localName === "br" || child.localName === "cr")
            line += "\n";
          // Nested paragraphs (e.g. inside text boxes) are visited on their own.
          else if (child.localName !== "p") walk(child);
        }
      };
      walk(p);
      paragraphs.push(line);
    }
    return paragraphs.join("\n");
  } catch (e) {
    console.warn("[PME] Built-in DOCX extraction failed, trying Office plugin", e);
    return extractTextFromOffice(file);
  }
}

const HTML_BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "DD", "DIV", "DL", "DT",
  "FIGCAPTION", "FIGURE", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER",
  "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TR", "UL",
]);

/**
 * HTML to text that keeps block boundaries as line breaks (SillyTavern's own
 * HTML extractor runs headings and paragraphs together when the markup has no newlines).
 *
 * @param {File} file
 * @returns {Promise<string>}
 */
async function extractTextFromHtml(file) {
  const html = await file.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, noscript, template, head").forEach((n) => n.remove());
  for (const node of Array.from(doc.body?.querySelectorAll("*") ?? [])) {
    if (HTML_BLOCK_TAGS.has(node.tagName)) node.after(doc.createTextNode("\n"));
  }
  return doc.body?.textContent ?? "";
}
