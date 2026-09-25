import { Component, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

@Component({
  selector: 'app-static-page',
  standalone: true,
  template: `
    <h1 class="page-title">{{ title }}</h1>
    <div class="static-body" [innerHTML]="html"></div>
  `,
  styles: [`
    .page-title { text-align: center; }
    .static-body { max-width: 900px; margin: 0 auto; line-height: 1.6; }
  `],
})
export class StaticPageComponent {
  private data = inject(ActivatedRoute).snapshot.data;
  title: string = this.data['title'];
  html: string = this.data['html'] ?? '';
}
