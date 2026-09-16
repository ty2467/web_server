// ---------------------------------------------------------------------------
// ifengus archive -> editors_db, one article at a time, off local disk.
//
// One pass over each page, two algorithms inside it:
//
//   1. Translation. The stored HTML goes through the editor's own paste
//      parser and lands in exactly the shape the ingest form produces. The
//      destination is that form's payload — nothing new is invented here.
//
//   2. Media relocation. Each URL the parser found is resolved to the file
//      the archiver already wrote, uploaded through the same endpoint the
//      editor uses, and the returned URL written back into the block. Done
//      inline, while the block is in hand, so the block array is built once
//      and never reopened.
//
//   npx tsx src/main.ts --aid 41137 --dry
//   npx tsx src/main.ts --range 40000-42000
// ---------------------------------------------------------------------------

import './env.js'; // installs DOM globals; must precede the parsers

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { BackendClient } from './api.js';
import type { ArticlePayload, BlockDTO } from './api.js';
import { MediaUploader } from './media-upload.js';
import { CATEGORY_MAP } from './category-map.js';

const { parseHtmlToBlockSeeds } = await import(
  process.env.PASTE_UTIL ?? '../../writer_front/src/app/ingest/paste.util.ts'
);
const { newBlock, blockToDto } = await import(
  process.env.BLOCK_MODEL ?? '../../writer_front/src/app/ingest/ingest-block.model.ts'
);

const { default: StarterKit } = await import('@tiptap/starter-kit');
const { default: Underline } = await import('@tiptap/extension-underline');
const { default: Link } = await import('@tiptap/extension-link');
const { TextStyle, FontSize } = await import('@tiptap/extension-text-style');

// Must match ingest.component.ts field-for-field. generateJSON parses against
// this schema; a node or mark the editor doesn't load is dropped silently
// when the article is later opened. Placeholder is omitted deliberately —
// it renders decoration only and contributes nothing to the document.
const extensions = [StarterKit, Underline, Link.configure({ openOnClick: false }), TextStyle, FontSize];

// Never on a crawl. In the editor a wrong caption is a one-click fix because
// someone is looking at it; here a false positive silently eats a paragraph.
const DETECT_CAPTIONS = false;

const PAGES_DIR = process.env.PAGES_DIR ?? '/var/archive/pages/a';
const MEDIA_ROOT = process.env.MEDIA_ROOT ?? '/srv/media/ifengus';
const ORIGIN = 'https://ifengus.com';

// ---------------------------------------------------------------------------
// Page extraction. Selectors verified against 41128, 41130, 41137.
// ---------------------------------------------------------------------------

const TITLE_RE = /<h1 class="metas-title"\s*>\s*([\s\S]*?)\s*<\/h1>/;
const DATE_RE = /(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):\d{2}/;
const WX_IMG_RE = /imgUrl:\s*'([^']+)'/;
const VIDEO_RE = /<(?:video|source)[^>]+src=["']([^"']+)["']/gi;

interface Scraped {
  aid: string;
  title: string;
  summary: string | null;
  sourceCategory: string | null;
  dateTime: string | null;
  viewCount: number;
  leadImageUrl: string | null;
  bodyHtml: string;
  videoUrls: string[];
}

function scrape(html: string, aid: string): Scraped | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const bodyEl = doc.querySelector('.article-text');
  if (!bodyEl) return null;

  const m = TITLE_RE.exec(html);
  const title = m ? m[1].replace(/<[^>]+>/g, '').trim() : '';

  const entryMeta = doc.querySelector('.entry-meta')?.textContent ?? '';
  const d = DATE_RE.exec(entryMeta);

  // The article's own 本文分类 link. The breadcrumb carries the same value
  // at its last position, but this one is unambiguous.
  const catLabel = doc.querySelector('.entry-meta a[href^="/c/"]')?.textContent?.trim() ?? null;

  const views = /(\d+)/.exec(doc.querySelector('.views-num')?.textContent ?? '');

  // Regex, not DOM: the CMS emits self-closing <video ... />, which an HTML
  // parser treats as an open tag that swallows its following siblings.
  const bodyHtml = bodyEl.innerHTML;
  const videoUrls: string[] = [];
  let v: RegExpExecArray | null;
  VIDEO_RE.lastIndex = 0;
  while ((v = VIDEO_RE.exec(bodyHtml)) !== null) videoUrls.push(new URL(v[1], ORIGIN).href);

  // The body carries no thumbnail. og:image is the site logo on every page;
  // the WeChat share config holds the image an editor actually chose.
  const lead = WX_IMG_RE.exec(html)?.[1] ?? null;

  return {
    aid,
    title,
    summary: doc.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() || null,
    sourceCategory: catLabel,
    dateTime: d ? `${d[1]}-${d[2]}-${d[3]}T${d[4]}:${d[5]}` : null,
    viewCount: views ? parseInt(views[1], 10) : 0,
    leadImageUrl: lead ? new URL(lead, ORIGIN).href : null,
    bodyHtml,
    videoUrls,
  };
}

