import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild } from '@angular/core';

@Component({
  selector: 'app-about',
  standalone: true,
  template: `
    <section class="about-wrap" #wrap>
      <div class="about-head" #head>
        <div class="about-titles" #title>
          <h2 class="about-title">Phoenix Satellite TV Americas</h2>
          <p class="about-sub">About us</p>
        </div>
        <img src="/about/logo.png" class="about-logo" #logo alt="Phoenix TV logo" />
      </div>

      <div class="about-intro">
        <img src="/about/collage.png" class="about-collage" alt="Phoenix TV Americas building, studios and newsroom" />
        <div class="about-side">
          <h3 class="about-lead">Who we are</h3>
          <p class="about-text">
            Founded in the U.S. in 2001, Phoenix TV Americas is a leading Chinese-language media platform
            delivering trusted news and original programming across the Americas via cable, IPTV, and digital
            streaming. As one of the most established Chinese media brands outside Asia, Phoenix connects global
            Chinese communities with the world through credible journalism and culturally relevant storytelling.
            Through the global Phoenix Television network, our content reaches audiences in 63 countries and
            regions worldwide.
          </p>
        </div>
      </div>

      <div class="stats">
        @for (s of stats; track s.num) {
          <div class="stat" [class.reach]="s.reach">
            <div class="stat-num"><span>{{ s.num }}</span></div>
            <div class="stat-label">{{ s.label }}</div>
          </div>
        }
      </div>
    </section>

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
    .about-wrap { --gap: 16px; --logo-h: 190px; --logo-clear: 24px;
                  max-width: 1200px; margin: 0 auto; padding: 48px 24px 72px; color: #1a1a1a; }

    .about-head { position: relative; height: var(--logo-h); display: flex; align-items: center; margin-bottom: 40px; }
    .about-titles { max-width: calc(100% - var(--logo-h) - var(--logo-clear)); }
    .about-title { margin: 0; font-family: Charter, 'Bitstream Charter', 'Source Serif 4', Georgia, serif;
                   font-size: 3rem; font-weight: 700; line-height: 1.1; color: #1a1a1a; }
    .about-sub { margin: 10px 0 0; font-family: Charter, 'Bitstream Charter', 'Source Serif 4', Georgia, serif;
                 font-size: 1rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase;
                 color: var(--brand, #E77431); }
    .about-logo { position: absolute; top: 0; left: var(--logo-cx, 75%); transform: translateX(-50%);
                  height: var(--logo-h); width: auto; }

    .about-intro { display: grid; grid-template-columns: minmax(0, 55fr) minmax(0, 45fr); gap: 48px; align-items: center; }
    .about-collage { display: block; width: 100%; height: auto; }
    .about-lead { margin: 0 0 12px; font-family: Charter, 'Bitstream Charter', 'Source Serif 4', Georgia, serif;
                  font-size: 1.6rem; font-weight: 700; line-height: 1.2; }
    .about-text { margin: 0; font-size: 1.2rem; line-height: 1.55; }

    .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--gap); margin-top: 88px; }
    .stat { background: var(--brand, #E77431); color: #fff; min-height: 200px; padding: 24px 16px;
            display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
    .stat-num { font-family: 'Times New Roman', Times, serif; font-size: clamp(2.5rem, 5vw, 4.5rem); line-height: 1; }
    .stat-label { margin-top: 20px; font-size: 1rem; }

    .stat.reach { background: none; color: #1738E5; margin-left: calc(-1 * var(--gap)); }
    .stat.reach .stat-num { font-family: Arial, Helvetica, sans-serif; font-weight: 700; font-size: clamp(3.25rem, 7vw, 6.25rem); }
    .stat.reach .stat-label { color: #1a1a1a; font-size: 1.35rem; margin-top: 12px; }

    @media (max-width: 768px) {
      .about-head { height: auto; gap: 20px; }
      .about-titles { max-width: none; }
      .about-title { font-size: 2rem; }
      .about-sub { font-size: 0.875rem; margin-top: 6px; }
      .about-logo { position: static; transform: none; height: 48px; }
      .about-intro { grid-template-columns: 1fr; gap: 24px; }
      .about-lead { font-size: 1.35rem; }
      .about-text { font-size: 1.125rem; }
      .stats { grid-template-columns: 1fr; }
      .stat.reach { margin-left: 0; }
    }

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
export class AboutComponent implements AfterViewInit, OnDestroy {
  @ViewChild('wrap') wrap!: ElementRef<HTMLElement>;
  @ViewChild('head') head!: ElementRef<HTMLElement>;
  @ViewChild('title') title!: ElementRef<HTMLElement>;
  @ViewChild('logo') logo!: ElementRef<HTMLImageElement>;
  private ro?: ResizeObserver;

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

  ngAfterViewInit() {
    this.ro = new ResizeObserver(() => this.placeLogo());
    this.ro.observe(this.wrap.nativeElement);
    document.fonts.ready.then(() => this.placeLogo());
    this.logo.nativeElement.addEventListener('load', () => this.placeLogo());
  }

  ngOnDestroy() { this.ro?.disconnect(); }

  private placeLogo() {
    const card = this.wrap.nativeElement.querySelectorAll<HTMLElement>('.stat')[2];
    const text = card?.querySelector<HTMLElement>('.stat-num span')?.firstChild;
    if (!text) return;

    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 1);
    const three = range.getBoundingClientRect();

    const head = this.head.nativeElement.getBoundingClientRect();
    const titleRight = this.title.nativeElement.getBoundingClientRect().right - head.left;
    const half = this.logo.nativeElement.getBoundingClientRect().width / 2;

//     const target = three.left + three.width / 2 - head.left;
    const target = three.left - head.left;
    const min = titleRight + 24 + half;
    const max = head.width - half;

    this.head.nativeElement.style.setProperty('--logo-cx', `${Math.min(Math.max(target, min), max)}px`);
  }

  open(i: number) { this.current = i; }
  close() { this.current = null; }
  step(d: number, e: Event) { e.stopPropagation(); this.current! += d; }
}
