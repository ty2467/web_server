import { RouterModule, ActivatedRoute } from '@angular/router';
import { Component, signal, inject, OnInit, OnDestroy, ElementRef, ViewChild, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';

import {
  Article, SLOT, FrontKey, FRONT_KEYS, FrontBuckets, MatrixColumn,
  emptyLayout, zonesOf, rendition
} from '../layout.model';

// Re-exported so any existing import of these from home.component keeps
// resolving; layout.model.ts is the real home for them.
export { SLOT };
export type { Article, FrontKey, FrontBuckets, MatrixColumn };
export const SHOWCASE_CATEGORY = '場景展示';
export const COLUMN_EXCLUDED_CATEGORY = '中美關係';

interface StockQuote {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
}

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './home.component.html',
  styleUrls: ['home.component.css'],
})
export class HomeComponent implements OnInit, OnDestroy {
  @ViewChild('leadVideo') videoElement!: ElementRef<HTMLVideoElement>;

  private cdr = inject(ChangeDetectorRef);
  private route = inject(ActivatedRoute);

  fadeState = signal<'fade-in' | 'fade-out'>('fade-in');

  // =========================================================================
  // 1. RECORD STORE — every article that came down, keyed by id.
  // =========================================================================
  private articleStore = new Map<string, Article>();

  // =========================================================================
  // 2. LAYOUT BUCKETS — what the template reads.
  //
  // Four zones: three fronts (主板 / 次板 / 三版) and 栏目. A front placement
  // and a 栏目 placement are independent — one article can hold both, and
  // then it renders in both places. That is the only multi-zone case; the
  // ingest form makes two fronts unselectable.
  //
  // There is exactly ONE 主板, ONE 次板, ONE 三版. Each is three labeled
  // buckets keyed by 排列. Nothing groups articles into repeated front
  // "units" — the schema carries no unit identity, so any such grouping
  // could only be guessed from arrival order.
  // =========================================================================
  layout: Record<FrontKey, FrontBuckets> = emptyLayout();

  // 栏目 is parallel category columns, that shape repeating down the page
  // until every column has been placed. The API caps each column at four
  // articles and decides category order; this only groups them into rows.
  matrixRows: MatrixColumn[][] = [];

  // Four across, not three: a trailing row of one or two columns leaves an
  // obvious hole on the right, and four fits the current category set in a
  // single row.
  private readonly COLUMNS_PER_ROW = 4;
  private readonly COLUMN_CAP = 4;
  private readonly SIDE_CAP = 3;

  private readonly BOTTOM_STRIP_ORDER = ['天天話題', '美國觀察', '中美關係'];



  // Only 主板 中心 rotates; it is the one bucket whose plurality is a
  // feature rather than an editorial mistake.
  currentLeadIndex = 0;
  private showcaseHead = 0;
  private rotationInterval: any;

  stockData: StockQuote[] = [];

  get rotisseriePool(): Article[] {
    return this.layout.main.center;
  }

  get topLeadArticle(): Article | null {
    return this.rotisseriePool[this.currentLeadIndex] ?? null;
  }

  // =========================================================================
  // CONGREGATIONS
  //
  // 栏目 renders in two runs with 三版 between them, rather than as one
  // continuous stack: a long uniform column reads as a dumped table, and
  // the break is what makes the page look edited. Both getters slice the
  // same matrixRows — the split is a rendering decision, and the schema
  // carries no notion of which congregation an article belongs to.
  // =========================================================================

  get columnsBeforeTertiary(): MatrixColumn[][] {
    return this.matrixRows.slice(0, 1);
  }

  get columnsAfterTertiary(): MatrixColumn[][] {
    return this.matrixRows.slice(1);
  }

  ngOnInit() {
    this.route.data.subscribe((data) => {
      const payload = data['articlePool'] as Article[] | undefined;
      if (payload) {
        this.ingestAndRoute(payload);
        this.startLeadRotation();
      }
    });
  }

  ngOnDestroy() {
    if (this.rotationInterval) {
      clearInterval(this.rotationInterval);
    }
  }



  // ===========================================================================
  // THE INGESTER
  //
  // For each article: read its zone membership, then drop a reference into
  // every bucket it claims. Two independent tests, no ordering assumptions,
  // no bucket's contents affecting another's, no state carried between
  // iterations. Re-running it on the same input in any order produces the
  // same layout.
  //
  // The one thing arrival order still decides is the order the 栏目 columns
  // appear in, which the API sets deliberately.
  // ===========================================================================

