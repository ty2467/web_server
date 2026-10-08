import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute } from '@angular/router';
import { Article, rendition } from '../layout.model';

// Copies, not in-place edits: the resolver hands over the same objects on
// every emission, so rewriting image in place would stack suffixes.
const big = (a: Article): Article => ({ ...a, image: rendition(a.image, 'big') });
const small = (a: Article): Article => ({ ...a, image: rendition(a.image, 'small') });

/**
 * The category page's one front block: a 中心 with 侧 beside it.
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

  private readonly COLUMN_HEAD = 6;
  private readonly SIDES_CAP = 4;

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
   * Everything is placed by time, from the backend's date order:
   *
   *   newest   -> 中心
   *   next 6   -> 栏目 (feed head)
   *   next 4   -> 侧
   *   the rest -> 栏目, after the head
   *
   * A thin category shrinks the 栏目 head, never 侧: with R articles left
   * after 中心, the head is min(6, max(0, R - 4)), so 侧 fills before 栏目
   * does.
   */
  private ingestAndRoute(rawArticles: Article[]) {
    this.articleStore.clear();
    this.majorFront = null;
    this.rows = [];

    for (const art of rawArticles) this.articleStore.set(art.id, art);
    if (!rawArticles.length) return;

    const main = rawArticles[0];
    const rest = rawArticles.slice(1); // time order preserved

    const headCount = Math.min(this.COLUMN_HEAD, Math.max(0, rest.length - this.SIDES_CAP));
    const head  = rest.slice(0, headCount);
    const sides = rest.slice(headCount, headCount + this.SIDES_CAP);
    const tail  = rest.slice(headCount + this.SIDES_CAP);

    //small is default.
    this.majorFront = { main: big(main), sides: sides.map(small) };
    this.rows = [...head, ...tail].map(small);
  }
}
