import { Component, computed, inject, signal, effect } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { Router } from '@angular/router';
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
