import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute } from '@angular/router';
import { Article, SLOT, zonesOf, isOnAnyFront } from '../layout.model';

/**
 * The category page's one front block. Declared here rather than imported
 * from home.component: this shape is specific to THIS page (a single unit
 * with capped sides/sections above a row feed), and the homepage no longer
 * has anything of the kind.
 */
export interface CategoryFront {
  main: Article;
  sides: Article[];
  sections: Article[];
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
  private readonly SECTIONS_CAP = 3;

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
   * Unlike the homepage, this page has no 主板/次板/三版 distinction — every
   * article here already shares one category, and the page shows ONE front
   * block over an unbounded feed. So front membership is a yes/no question
   * ("is this on any front at all?"), and 排列 decides where inside the
   * block it goes.
   *
   * section_zone is a SET: an article tagged 'sub_main,column' is on a front
   * AND in 栏目. Membership is tested with zonesOf(), never with ===, which
   * is what the previous implementation did — every such article failed the
   * equality check and silently fell through to the row feed.
   *
   * Capacity is filled from the front-tagged articles first, then topped up
   * from the untagged pool, so the block never renders half-empty on a thin
   * category. Anything left over lands in the feed; nothing is discarded.
   */
  private ingestAndRoute(rawArticles: Article[]) {
    this.articleStore.clear();
    this.majorFront = null;
    this.rows = [];

    const centers: Article[] = [];
    const sideTagged: Article[] = [];
    const sectionTagged: Article[] = [];
    const pool: Article[] = []; // no front placement — feed material

    for (const art of rawArticles) {
      this.articleStore.set(art.id, art);

      if (!isOnAnyFront(art)) {
        pool.push(art);
        continue;
      }

      switch (art.intra_section_zone) {
        case SLOT.CENTER: centers.push(art); break;
        case SLOT.SIDE:   sideTagged.push(art); break;
        case SLOT.BOTTOM: sectionTagged.push(art); break;
        default:
          // On a front but with no 排列 — can't place it in the block, so
          // it still gets seen, in the feed.
          console.warn(`[category] id=${art.id}: on a front with no 排列 — sent to feed`);
          pool.push(art);
      }
    }

    // The block's lead. If this category has no 中心 at all, promote the
    // newest thing available rather than rendering an empty front.
    const main = centers.shift() ?? pool.shift();
    if (!main) {
      this.rows = pool;
      return;
    }

    const sides = sideTagged.splice(0, this.SIDES_CAP);
    const sections = sectionTagged.splice(0, this.SECTIONS_CAP);

    // UNDERFLOW — enlist from the feed pool to fill capacity.
    while (sides.length < this.SIDES_CAP && pool.length) sides.push(pool.shift()!);
    while (sections.length < this.SECTIONS_CAP && pool.length) sections.push(pool.shift()!);

    this.majorFront = { main, sides, sections };

    // OVERFLOW — extra 中心/侧/底 beyond what the single block holds go to
    // the top of the feed, ahead of untagged articles.
    this.rows = [...centers, ...sideTagged, ...sectionTagged, ...pool];
  }
}
