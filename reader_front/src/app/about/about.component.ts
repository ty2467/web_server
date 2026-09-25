import { Component } from '@angular/core';

@Component({
  selector: 'app-about',
  standalone: true,
  template: `
    <h1 class="page-title">關於我們</h1>
    <div class="slide-grid">
      @for (src of slides; track src; let i = $index) {
        <img [src]="src" class="slide-thumb" (click)="open(i)" />
      }
    </div>

    @if (current !== null) {
      <div class="slide-overlay" (click)="close()">
        <img [src]="slides[current]" class="slide-full" (click)="$event.stopPropagation()" />
        <button class="slide-close" (click)="close()">&times;</button>
        @if (current > 0) {
          <button class="slide-prev" (click)="step(-1, $event)">&lt;</button>
        }
        @if (current < slides.length - 1) {
          <button class="slide-next" (click)="step(1, $event)">&gt;</button>
        }
      </div>
    }
  `,
  styles: [`
    .page-title { text-align: center; }
    .slide-grid { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; }
    .slide-thumb { width: 340px; max-width: 100%; cursor: pointer; }
    .slide-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.85); z-index: 2000;
                     display: flex; align-items: center; justify-content: center; }
    .slide-full { max-width: 90vw; max-height: 90vh; }
    .slide-overlay button { position: absolute; background: none; border: none; color: #fff;
                            font-size: 40px; cursor: pointer; padding: 0 16px; }
    .slide-close { top: 16px; right: 16px; }
    .slide-prev { left: 16px; top: 50%; transform: translateY(-50%); }
    .slide-next { right: 16px; top: 50%; transform: translateY(-50%); }
  `],
})
export class AboutComponent {
  slides = Array.from({ length: 29 }, (_, i) => `/about/Slide${String(i + 1).padStart(2, '0')}.png`);
  current: number | null = null;

  open(i: number) { this.current = i; }
  close() { this.current = null; }
  step(d: number, e: Event) { e.stopPropagation(); this.current! += d; }
}
