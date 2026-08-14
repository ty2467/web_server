import { RouterModule, ActivatedRoute } from '@angular/router';
import { Component, signal, inject, OnInit, OnDestroy, ElementRef, ViewChild, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';

import {
  Article, SLOT, FrontKey, FRONT_KEYS, FrontBuckets, MatrixColumn,
  emptyLayout, zonesOf
} from '../layout.model';

// Re-exported so any existing import of these from home.component keeps
// resolving; layout.model.ts is the real home for them.
export { SLOT };
export type { Article, FrontKey, FrontBuckets, MatrixColumn };
export const SHOWCASE_CATEGORY = '场景展示';

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
  styleUrls: ['home.component.css']
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

  // 栏目 is three parallel category columns, that shape repeating down the
  // page until every column has been placed. Rows of three.
  matrixRows: MatrixColumn[][] = [];

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

  ngOnInit() {
    this.route.data.subscribe(data => {
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
  // ===========================================================================

  private ingestAndRoute(rawArticles: Article[]) {
    this.articleStore.clear();
    this.layout = emptyLayout();
    this.matrixRows = [];
    this.currentLeadIndex = 0;

    const byCategory = new Map<string, Article[]>();

    for (const art of rawArticles) {
      this.articleStore.set(art.id, art);
      const zones = zonesOf(art);

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
      if (zones.has('column')) {
        const category = art.category || 'General';
        if (!byCategory.has(category)) byCategory.set(category, []);
        byCategory.get(category)!.push(art);
      }
    }

    const columns: MatrixColumn[] = Array.from(byCategory.entries())
      .map(([category, articles]) => ({ category, articles }));

    for (let i = 0; i < columns.length; i += 3) {
      this.matrixRows.push(columns.slice(i, i + 3));
    }
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
        bucket.side.push(art);
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
        console.warn(`[home] id=${art.id}: on ${key} with no 排列 (got ${art.intra_section_zone}) — dropped`);
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
