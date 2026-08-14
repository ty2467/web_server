import { Component, computed, inject, signal, effect } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { Title, Meta } from '@angular/platform-browser';
import { Article, ARTICLE_SCHEMA_VERSION } from './article.model';

@Component({
  selector: 'app-article-detail',
  standalone: true,
  imports: [CommonModule, DatePipe],
  templateUrl: './article-detail.component.html',
  styleUrl: './article-detail.component.scss',
})
export class ArticleDetailComponent {
  private title = inject(Title);
  private meta = inject(Meta);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private http = inject(HttpClient);

  article = signal<Article | null>(null);
  suggestedArticles = signal<Array<Pick<Article, 'slug' | 'headline'>>>([]);

  /** True only when the article was genuinely revised after publication —
   *  a save-artifact gap under a minute doesn't count as an update. */
  showUpdated = computed(() => {
    const a = this.article();
    if (!a?.updatedAt) return false;
    return Date.parse(a.updatedAt) - Date.parse(a.publishedAt) > 60_000;
  });


  constructor() {
    // Populate from whatever the route resolver already fetched — no
    // duplicate request here, this just reads the resolved value.
    this.route.data.subscribe(data => {
      const resolved = data['article'] as Article | null;
      this.article.set(resolved);
      console.log(resolved);
      if (resolved) {
        this.fetchSuggested(resolved.slug);
      }
    });

    effect(() => {
      const a = this.article();
      if (!a) return;

      if (a.schema > ARTICLE_SCHEMA_VERSION) {
        console.warn('[article] payload schema newer than client', a.schema);
      }

      this.title.setTitle(a.headline);
      this.meta.updateTag({ name: 'description', content: a.dek ?? '' });
      this.meta.updateTag({ property: 'og:title', content: a.headline });
      this.meta.updateTag({ property: 'og:url', content: a.canonicalUrl });
      if (a.leadImage) {
        this.meta.updateTag({ property: 'og:image', content: a.leadImage.url });
      }
      this.setCanonical(a.canonicalUrl);
    });
  }

  viewCountLabel = computed(() => {
    const n = this.article()?.viewCount ?? 0;
    return n >= 10_000 ? (n / 10_000).toFixed(1).replace(/\.0$/, '') + '万'
      : n.toLocaleString();
  });

  /** Secondary, non-blocking — the article itself must still render if
   *  this fails, so it's fetched here rather than in the route resolver. */
  private fetchSuggested(slug: string): void {
    this.http
      .get<Array<Pick<Article, 'slug' | 'headline'>>>(`/api/articles/${slug}/suggested`)
      .subscribe({
        next: list => this.suggestedArticles.set(list),
        error: err => console.error('suggested articles fetch failed', err),
      });
  }

  goToArticle(slug: string): void {
    this.router.navigate(['/article', slug]);
  }

  private setCanonical(url: string): void {
    let link = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'canonical';
      document.head.appendChild(link);
    }
    link.href = url;
  }
}
