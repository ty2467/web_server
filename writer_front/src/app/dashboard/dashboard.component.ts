import { Component, OnInit, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
/** use formbuilder for update. duh*/
import { FormBuilder, FormGroup, ReactiveFormsModule } from '@angular/forms';
import {Router} from '@angular/router';


// Define the shape based on your SQL schema
interface EditorialItem {
  id: number;
  title: string;
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
  private readonly serverIP: string = window.location.hostname;
  private readonly port: string = '9000'; //http://ip:9000

  public readonly baseURL: string = `http://${this.serverIP}:${this.port}/api`;
  private readonly API_URL = this.baseURL + "/articles/summary"; //api/articles/summary';
  private readonly API_URL2 = this.baseURL +"/delete"; ///api/delete';
  /** modify dashboard objects */
  readonly selectedIds = signal<Set<number>>(new Set());


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
        // Optimistic UI update: filter out deleted items
        this.articles.update(items => items.filter(a => !idsToDelete.includes(a.id)));
        this.selectedIds.set(new Set()); // Clear selection
      },
      error: (err) => {
        console.error('Deletion failed', err);
        this.errorMessage.set('Bulk deletion failed on the backend.');
      }
    });
  }









}
