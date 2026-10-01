import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute } from '@angular/router';
import { Article, SLOT, isOnCategoryMain, rendition } from '../layout.model';

// Copies, not in-place edits: the resolver hands over the same objects on
// every emission, so rewriting image in place would stack suffixes.
const big = (a: Article): Article => ({ ...a, image: rendition(a.image, 'big') });
const small = (a: Article): Article => ({ ...a, image: rendition(a.image, 'small') });

/**
 * The category page's one front block: a 中心 with capped 侧 beside it.
 * No 底 — category pages don't have one.
 */
export interface CategoryFront {
  main: Article;
  sides: Article[];
}

@Component({
  selector: 'app-category',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './category.component.html',
  styleUrls: ['./category.component.css']
})
export class CategoryComponent implements OnInit {
  private route = inject(ActivatedRoute);

  private readonly SIDES_CAP = 3;

  private articleStore = new Map<string, Article>();

  majorFront: CategoryFront | null = null;
  rows: Article[] = []; // Reuters-style feed, grows unbounded

  ngOnInit() {
    this.route.data.subscribe(data => {
      const payload = data['articlePool'] as Article[] | undefined;
      if (payload) {
        this.ingestAndRoute(payload);
      }
    });
  }

  /**
   * THE ENGINE
   *
   * Placement here comes from category_position / category_intra, not the
   * homepage's section_zone. category_position is a SET: membership in 'main'
   * puts an article in the block; category_intra decides 中心 or 侧 within it.
   * Everything else — 'column'-only and unplaced alike — is feed material.
   *
   * Capacity is filled from the main-tagged articles first, then topped up
   * from the pool, so the block never renders half-empty on a thin category.
   * Anything left over lands in the feed; nothing is discarded.
   */
  private ingestAndRoute(rawArticles: Article[]) {
    this.articleStore.clear();
    this.majorFront = null;
    this.rows = [];

    const centers: Article[] = [];
    const sideTagged: Article[] = [];
    const pool: Article[] = []; // not in the main block — feed material

    for (const art of rawArticles) {
      this.articleStore.set(art.id, art);

      if (!isOnCategoryMain(art)) {
        pool.push(art);
        continue;
      }

      switch (art.category_intra) {
        case SLOT.CENTER: centers.push(art); break;
        case SLOT.SIDE:   sideTagged.push(art); break;
        default:
          // In main but with no valid 排列 — can't place it in the block, so
          // it still gets seen, in the feed.
          console.warn(`[category] id=${art.id}: in main with no 排列 — sent to feed`);
          pool.push(art);
      }
    }

    //small is default.
    const main = centers.shift() ?? pool.shift();
    if (!main) {
      this.rows = pool.map(small);
      return;
    }

    const sides = sideTagged.splice(0, this.SIDES_CAP);

    // UNDERFLOW — enlist from the feed pool to fill capacity.
    while (sides.length < this.SIDES_CAP && pool.length) sides.push(pool.shift()!);

    this.majorFront = { main: big(main), sides: sides.map(small) };

    // OVERFLOW — extra 中心/侧 beyond what the single block holds go to the
    // top of the feed, ahead of untagged articles.
    this.rows = [...centers, ...sideTagged, ...pool].map(small);
  }
}
