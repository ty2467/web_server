import type { JSONContent } from '@tiptap/core';

// ---------------------------------------------------------------------------
// Canonical in-memory model. `blocks: Block[]` is the ONLY source of truth
// for content. Tiptap editors, upload/progress state, and the submit payload
// are all *projections* of it — never the other way around.
// ---------------------------------------------------------------------------

export type BlockType = 'paragraph' | 'image' | 'video';

export interface ParagraphBlock {
  localId: string;
  type: 'paragraph';
  orderId: number;
  json: JSONContent; // ProseMirror JSON — no HTML round-trip
}

export type ImageAlign = 'left' | 'center' | 'right';

export interface MediaBlock {
  localId: string;
  type: 'image' | 'video';
  orderId: number;
  url: string; // '' until upload resolves
  caption: string; // '' if none — plain text, not rich content
  align: ImageAlign; // relative to the content column width
}

export type Block = ParagraphBlock | MediaBlock;

export function isParagraph(b: Block): b is ParagraphBlock {
  return b.type === 'paragraph';
}

// ---------------------------------------------------------------------------
// Ephemeral, per-block UI state — keyed by localId, never by array index.
// Never sent to the backend, never merged into Block. A media upload
// progressing must not touch the canonical model.
// ---------------------------------------------------------------------------

export interface BlockUIState {
  isUploading: boolean;
  progress: number;          // 0-100
  previewUrl: string | null; // object URL / data URL / remote URL for <img> src
  file: File | null;
  charCount: number;         // paragraph only
}

export function emptyUIState(): BlockUIState {
  return { isUploading: false, progress: 0, previewUrl: null, file: null, charCount: 0 };
}

export function makeLocalId(): string {
  return Math.random().toString(36).slice(2, 9);
}

export function emptyParagraphJson(): JSONContent {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

export function newBlock(
  type: BlockType,
  orderId: number,
  seed?: { json?: JSONContent; url?: string; caption?: string; align?: ImageAlign }
): Block {
  const localId = makeLocalId();
  return type === 'paragraph'
    ? { localId, type, orderId, json: seed?.json ?? emptyParagraphJson() }
    : { localId, type, orderId, url: seed?.url ?? '', caption: seed?.caption ?? '', align: seed?.align ?? 'center' };
}

// ---------------------------------------------------------------------------
// DB translation. content_blocks maps 1:1 onto a `content_blocks` row:
//   (article_id FK, order_id, type, content_json NULLABLE, media_url NULLABLE)
// No frontend-only field (localId) crosses this boundary in either direction.
// ---------------------------------------------------------------------------

export interface BlockDTO {
  type: BlockType;
  order_id: number;
  content_json: JSONContent | null;
  media_url: string | null;
  caption: string | null;
  align: ImageAlign | null;
}

export function blockToDto(b: Block): BlockDTO {
  return isParagraph(b)
    ? { type: 'paragraph', order_id: b.orderId, content_json: b.json, media_url: null, caption: null, align: null }
    : { type: b.type, order_id: b.orderId, content_json: null, media_url: b.url, caption: b.caption || null, align: b.align };
}

export function dtoToBlock(dto: BlockDTO): Block {
  const localId = makeLocalId();
  return dto.type === 'paragraph'
    ? { localId, type: 'paragraph', orderId: dto.order_id, json: dto.content_json ?? emptyParagraphJson() }
    : { localId, type: dto.type, orderId: dto.order_id, url: dto.media_url ?? '', caption: dto.caption ?? '', align: dto.align ?? 'center' };
}
