import { Component, OnInit, signal, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
/** use formbuilder for update. duh*/
import { FormBuilder, FormGroup, ReactiveFormsModule } from '@angular/forms';
import {Router} from '@angular/router';


// Define the shape based on your SQL schema
interface EditorialItem {
  id: number;
  title: string;
  category: string;
  date_time: string;
}

/** for */
interface ArticleRequest {
  id?: number;
  title: string;
  summary: string;
  author: string;
  category: string;
  is_featured: boolean;
  paragraph_text: string;
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.css']
})
export class DashboardComponent implements OnInit {
  private http = inject(HttpClient);


  /** helper flags*/
  readonly articles = signal<EditorialItem[]>([]);
  readonly isLoading = signal<boolean>(true);
  readonly errorMessage = signal<string | null>(null);


  /** api routing. */
  //9.16
  //private readonly serverIP: string = window.location.hostname;
  //private readonly port: string = '9000'; //http://ip:9000
  //public readonly baseURL: string = `http://${this.serverIP}:${this.port}/api`;

  public readonly baseURL: string = '/api';


  private readonly API_URL = this.baseURL + "/articles/summary"; //api/articles/summary';
  private readonly API_URL2 = this.baseURL +"/delete"; ///api/delete';
  private readonly SEARCH_URL = this.baseURL + "/search"; ///api/search';
  /** modify dashboard objects */
  readonly selectedIds = signal<Set<number>>(new Set());
  readonly pendingDelete = signal<EditorialItem | null>(null);


  /**
   * search — picks the base list. Active: the ranked results. Empty: all
   * articles. The filters below always run on whichever base this yields,
   * so search and filters compose instead of competing.
   */
  readonly searchQuery = signal<string>('');
  readonly searchResults = signal<EditorialItem[] | null>(null);

  private readonly baseArticles = computed(() => this.searchResults() ?? this.articles());


  /** filters */
  readonly idMin = signal<number | null>(null);
  readonly idMax = signal<number | null>(null);
  readonly categoryFilter = signal<string>('');
  readonly monthFilter = signal<string>(''); // 'YYYY-MM', what <input type="month"> emits

  readonly categories = computed(() =>
    [...new Set(this.articles().map(a => a.category).filter(Boolean))].sort()
  );

  /** search base -> filters. Recomputes when either side changes. */
  readonly visibleArticles = computed(() => {
    const min = this.idMin();
    const max = this.idMax();
    const cat = this.categoryFilter();
    const month = this.monthFilter();

    return this.baseArticles().filter(a => {
      if (min !== null && a.id < min) return false;
      if (max !== null && a.id > max) return false;
      if (cat && a.category !== cat) return false;
      if (month && this.toMonthKey(a.date_time) !== month) return false;
      return true;
    });
  });

    /** pagination — sits on top of visibleArticles */
  readonly pageSize = signal<number>(25);

  // the page index is tagged with the filter + search state it was chosen under;
  // when either changes, or the page size does, the tag stops matching and it falls back to page 0
  private readonly pageKey = computed(() =>
    `${this.idMin()}|${this.idMax()}|${this.categoryFilter()}|${this.monthFilter()}|${this.pageSize()}|${this.searchQuery()}`
  );
  private readonly pageState = signal<{ key: string; index: number }>({ key: '', index: 0 });

  readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.visibleArticles().length / this.pageSize()))
  );

  readonly currentPage = computed(() => {
    const s = this.pageState();
    const idx = s.key === this.pageKey() ? s.index : 0;
    return Math.min(idx, this.totalPages() - 1); // deletes can empty the last page
  });

  readonly pagedArticles = computed(() => {
    const start = this.currentPage() * this.pageSize();
    return this.visibleArticles().slice(start, start + this.pageSize());
  });


  readonly pageButtons = computed<(number | null)[]>(() => {
    const total = this.totalPages();
    const cur = this.currentPage() + 1; // 1-based for the math
    const pages = new Set<number>([1, total]);

    for (let p = cur - 2; p <= cur + 2; p++) pages.add(p);
    const lo = Math.ceil((cur - 20) / 5) * 5;
    for (let p = lo; p <= cur + 20; p += 5) pages.add(p);

    const sorted = [...pages].filter(p => p >= 1 && p <= total).sort((a, b) => a - b);

    const out: (number | null)[] = [];
    sorted.forEach((p, i) => {
      if (i > 0 && p - sorted[i - 1] > 5) out.push(null);
      out.push(p - 1); // back to 0-based index
    });
    return out;
  });


  private fb = inject(FormBuilder); // Restore injection


  private router = inject(Router);

  goToFullEdit(id: number) {
    this.router.navigate(['/ingest'], { queryParams: { edit: id } });
  }

  ngOnInit(): void {
    console.log("what is the base url? \n\n" ,this.API_URL);
    this.fetchEditorialData();
  }


  /**
   * request dashboard data.
   * */
  fetchEditorialData(): void {
    this.http.get<EditorialItem[]>(this.API_URL).subscribe({
      next: (data) => {
        this.articles.set(data);
        this.isLoading.set(false);
      },
      error: (err) => {
        console.error('Fetch failed:', err);
        this.errorMessage.set('Failed to synchronize with backend worker.');
        this.isLoading.set(false);
      }
    });
  }


  /**
   * @search
   */
  /** NFKC (full-width -> half-width), collapse whitespace, trim, cap at the backend's 200. */
  private cleanQuery(raw: string): string {
    return raw.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  /** Empty query clears the search back to all articles. */
  submitSearch(raw: string): void {
    const q = this.cleanQuery(raw);
    this.searchQuery.set(q);

    if (!q) {
      this.searchResults.set(null);
      return;
    }

    this.http.get<EditorialItem[]>(this.SEARCH_URL, { params: { q, limit: 50 } }).subscribe({
      next: (data) => {
        // a slower, older search must not overwrite a newer one
        if (this.searchQuery() === q) this.searchResults.set(data);
      },
      error: (err) => {
        console.error('Search failed:', err);
        this.errorMessage.set('Search failed on the backend.');
      }
    });
  }


  /**
   * @filters
   */
  private toMonthKey(dateTime: string): string {
    const d = new Date(dateTime);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  setIdBound(which: 'min' | 'max', raw: string): void {
    const n = raw.trim() === '' ? null : Number(raw);
    const val = Number.isFinite(n) ? n : null;
    (which === 'min' ? this.idMin : this.idMax).set(val);
  }

  clearFilters(): void {
    this.idMin.set(null);
    this.idMax.set(null);
    this.categoryFilter.set('');
    this.monthFilter.set('');
  }

  goToPage(index: number): void {
    const clamped = Math.max(0, Math.min(index, this.totalPages() - 1));
    this.pageState.set({ key: this.pageKey(), index: clamped });
  }
  /**
   * @deletion
   * @param id
   */
  toggleSelection(id: number): void {
    const currentSet = new Set(this.selectedIds());
    if (currentSet.has(id)) {
      currentSet.delete(id);
    } else {
      currentSet.add(id);
    }
    this.selectedIds.set(currentSet);
  }

  issueBulkDeletion(): void {
    const idsToDelete = Array.from(this.selectedIds());

    if (idsToDelete.length === 0) return;

    // Send array of IDs to Spring Boot
    this.http.request('delete', this.API_URL2, { body: idsToDelete }).subscribe({
      next: () => { //UI update.
        // Optimistic UI update: filter out deleted items — from the search base too
        this.articles.update(items => items.filter(a => !idsToDelete.includes(a.id)));
        this.searchResults.update(items => items && items.filter(a => !idsToDelete.includes(a.id)));
        this.selectedIds.set(new Set()); // Clear selection
      },
      error: (err) => {
        console.error('Deletion failed', err);
        this.errorMessage.set('Bulk deletion failed on the backend.');
      }
    });
  }

  askDelete(item: EditorialItem): void {
    this.pendingDelete.set(item);
  }

  cancelDelete(): void {
    this.pendingDelete.set(null);
  }

  confirmDelete(): void {
    const target = this.pendingDelete();
    if (!target) return;

    // same endpoint as bulk, one-element array
    this.http.request('delete', this.API_URL2, { body: [target.id] }).subscribe({
      next: () => {
        this.articles.update(items => items.filter(a => a.id !== target.id));
        this.searchResults.update(items => items && items.filter(a => a.id !== target.id));
        // drop it from the bulk selection too, if it was checked
        const sel = new Set(this.selectedIds());
        sel.delete(target.id);
        this.selectedIds.set(sel);
        this.pendingDelete.set(null);
      },
      error: (err) => {
        console.error('Deletion failed', err);
        this.errorMessage.set('Deletion failed on the backend.');
        this.pendingDelete.set(null);
      }
    });
  }

}