// ---------------------------------------------------------------------------
// Algorithm 2: remote URL -> archived file.
//
// The archiver wrote <media_root>/<host>/<path>, so the inverse is exact:
// drop the scheme, keep host and path. Both sides leave percent-encoding
// intact, so the comparison is byte-for-byte with no decoding step.
// ---------------------------------------------------------------------------

function localPathFor(remoteUrl: string): string | null {
  let u: URL;
  try { u = new URL(remoteUrl); } catch { return null; }

  const p = path.join(MEDIA_ROOT, u.hostname, u.pathname.replace(/^\/+/, ''));
  return existsSync(p) ? p : null;
}

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
};

function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Validation. The ingest form's constraints, restated as assertions. Same
// rules; a violation skips the article instead of disabling a submit button.
//
// zonePicked does NOT transfer: it exists because an article with no
// homepage placement is useless to an editor. An archive import is exactly
// the case where no placement is correct.
// ---------------------------------------------------------------------------

function problemsWith(a: Scraped, category: string | undefined): string[] {
  const out: string[] = [];
  if (!a.title) out.push('no title');
  if (a.title.length > 255) out.push('title exceeds varchar(255)');
  if (!a.sourceCategory) out.push('no 本文分类 link');
  else if (!category) out.push(`category not mapped: ${a.sourceCategory}`);
  if (!a.dateTime) out.push('no parseable 发布日期');
  return out;
}

// ---------------------------------------------------------------------------

class Importer {
  // One upload per distinct file. Thumbnails recur across the recommendation
  // blocks, and the same image is shared between articles.
  private uploaded = new Map<string, string>();
  private missing = new Set<string>();

  constructor(
    private api: BackendClient,
    private media: MediaUploader,
    private dry: boolean
  ) {}

  /** Resolve, upload, return our URL. null when the archive has no such file. */
  private async relocate(remoteUrl: string, aid: string, isVideo: boolean): Promise<string | null> {
    const cached = this.uploaded.get(remoteUrl);
    if (cached) return cached;
    if (this.missing.has(remoteUrl)) return null;

    const local = localPathFor(remoteUrl);
    if (!local) {
      this.missing.add(remoteUrl);
      return null;
    }

    if (this.dry) return `[would upload] ${path.basename(local)}`;

    const bytes = readFileSync(local);
    let url: string;

    if (isVideo) {
      // Source videos are named 0.mp4 under dated directories, and the
      // handler writes whatever name it's given into one flat media dir —
      // so the basename alone collides across articles.
      url = await this.media.uploadVideoChunked(bytes, `${aid}-${path.basename(local)}`);
    } else {
      url = await this.media.uploadImage(bytes, path.basename(local), mimeFor(local));
    }

    this.uploaded.set(remoteUrl, url);
    return url;
  }

  /**
   * Algorithm 1 and 2 interleaved: seeds come out of the shared parser, and
   * each media URL is relocated as its block is constructed. blockToDto is
   * the editor's own, so the null-discipline (paragraphs carry content_json
   * and null media fields; media blocks the inverse) is not restated here.
   */
  private async buildBlocks(a: Scraped): Promise<BlockDTO[]> {
    const seeds = parseHtmlToBlockSeeds(
      a.bodyHtml, extensions, `${ORIGIN}/a/${a.aid}.html`, DETECT_CAPTIONS
    );

    const dtos: BlockDTO[] = [];
    let order = 0;

    for (const seed of seeds) {
      if (seed.kind === 'paragraph') {
        dtos.push({ ...blockToDto(newBlock('paragraph', order, { json: seed.json })), order_id: order });
        order++;
        continue;
      }

      if (!seed.remoteUrl) continue;

      const url = await this.relocate(seed.remoteUrl, a.aid, false);
      if (!url) {
        console.error(`    skip image, not archived: ${seed.remoteUrl}`);
        continue;
      }

      dtos.push({
        ...blockToDto(newBlock('image', order, { url, caption: seed.caption ?? '' })),
        order_id: order,
      });
      order++;
    }

    // Videos are pulled out by regex rather than by the parser, which only
    // knows <img>, so they append after the body's blocks.
    for (const src of a.videoUrls) {
      const url = await this.relocate(src, a.aid, true);
      if (!url) {
        console.error(`    skip video, not archived: ${src}`);
        continue;
      }
      dtos.push({ ...blockToDto(newBlock('video', order, { url })), order_id: order });
      order++;
    }

    return dtos;
  }

