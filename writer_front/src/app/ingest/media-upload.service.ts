import { Injectable } from '@angular/core';
import { HttpClient, HttpEventType } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class MediaUploadService {
  private readonly CHUNK_SIZE = 10 * 1024 * 1024;
  private readonly baseURL = `http://${window.location.hostname}:9000/api`;
  private readonly mediaHost = `http://${window.location.hostname}:8080/media`;

  constructor(private http: HttpClient) {}

  uploadImage(file: File, onProgress?: (pct: number) => void): Promise<string> {
    const formData = new FormData();
    formData.append('image', file);

    return new Promise((resolve, reject) => {
      this.http.post(`${this.baseURL}/ingest/image-upload`, formData, {
        reportProgress: true, observe: 'events'
      }).subscribe({
        next: (event: any) => {
          if (event.type === HttpEventType.UploadProgress && event.total) {
            onProgress?.(Math.round((100 * event.loaded) / event.total));
          } else if (event.type === HttpEventType.Response) {
            resolve(`${this.mediaHost}/${file.name}`);
          }
        },
        error: reject
      });
    });
  }

  async uploadVideoChunked(file: File, onProgress?: (pct: number) => void): Promise<string> {
    const totalChunks = Math.ceil(file.size / this.CHUNK_SIZE);
    for (let i = 0; i < totalChunks; i++) {
      const chunk = file.slice(i * this.CHUNK_SIZE, Math.min((i + 1) * this.CHUNK_SIZE, file.size));
      const formData = new FormData();
      formData.append('chunk', chunk);
      formData.append('chunkIndex', i.toString());
      formData.append('totalChunks', totalChunks.toString());
      formData.append('fileName', file.name);

      await firstValueFrom(this.http.post(`${this.baseURL}/ingest/video-chunk`, formData));
      onProgress?.(Math.round(((i + 1) / totalChunks) * 100));
    }
    return `${this.mediaHost}/${file.name}`;
  }

  // For a pasted <img src="https://external..."> — fetch and re-host through
  // our own upload pipeline rather than persisting a foreign URL long-term.
  async fetchRemoteAsFile(url: string): Promise<File> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch pasted image: ${res.status}`);
    const blob = await res.blob();
    const ext = blob.type.split('/')[1] || 'png';
    return new File([blob], `pasted-${Date.now()}.${ext}`, { type: blob.type });
  }
}
