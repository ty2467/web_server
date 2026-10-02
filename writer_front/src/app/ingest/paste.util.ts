import type { Extensions, JSONContent } from '@tiptap/core';
import { generateJSON } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';

// NOTE: `generateJSON` is a pure utility exported from `@tiptap/core` in
// Tiptap v2. If your installed version has moved it to a separate
// `@tiptap/html` package, swap this import — the function signature
// (html, extensions) => JSONContent is unchanged.

export type ImageSeed = { sourceFile: File | null; remoteUrl: string | null; caption: string | null };

export type BlockSeed =
  | { kind: 'paragraph'; json: JSONContent }
  | ({ kind: 'image' } & ImageSeed);

const IMAGE_EXT_RE = /\.(jpe?g|gif|png|webp|svg|avif)(\?.*)?$/i;
const MAX_CAPTION_LENGTH = 240;

/**
 * Stands in for an image inside the HTML handed to the paragraph parser.
 * The index ties it back to images[] regardless of where it lands.
 */
const IMAGE_MARKER = '\uFFFC';
const IMAGE_MARKER_RE = /^\uFFFC(\d+)$/;

/** Marker paragraph (ProseMirror node) -> its index into images[], else null. */
export function imageMarkerIndex(node: PMNode | null | undefined): number | null {
  if (!node || node.type.name !== 'paragraph') return null;
  const m = IMAGE_MARKER_RE.exec(node.textContent);
  return m ? Number(m[1]) : null;
}

/** Same test on the JSON form, for the importer path. */
function imageMarkerIndexJSON(node: JSONContent): number | null {
  if (node.type !== 'paragraph') return null;
  const text = (node.content ?? []).map(c => c.text ?? '').join('');
  const m = IMAGE_MARKER_RE.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * Raw image bytes on the clipboard (screenshots, "copy image" from an
 * OS/app). A raw image paste is exclusive of other content.
 */
export function clipboardImageFile(event: ClipboardEvent): File | null {
  for (const item of Array.from(event.clipboardData?.items ?? [])) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

/**
 * Images out, markers in. Each image (with the caption it consumes) is
 * replaced in place by a marker paragraph; everything else is left for the
 * paragraph parser. Pasted font sizes are dropped here so they don't arrive
 * as FontSize marks; other style properties stay, since bold/italic from
 * Google Docs live in style attributes.
 *
 * baseUrl resolves relative <img src> (scraped markup carries paths like
 * /uploads/foo.jpg). detectCaptions off means a short line after an image
 * stays a paragraph: in the editor a wrong caption is a one-click fix, in
 * a bulk import nobody is looking.
 */
export function preparePastedHtml(
  html: string,
  baseUrl?: string,
  detectCaptions = true
): { html: string; images: ImageSeed[] } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = doc.body;
  const images: ImageSeed[] = [];

  body.querySelectorAll<HTMLElement>('[style]').forEach(el => el.style.removeProperty('font-size'));

  for (const img of Array.from(body.querySelectorAll('img'))) {
    if (!img.isConnected) continue;            // went out with an earlier image's caption
    const src = img.getAttribute('src');
    if (!src) { img.remove(); continue; }

    // The image's own footprint: climb through wrappers that hold nothing
    // else (<p><img></p>, <a><img></a>), so no empty shell is left behind.
    let unit: Element = soleWrapperOf(img, body);
    let caption: string | null = null;

    if (detectCaptions) {
      // Structural caption first: a container shared with this image only.
      const container = unit.parentElement;
      if (container && container !== body && container.querySelectorAll('img').length === 1) {
        caption = extractInlineCaption(container, img);
        if (caption) unit = container;
      }
      // Else a short line right after it.
      if (!caption) {
        const next = nextMeaningful(unit);
        caption = captionLikeText(next ?? undefined);
        if (caption) next!.remove();
      }
    }

    images.push({
      sourceFile: null,
      remoteUrl: baseUrl ? new URL(src, baseUrl).href : src,
      caption
    });

    const marker = doc.createElement('p');
    marker.textContent = IMAGE_MARKER + (images.length - 1);
    unit.replaceWith(marker);
  }

  return { html: body.innerHTML, images };
}

/**
 * HTML string -> block seeds, for callers without an editor (archive
 * importer). Same rule as the editor: images from preparePastedHtml,
 * paragraphs from the schema parse, one top-level node per block, empty
 * paragraphs dropped.
 */
export function parseHtmlToBlockSeeds(
  html: string,
  extensions: Extensions,
  baseUrl?: string,
  detectCaptions = true
): BlockSeed[] {
  const seeds: BlockSeed[] = [];
  if (!html) return seeds;

  const prepared = preparePastedHtml(html, baseUrl, detectCaptions);
    const doc = generateJSON(prepared.html, extensions) as JSONContent;

  for (const node of doc.content ?? []) {
    const k = imageMarkerIndexJSON(node);
    if (k !== null) {
      const img = prepared.images[k];
      if (img) seeds.push({ kind: 'image', ...img });
      continue;
    }
    if (!node.content?.length) continue;
    seeds.push({ kind: 'paragraph', json: { type: 'doc', content: [node] } });
  }
  return seeds;
}

// Plain-text paste: escape every line via textContent (never string-
// interpolate raw user text into markup), and treat bare image URLs as
// <img> so they flow through the same image path as HTML paste.
export function textLinesToHtml(text: string): string {
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

function isMeaningful(n: ChildNode): boolean {
  return n.nodeType === Node.ELEMENT_NODE ||
    (n.nodeType === Node.TEXT_NODE && !!n.textContent?.trim());
}

function soleWrapperOf(el: Element, stop: Element): Element {
  let cur = el;
  while (
    cur.parentElement &&
    cur.parentElement !== stop &&
    Array.from(cur.parentElement.childNodes).filter(isMeaningful).length === 1
  ) {
    cur = cur.parentElement;
  }
  return cur;
}

function nextMeaningful(el: Element): ChildNode | null {
  let n = el.nextSibling;
  while (n && !isMeaningful(n)) n = n.nextSibling;
  return n;
}

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