  private ingestAndRoute(rawArticles: Article[]) {
    this.articleStore.clear();
    this.layout = emptyLayout();
    this.matrixRows = [];
    this.currentLeadIndex = 0;
    this.showcaseHead = 0;

    const byCategory = new Map<string, Article[]>();

    for (const raw of rawArticles) {
      const zones = zonesOf(raw);

      if (zones.size === 0) {
        console.warn(`[home] id=${raw.id} "${raw.title}": no section_zone — not rendered`);
        continue;
      }

      // Small is the default. The one exception is 中心 on a front.
      const onFrontCenter =
        raw.intra_section_zone === SLOT.CENTER && FRONT_KEYS.some((k) => zones.has(k));

      const art: Article = {
        ...raw,
        image: rendition(raw.image, onFrontCenter ? 'big' : 'small'),
      };
      this.articleStore.set(art.id, art);
//       const zones = zonesOf(art);


      if (zones.size === 0) {
        // The ingest form requires a placement, so an untagged row is
        // legacy or broken data. Say so rather than quietly sweeping it
        // into 栏目 the way the previous implementation did — a silent
        // fallback is how bad rows stay invisible.
        console.warn(`[home] id=${art.id} "${art.title}": no section_zone — not rendered`);
        continue;
      }

      // --- fronts -----------------------------------------------------------
      // Tested independently rather than as a switch: a row that somehow
      // carries two fronts then renders twice (visible, diagnosable) instead
      // of landing in whichever branch happened to be checked first.
      for (const key of FRONT_KEYS) {
        if (!zones.has(key)) continue;
        this.placeInFront(key, art);
      }

      // --- 栏目 -------------------------------------------------------------
      // Independent of any front placement above. 栏目 has no 排列; the
      // column an article lands in is decided by its category.
      //HAPPY CAPPING
      if (zones.has('column') && art.category !== COLUMN_EXCLUDED_CATEGORY) {
        const category = art.category || 'General';
        if (!byCategory.has(category)) byCategory.set(category, []);
        const col = byCategory.get(category)!;
        //todo: column cap was not being readable by this.
        if (col.length < 4) {
          col.push(
            onFrontCenter ? { ...art, image: rendition(raw.image, 'small') } : art,
          );
        }
      }
    }

    const columns: MatrixColumn[] = Array.from(byCategory.entries()).map(
      ([category, articles]) => ({ category, articles }),
    );

    for (let i = 0; i < columns.length; i += this.COLUMNS_PER_ROW) {
      this.matrixRows.push(columns.slice(i, i + this.COLUMNS_PER_ROW));
    }

    // 主板底 is a fixed strip, left to right. Its order is the CEO's, not
    // date order — sorted here because arrival order can't express it.
    this.layout.main.bottom.sort(
      (a, b) =>
        this.BOTTOM_STRIP_ORDER.indexOf(a.category) - this.BOTTOM_STRIP_ORDER.indexOf(b.category),
    );
  }

  private placeInFront(key: FrontKey, art: Article) {
    const bucket = this.layout[key];

    switch (art.intra_section_zone) {
      case SLOT.CENTER:
        if (key === 'main' && art.category === SHOWCASE_CATEGORY) {
          bucket.center.splice(this.showcaseHead++, 0, art);
          break;
        }
        // 次板 and 三版 are single blocks, so a second 中心 is an editorial
        // mistake, not a second block. Render it (losing an article is
        // worse than an ugly page) but make the mistake audible.
        if (key !== 'main' && bucket.center.length > 0) {
          console.warn(`[home] id=${art.id}: second 中心 on ${key}, which is a single block`);
        }
        bucket.center.push(art);
        break;

      case SLOT.SIDE:
        if (bucket.side.length < 3) bucket.side.push(art); //should be side_cap,
        //but i dont' have time to waste at not interpreted constants
        break;

      case SLOT.BOTTOM:
        // 三版 has no 底 — the ingest form does not offer it there.
        if (key === 'tertiary') {
          console.warn(`[home] id=${art.id}: 底 on 三版, which has no 底 slot — dropped`);
        } else {
          bucket.bottom.push(art);
        }
        break;

      default:
        console.warn(
          `[home] id=${art.id}: on ${key} with no 排列 (got ${art.intra_section_zone}) — dropped`,
        );
    }
  }

  // ===========================================================================
  // 主板 rotation
  // ===========================================================================

  startLeadRotation() {
    if (this.rotationInterval) clearInterval(this.rotationInterval);
    if (this.rotisseriePool.length > 1) {
      this.rotationInterval = setInterval(() => this.nextLead(), 6700);
    }
  }

  nextLead() {
    this.fadeState.set('fade-out');

    setTimeout(() => {
      if (!this.rotisseriePool.length) return;

      this.currentLeadIndex = (this.currentLeadIndex + 1) % this.rotisseriePool.length;

      const videoEl = this.videoElement?.nativeElement;
      if (videoEl) {
        videoEl.load();
      }

      this.fadeState.set('fade-in');
      this.cdr.markForCheck();
    }, 500);
  }
}