  async run(aid: string): Promise<'ok' | 'skipped' | 'failed'> {
    const file = path.join(PAGES_DIR, `${aid}.html`);
    if (!existsSync(file)) return 'skipped';

    const a = scrape(readFileSync(file, 'utf8'), aid);
    if (!a) {
      console.error(`  FAIL ${aid}: no .article-text`);
      return 'failed';
    }

    const category = a.sourceCategory ? CATEGORY_MAP[a.sourceCategory] : undefined;
    const problems = problemsWith(a, category);
    if (problems.length) {
      console.error(`  skip ${aid}: ${problems.join('; ')}`);
      return 'skipped';
    }

    const blocks = await this.buildBlocks(a);
    if (blocks.length === 0) {
      console.error(`  skip ${aid}: produced zero blocks`);
      return 'skipped';
    }

    let lead: string | null = null;
    if (a.leadImageUrl) lead = await this.relocate(a.leadImageUrl, a.aid, false);

    const payload: ArticlePayload = {
      id: null,
      title: a.title,
      summary: a.summary,
      author: null,                 // the source prints the outlet, not a byline
      category: category!,
      date_time: a.dateTime!,
      section_zone: null,           // archive import: no homepage placement
      intra_section_zone: null,     // the backend nulls this anyway with no front
      lead_image_url: lead,
      lead_image_caption: null,
      view_count: Math.min(Math.max(a.viewCount, 0), 4294967295),
      content_blocks: blocks,
    };

    if (this.dry) {
      console.log(JSON.stringify(payload, null, 2));
      return 'ok';
    }

    const id = await this.api.ingest(payload);
    console.log(`  ok ${aid} -> ${id}  [${blocks.map(b => b.type[0]).join('')}]  ${a.title}`);
    return 'ok';
  }

  report() {
    if (this.missing.size) {
      console.error(`\n${this.missing.size} media URLs had no archived file:`);
      for (const u of this.missing) console.error(`  ${u}`);
    }
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const has = (f: string) => args.includes(f);
  const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

  const dry = has('--dry');
  const single = val('--aid');
  const range = val('--range');

  let aids: string[];
  if (single) {
    aids = [single];
  } else if (range) {
    const m = /^(\d+)-(\d+)$/.exec(range);
    if (!m) { console.error('--range must be LO-HI'); process.exit(1); }
    const [lo, hi] = [parseInt(m[1], 10), parseInt(m[2], 10)];
    aids = readdirSync(PAGES_DIR)
      .map(f => /^(\d+)\.html$/.exec(f)?.[1])
      .filter((x): x is string => !!x)
      .filter(x => +x >= lo && +x <= hi)
      .sort((a, b) => +a - +b);
  } else {
    console.error('usage: --aid <id> | --range LO-HI  [--dry]');
    process.exit(1);
  }

  const cfg = {
    apiBase: process.env.API_BASE ?? 'http://192.168.123.72:9000/api',
    mediaHost: process.env.MEDIA_HOST ?? 'http://192.168.123.72:8080/media',
  };

  const api = new BackendClient({
    apiBase: cfg.apiBase.replace(/\/api$/, ''),
    mediaBase: cfg.mediaHost,
    username: process.env.API_USER ?? '',
    password: process.env.API_PASS ?? '',
  });

  if (!dry) {
    if (!process.env.API_USER || !process.env.API_PASS) {
      console.error('set API_USER and API_PASS, or use --dry');
      process.exit(1);
    }
    await api.login();
    console.log(`authenticated as ${process.env.API_USER}`);
  } else {
    console.log('DRY RUN — parsing and resolving only, nothing uploaded or inserted');
  }

  const media = new MediaUploader({ ...cfg, cookie: api.cookieHeader() });
  const imp = new Importer(api, media, dry);

  let ok = 0, skipped = 0, failed = 0;
  console.log(`${aids.length} articles from ${PAGES_DIR}\n`);

  for (const aid of aids) {
    try {
      const r = await imp.run(aid);
      if (r === 'ok') ok++; else if (r === 'skipped') skipped++; else failed++;
    } catch (e: any) {
      failed++;
      console.error(`  FAIL ${aid}: ${e?.message ?? e}`);
    }
  }

  imp.report();
  console.log(`\n${ok} imported, ${skipped} skipped, ${failed} failed`);
}

main().catch(e => { console.error(e); process.exit(1); });
