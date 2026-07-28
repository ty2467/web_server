import type { Extensions, JSONContent } from '@tiptap/core';
import { generateJSON } from '@tiptap/core';

// NOTE: `generateJSON` is a pure utility exported from `@tiptap/core` in
// Tiptap v2. If your installed version has moved it to a separate
// `@tiptap/html` package, swap this import — the function signature
// (html, extensions) => JSONContent is unchanged.

export type BlockSeed =
  | { kind: 'paragraph'; json: JSONContent }
  | { kind: 'image'; sourceFile: File | null; remoteUrl: string | null; caption: string | null };

const IMAGE_EXT_RE = /\.(jpe?g|gif|png|webp|svg|avif)(\?.*)?$/i;

/**
 * Turns a ClipboardEvent into an ordered list of block seeds. Pure function:
 * no DOM mutation outside a detached fragment, no Angular, no network calls,
 * no Editor instance required. Everything here happens once and is done —
 * this is the buffer, not a store.
 */
export function parseClipboardToBlockSeeds(
  event: ClipboardEvent,
  extensions: Extensions
): BlockSeed[] {
  const seeds: BlockSeed[] = [];
  const dt = event.clipboardData;
  if (!dt) return seeds;

  // 1) Direct image data (screenshots, "copy image" from an OS/app).
  for (const item of Array.from(dt.items ?? [])) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        seeds.push({ kind: 'image', sourceFile: file, remoteUrl: null, caption: null });
        return seeds; // a raw image paste is exclusive of other content
      }
    }
  }

  const html = dt.getData('text/html');
  const text = dt.getData('text/plain');
  if (!html && !text) return seeds;

  const topLevelNodes = html
    ? unwrapSingleChildWrappers(parseHtmlFragment(html))
    : unwrapSingleChildWrappers(parseHtmlFragment(textLinesToHtml(text)));

  walk(topLevelNodes, seeds, extensions);
  return seeds;
}

function parseHtmlFragment(html: string): DocumentFragment {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const frag = document.createDocumentFragment();
  Array.from(doc.body.childNodes).forEach(n => frag.appendChild(n));
  return frag;
}

// Plain-text paste: escape every line via textContent (never string-
// interpolate raw user text into markup), and treat bare image URLs as
// <img> so they flow through the same image path as HTML paste.
function textLinesToHtml(text: string): string {
  return text
    .split(/\r?\n/)
    .map(line => {
      const trimmed = line.trim();
      if (/^https?:\/\//i.test(trimmed) && IMAGE_EXT_RE.test(trimmed)) {
        const img = document.createElement('img');
        img.src = trimmed;
        return img.outerHTML;
      }
      const p = document.createElement('p');
      p.textContent = line; // auto-escapes
      return p.outerHTML;
    })
    .join('');
}

// Google Docs / Notion / Word wrap the entire selection in one meaningless
// container (e.g. a single <b id="docs-internal-guard-..."> spanning
// everything). Recurse down while there's exactly one child and it isn't
// itself a content-bearing leaf, so real siblings surface to the top level.
function unwrapSingleChildWrappers(root: DocumentFragment): ChildNode[] {
  let current: Node = root;
  const LEAF_TAGS = ['IMG', 'P', 'H1', 'H2', 'H3', 'UL', 'OL', 'PRE', 'BLOCKQUOTE'];
  while (
    current.childNodes.length === 1 &&
    current.firstChild?.nodeType === Node.ELEMENT_NODE &&
    !LEAF_TAGS.includes((current.firstChild as Element).tagName)
    ) {
    current = current.firstChild;
  }
  return Array.from(current.childNodes);
}

const MAX_CAPTION_LENGTH = 240;

// Caption sitting inside the SAME container as the image — a real
// <figure><figcaption>, or just a <div>/<span> wrapping both, which is
// what most news sites actually use instead of semantic markup. Clone the
// container, strip the specific <img> back out, and see what text is left
// — this doesn't depend on any particular tag name for the caption itself.
function extractInlineCaption(container: Element, img: Element): string | null {
  const originalImgs = Array.from(container.querySelectorAll('img'));
  const imgIndex = originalImgs.indexOf(img as HTMLImageElement);
  if (imgIndex === -1) return null;

  const clone = container.cloneNode(true) as Element;
  const clonedImg = clone.querySelectorAll('img')[imgIndex];
  clonedImg?.remove();

  const text = clone.textContent?.trim() ?? '';
  return text && text.length <= MAX_CAPTION_LENGTH ? text : null;
}

// A short line of text sitting immediately after a STANDALONE <img> node
// (no shared wrapping container) — the common "image, then a caption <p>
// right after it" pattern, with no structural link between the two at all.
function captionLikeText(node: ChildNode | undefined): string | null {
  if (!node) return null;
  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.TEXT_NODE) return null;
  if (node.nodeType === Node.ELEMENT_NODE && (node as Element).querySelector('img')) return null;
  const text = node.textContent?.trim() ?? '';
  return text && text.length <= MAX_CAPTION_LENGTH ? text : null;
}

function walk(nodes: ChildNode[], seeds: BlockSeed[], extensions: Extensions) {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.TEXT_NODE) continue;
    const el = node as Element;

    const img = node.nodeType === Node.ELEMENT_NODE
      ? (el.tagName === 'IMG' ? el : el.querySelector('img'))
      : null;

    if (img) {
      const src = (img as HTMLImageElement).getAttribute('src');
      if (src) {
        // Structural caption (shares a container with the image) wins —
        // it's actually tied to this exact image, not just nearby.
        let caption = el.tagName !== 'IMG' ? extractInlineCaption(el, img) : null;

        // Otherwise, fall back to "short text right after a bare <img>".
        let consumedNext = false;
        if (!caption) {
          const next = captionLikeText(nodes[i + 1]);
          if (next) {
            caption = next;
            consumedNext = true;
          }
        }

        seeds.push({ kind: 'image', sourceFile: null, remoteUrl: src, caption });
        if (consumedNext) i++; // don't also emit that node as its own paragraph
        continue;
      }
    }

    const isElement = node.nodeType === Node.ELEMENT_NODE;
    const text = node.textContent?.trim();
    if (!text) continue;

    const html = isElement ? stripInlineStyles(el.cloneNode(true) as Element) : wrapAsParagraph(text);
    if (html === '<br>') continue;

    const json = generateJSON(html, extensions);
    seeds.push({ kind: 'paragraph', json });
  }
}

function stripInlineStyles(el: Element): string {
  el.querySelectorAll('[style]').forEach(n => n.removeAttribute('style'));
  el.removeAttribute('style');
  return el.outerHTML;
}

function wrapAsParagraph(text: string): string {
  const p = document.createElement('p');
  p.textContent = text; // escapes automatically
  return p.outerHTML;
}
