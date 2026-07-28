import { Router, RouterModule, ActivatedRoute } from '@angular/router';
import { Component, signal, inject, OnInit, OnDestroy, Output, EventEmitter, ElementRef, ViewChild, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { SafeUrlPipe } from '../safe-url.pipe';


interface StockQuote {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
}

export interface Article {
  id: string;
  title: string;
  summary: string;
  image?: string;
  video?: string;
  category: string;
  // is_featured?: number; // From MariaDB tinyint(1)

  // Layout routing tags
  section_zone?: string;
  intra_section_zone?: number; // 1 for lead, 2 for side, 3 for section card, 4 for matrix
}

// ---------------------------------------------------------
// PROJECTION INTERFACES (Defines the shape the HTML expects)
// ---------------------------------------------------------
export interface MajorFrontUnit { main: Article; sides: Article[]; sections: Article[]; }
export interface HalfFrontUnit { main: Article; sides: Article[]; }
export interface MatrixColumn { category: string; articles: Article[]; }


interface PageDataDTO {
  menuItems: string[];
  bannerText: string;
  articlePool: Article[];
}

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule, RouterModule, SafeUrlPipe],
  templateUrl: './home.component.html',
  styleUrls: ['home.component.css']
})
export class HomeComponent implements OnInit, OnDestroy {
  @ViewChild('leadVideo') videoElement!: ElementRef<HTMLVideoElement>;

  private cdr = inject(ChangeDetectorRef);
  private http = inject(HttpClient);
  private route = inject(ActivatedRoute);
  private sanitizer = inject(DomSanitizer);

  fadeState = signal<'fade-in' | 'fade-out'>('fade-in');

  // =========================================================================
  // 1. THE DBMS STORE (Single Source of Truth for all records)
  // =========================================================================
  private articleStore = new Map<string, Article>();

  // =========================================================================
  // 2. LAYOUT PROJECTIONS (Pointers populated by the ingester for the HTML)
  // =========================================================================

  // The rotisserie pool holds all 'intra_section_zone === 1' leads for the hero stack
  rotisseriePool: Article[] = [];
  currentLeadIndex = 0;
  private rotationInterval: any;

  // The getter gracefully connects your rotation engine to the HTML's `topLeadArticle`
  get topLeadArticle(): Article | null {
    return this.rotisseriePool.length > 0 ? this.rotisseriePool[this.currentLeadIndex] : null;
  }

  layout = {
    rotisserie: { sides: [] as Article[], sections: [] as Article[] },
    majorFronts: [] as MajorFrontUnit[],
    halfFronts: [] as HalfFrontUnit[],
  };

  matrixRows: MatrixColumn[][] = [];

  // Static/Mock arrays to prevent HTML errors for your nav/ticker
  // menuItems: string[] = ['World', 'Politics', 'Business', 'Tech'];
  stockData: StockQuote[] = [];


  ngOnInit() {

    console.log ("\n\n\n\ninitialized!\n\n\n\n")
    // 1. Listen to the RESOLVED data coming from the route
    this.route.data.subscribe(data => {
      const payload = data['articlePool'];   // now genuinely is Article[]
      if (payload) {
        this.ingestAndRoute(payload);
        this.startLeadRotation();
      }
    });
  }

  /**
   * THE INGESTER (Flat Array / RDBMS-Aligned)
   * Expects a single, linear array of articles ordered by layout priority.
   */
  private ingestAndRoute(rawArticles: Article[]) {
    // 1. Clear previous state
    this.articleStore.clear();
    this.rotisseriePool = [];
    this.layout = {
      rotisserie: { sides: [], sections: [] },
      majorFronts: [],
      halfFronts: []
    };
    this.matrixRows = [];

    const matrixCategoryMap = new Map<string, Article[]>();

    // 2. Execute the Routing Algorithm
    for (const art of rawArticles) {

      // Index the record into the Primary Store
      this.articleStore.set(art.id, art);
      console.log(art.section_zone)
      // Route based on the HTML section tags
      switch (art.section_zone) {


        case 'rotisserie':
          if (art.intra_section_zone === 1) this.rotisseriePool.push(art);
          else if (art.intra_section_zone === 2) this.layout.rotisserie.sides.push(art);
          else if (art.intra_section_zone === 3) this.layout.rotisserie.sections.push(art);
          break;

        case 'major_front':
          if (art.intra_section_zone === 1) {
            this.layout.majorFronts.push({ main: art, sides: [], sections: [] });
          } else {
            const currentMajor = this.layout.majorFronts[this.layout.majorFronts.length - 1];
            if (currentMajor) {
              if (art.intra_section_zone === 2) currentMajor.sides.push(art);
              else if (art.intra_section_zone === 3) currentMajor.sections.push(art);
            }
          }
          break;

        case 'half_front':
          if (art.intra_section_zone === 1) {
            this.layout.halfFronts.push({ main: art, sides: [] });
          } else {
            const currentHalf = this.layout.halfFronts[this.layout.halfFronts.length - 1];
            if (currentHalf) {
              if (art.intra_section_zone === 2) currentHalf.sides.push(art);
            }
          }
          break;

        case 'matrix':
        default:
          // Purge anything missing a section_zone to the matrix.
          // Provide a fallback string so Map doesn't key on null/undefined.
          const safeCategory = art.category || 'General';

          if (!matrixCategoryMap.has(safeCategory)) {
            matrixCategoryMap.set(safeCategory, []);
          }
          matrixCategoryMap.get(safeCategory)!.push(art);
          break;
      }
    }

    // 3. Construct Matrix Rows
    // Transform the category map into an array of columns, then chunk into rows of 3
    const columns = Array.from(matrixCategoryMap.entries()).map(
      ([category, articles]) => ({ category, articles })
    );

    for (let i = 0; i < columns.length; i += 3) {
      this.matrixRows.push(columns.slice(i, i + 3));
    }
  }

  // 2. Initializer checks the length of the siphoned leads
  startLeadRotation() {
    if (this.rotisseriePool && this.rotisseriePool.length > 0) {
      this.rotationInterval = setInterval(() => this.nextLead(), 6700);
    }
  }

  // 3. The Transition Engine
  nextLead() {
    this.fadeState.set('fade-out');

    setTimeout(() => {
      if (!this.rotisseriePool.length) return;

      // 1. Just update the index.
      // Angular will see topLeadArticle change and the Pipe will handle the URL update.
      this.currentLeadIndex = (this.currentLeadIndex + 1) % this.rotisseriePool.length;

      // 2. You don't need to manually set .src anymore!
      // Just tell the video to load the new source that the pipe just generated.
      const videoEl = this.videoElement?.nativeElement;
      console.log("\n\n video element", videoEl);
      if (videoEl) {
        videoEl.load();
        // videoEl.play(); // Keep this commented out as requested
      }

      this.fadeState.set('fade-in');
    }, 500);
  }

  ngOnDestroy() {
    if (this.rotationInterval) {
      clearInterval(this.rotationInterval);
    }
  }
}
