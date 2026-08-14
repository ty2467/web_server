/**
 * Article wire contract — shared by writer_back (producer) and writer_front (consumer).
 * Every field here traces to exactly one requested item. Nothing else.
 *
 *   id, slug / canonical URL, headline, dek, body content (ordered,
 *   traversable array of html/media), author, published timestamp,
 *   updated timestamp (null if never revised), category,
 *   lead image (url, alt, caption, credit),
 *   inline media (same four fields each), publish state.
 */

export const ARTICLE_SCHEMA_VERSION = 1;

/* ---------- body: ordered, traversable array ---------- */

export interface ParagraphBlock {
  type: 'paragraph';
  html: string;
}

/** Same four fields as the lead image. */
export interface MediaBlock {
  type: 'image' | 'video';
  url: string;
  alt: string;
  caption: string | null;
  credit: string | null;
}

export type ArticleBlock = ParagraphBlock | MediaBlock;

/* ---------- lead image: url, alt, caption, credit ---------- */

export interface LeadImage {
  url: string;
  alt: string;
  caption: string | null;
  credit: string | null;
}

export type PublishState =
  | 'draft'
  | 'scheduled'
  | 'published'
  | 'unpublished'
  | 'retracted';

/* ---------- article ---------- */

export interface Article {
  schema: number;

  id: number;
  slug: string;
  canonicalUrl: string;

  headline: string;
  dek: string | null;

  category: string;
  author: string;

  /** ISO 8601 with offset. */
  publishedAt: string;
  /** null if never revised. */
  updatedAt: string | null;

  leadImage: LeadImage | null;
  blocks: ArticleBlock[];

  state: PublishState;

  /** Computed at save time from word count, not recomputed per render. */
  readingTimeMinutes: number;

  viewCount: number;
}
