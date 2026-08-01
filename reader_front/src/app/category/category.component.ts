import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute } from '@angular/router';
import { Article, MajorFrontUnit } from '../home/home.component';

@Component({
  selector: 'app-category',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './category.component.html',
  styleUrls: ['./category.component.css']
})
export class CategoryComponent implements OnInit {
  private route = inject(ActivatedRoute);

  // Capacity of the single major-front unit — same shape as home's
  // majorFronts[i], just pinned to exactly one instance.
  private readonly SIDES_CAP = 3;
  private readonly SECTIONS_CAP = 3;

  private articleStore = new Map<string, Article>();

  majorFront: MajorFrontUnit | null = null;
  rows: Article[] = []; // Reuters-style feed, grows unbounded

  ngOnInit() {
    this.route.data.subscribe(data => {
      const payload = data['articlePool'];
      if (payload) {
        this.ingestAndRoute(payload);
      }
    });
  }

  /**
   * THE ENGINE
   * Backend pre-sorts major_front/rotisserie-tagged rows to the front of
   * the payload (see NewsController#getCategoryPageData). This partitions
   * that pre-sorted array into:
   *   - one MajorFrontUnit (main + sides + sections), and
   *   - everything else, which becomes the infinite row feed.
   */
  private ingestAndRoute(rawArticles: Article[]) {
    this.articleStore.clear();
    this.majorFront = null;
    this.rows = [];

    const frontCandidates: Article[] = [];
    const restPool: Article[] = [];

    for (const art of rawArticles) {
      this.articleStore.set(art.id, art);
      if (art.section_zone === 'major_front' || art.section_zone === 'rotisserie') {
        frontCandidates.push(art);
      } else {
        restPool.push(art);
      }
    }

    // No front-tagged articles at all — fall back to the top of the pool
    // rather than rendering an empty major front.
    const main = frontCandidates.shift() ?? restPool.shift();
    if (!main) {
      this.rows = restPool;
      return;
    }

    let sides = frontCandidates.splice(0, this.SIDES_CAP);
    let sections = frontCandidates.splice(0, this.SECTIONS_CAP);

    // UNDERFLOW: not enough front-tagged articles to fill capacity —
    // enlist from the row pool.
    while (sides.length < this.SIDES_CAP && restPool.length) {
      sides.push(restPool.shift()!);
    }
    while (sections.length < this.SECTIONS_CAP && restPool.length) {
      sections.push(restPool.shift()!);
    }

    this.majorFront = { main, sides, sections };

    // OVERFLOW: leftover front-tagged articles beyond capacity — purge
    // down into the rows.
    if (frontCandidates.length) {
      restPool.unshift(...frontCandidates);
    }

    this.rows = restPool;
  }
}
