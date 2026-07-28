import { Component, Input, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-delayed-media',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="media-container-wrapper" [ngClass]="customClass">
      <div *ngIf="!isLoaded()" class="media-placeholder">
        <div class="loading-spinner"></div>
        <span>LOADING...</span>
      </div>

      <img *ngIf="type === 'image' && readyToFetch()"
           [src]="src"
           [alt]="alt"
           (load)="onMediaLoad()"
           [style.opacity]="isLoaded() ? 1 : 0"
           class="media-element">

      <video *ngIf="type === 'video' && readyToFetch()"
             [src]="src"
             autoplay muted loop playsinline
             (loadeddata)="onMediaLoad()"
             [style.opacity]="isLoaded() ? 1 : 0"
             class="media-element">
      </video>
    </div>
  `,
  styles: [`
    .media-container-wrapper {
      position: relative;
      width: 100%;
      height: 100%;
      background: #f4f4f4;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .media-placeholder {
      position: absolute;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      color: #ee812b;
      font-weight: bold;
      font-size: 12px;
      z-index: 2;
    }
    .loading-spinner {
      width: 20px;
      height: 20px;
      border: 2px solid #ddd;
      border-top: 2px solid #ee812b;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    .media-element {
      width: 100%;
      height: 100%;
      object-fit: contain;
      transition: opacity 0.5s ease-in-out;
    }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  `]
})
export class DelayedMediaComponent implements OnInit {
  @Input() src: string | undefined = '';
  @Input() type: 'image' | 'video' = 'image';
  @Input() alt: string = '';
  @Input() customClass: string = '';

  // Controls when the [src] is actually bound to the DOM
  readyToFetch = signal(false);
  // Controls when the "Loading" placeholder disappears
  isLoaded = signal(false);

  ngOnInit() {
    // A 100ms delay ensures the browser processes the metadata/text DOM nodes
    // and starts rendering them before the media request begins.
    setTimeout(() => {
      this.readyToFetch.set(true);
    }, 100);
  }

  onMediaLoad() {
    this.isLoaded.set(true);
  }
}
