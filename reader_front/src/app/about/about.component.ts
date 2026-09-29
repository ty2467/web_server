import { Component } from '@angular/core';

@Component({
  selector: 'app-about',
  standalone: true,
  template: `
    <section class="about-wrap">
      <div class="about-head">
        <h2 class="about-title">Phoenix TV Americas</h2>
        <img src="/about/logo.png" class="about-logo" alt="Phoenix TV logo" />
      </div>

      <div class="about-intro">
        <img src="/about/collage.png" class="about-collage" alt="Phoenix TV Americas building, studios and newsroom" />
        <p class="about-text">
          Founded in the U.S. in 2001, Phoenix TV Americas is a leading Chinese-language media platform
          delivering trusted news and original programming across the Americas via cable, IPTV, and digital
          streaming. As one of the most established Chinese media brands outside Asia, Phoenix connects global
          Chinese communities with the world through credible journalism and culturally relevant storytelling.
          Through the global Phoenix Television network, our content reaches audiences in 63 countries and
          regions worldwide.
        </p>
      </div>

      <div class="stats">
        @for (s of stats; track s.num) {
          <div class="stat" [class.reach]="s.reach">
            <div class="stat-num">{{ s.num }}</div>
            <div class="stat-label">{{ s.label }}</div>
          </div>
        }
      </div>
    </section>

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
    .about-wrap { --gap: 16px; max-width: 1200px; margin: 0 auto; padding: 48px 24px 72px; color: #1a1a1a; }

    .about-head { display: flex; align-items: center; gap: 48px; margin-bottom: 40px; }
    .about-title { margin: 0; font-size: 2.75rem; font-weight: 700; line-height: 1.1; }
    .about-logo { height: 110px; width: auto; }

    .about-intro { display: grid; grid-template-columns: minmax(0, 55fr) minmax(0, 45fr); gap: 48px; align-items: center; }
    .about-collage { display: block; width: 100%; height: auto; }
    .about-text { margin: 0; font-size: 1.125rem; line-height: 1.7; }

    .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--gap); margin-top: 88px; }
    .stat { background: #E57035; color: #fff; min-height: 200px; padding: 24px 16px;
            display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
    .stat-num { font-family: 'Times New Roman', Times, serif; font-size: clamp(2.5rem, 5vw, 4.5rem); line-height: 1; }
    .stat-label { margin-top: 20px; font-size: 1rem; }

    .stat.reach { background: none; color: #1738E5; margin-left: calc(-1 * var(--gap)); }
    .stat.reach .stat-num { font-family: Arial, Helvetica, sans-serif; font-weight: 700; font-size: clamp(3.25rem, 7vw, 6.25rem); }
    .stat.reach .stat-label { color: #1a1a1a; font-size: 1.35rem; margin-top: 12px; }

    @media (max-width: 768px) {
      .about-head { gap: 24px; }
      .about-title { font-size: 2rem; }
      .about-logo { height: 72px; }
      .about-intro { grid-template-columns: 1fr; gap: 24px; }
      .stats { grid-template-columns: 1fr; }
      .stat.reach { margin-left: 0; }
    }

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

  stats = [
    { num: '800K+', label: 'WeChat annual views', reach: false },
    { num: '270K+', label: 'Ifengus Website article views', reach: false },
    { num: '300K+', label: 'YouTube views / video', reach: false },
    { num: '1.75M+', label: 'RED (Xiaohongshu) views / post', reach: false },
    { num: '120K+', label: 'TikTok views / video', reach: false },
    { num: '500M+', label: 'Global TV audience reach', reach: true },
  ];

  open(i: number) { this.current = i; }
  close() { this.current = null; }
  step(d: number, e: Event) { e.stopPropagation(); this.current! += d; }
}
