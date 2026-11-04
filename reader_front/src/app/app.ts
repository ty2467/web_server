import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { forkJoin, map } from 'rxjs';
import { Article, rendition } from './layout.model';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, CommonModule],
  templateUrl: './app.html',
  styleUrls: ['./app.css'],
})
export class App implements OnInit {
  private http = inject(HttpClient);

  menuItems: string[] = [
    '美洲頭條',
    '天天話題',
    '美國觀察',
    '工商新聞',
    '出海專區',
    'CES消費電子展',
    '美洲台探訪',
    '商務合作',
    '中美關係',
    '際會'
  ];

  stockData: any[] = [];
  private symbols = [
    '^GSPC', '^IXIC', '^DJI', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA',
    'BRK.B', 'LLY', 'AVGO', 'V', 'JPM', 'NVO', 'UNH', 'WMT', 'MA', 'JNJ', 'PG', 'HD',
  ];

  private apiKey = 'd7np7khr01qm36379nsgd7np7khr01qm36379nt0';


   /** search — lives in the shell so it survives route changes */
   private readonly SEARCH_URL = '/api/search';
   private readonly SEARCH_PREVIEW = 3;

   readonly searchQuery = signal<string>('');
   readonly searchResults = signal<Article[] | null>(null); // null = no active search
   readonly searchError = signal<string | null>(null);
   readonly searchExpanded = signal<boolean>(false);

   /** first 3 unless expanded */
   readonly visibleResults = computed(() => {
     const r = this.searchResults() ?? [];
     return this.searchExpanded() ? r : r.slice(0, this.SEARCH_PREVIEW);
   });

   readonly hiddenCount = computed(() =>
     (this.searchResults()?.length ?? 0) - this.visibleResults().length
   );

   readonly rendition = rendition;
  ngOnInit() {
    this.fetchStockData();
  }

  fetchStockData() {
    const requests = this.symbols.map((symbol) =>
      this.http.get(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${this.apiKey}`).pipe(
        map((res: any) => ({
          symbol,
          price: res.c,
          change: res.d,
          percent: res.dp,
        })),
      ),
    );

    forkJoin(requests).subscribe({
      next: (data) => (this.stockData = data),
      error: (err) => console.error('Stock fetch failed', err),
    });
  }


   /** NFKC (full-width -> half-width), collapse whitespace, trim, cap at the backend's 200. */
   private cleanQuery(raw: string): string {
     return raw.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 200);
   }

   /** Empty query clears the search. */
   submitSearch(raw: string): void {
     const q = this.cleanQuery(raw);
     this.searchQuery.set(q);
     this.searchError.set(null);
     this.searchExpanded.set(false);

     if (!q) {
       this.searchResults.set(null);
       return;
     }

     this.http.get<Article[]>(this.SEARCH_URL, { params: { q, limit: 50 } }).subscribe({
       next: (data) => {
         // a slower, older search must not overwrite a newer one
         if (this.searchQuery() === q) this.searchResults.set(data);
       },
       error: (err) => {
         console.error('Search failed:', err);
         if (this.searchQuery() === q) this.searchError.set('搜索失敗，請稍後再試。');
       }
     });
   }

   clearSearch(input?: HTMLInputElement): void {
     if (input) input.value = '';
     this.searchQuery.set('');
     this.searchResults.set(null);
     this.searchError.set(null);
     this.searchExpanded.set(false);
   }
}
