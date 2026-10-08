import { Component, ChangeDetectorRef, OnInit, OnDestroy, inject } from '@angular/core';
import { AngularNodeViewComponent } from 'ngx-tiptap';
import { Subscription } from 'rxjs';

import type { MediaHost } from './media-nodes';
import { BlockUIState } from './ingest-block.model';

/**
 * The old video block markup as a node view. preview is the stored public
 * URL on a reloaded article and the freshly-uploaded URL otherwise, so both
 * look identical. The player stops its own clicks from reopening the picker;
 * preload="metadata" fetches the header, not the file.
 */
@Component({
  selector: 'app-video-block',
  standalone: true,
  styleUrls: ['./ingest.component.css'],
  template: `
    <div class="block-unit">
      <div class="drag-gutter" data-drag-handle>
        <span class="drag-handle">⠿</span>
      </div>

      <div class="media-container">
        <div class="video-uploader"
             [class.has-media]="src"
             [class.processing]="state?.isUploading"
             (click)="vidInput.click()">

          @if (src) {
            <video [src]="src" class="video-preview" controls preload="metadata"
                   (click)="$event.stopPropagation()"></video>
          }
          @if (!src && !state?.isUploading) {
            <div class="upload-prompt">+ Select Video</div>
          }
          @if (state?.isUploading) {
            <div class="progress-container">
              <div class="progress-bar" [style.width.%]="state?.progress"></div>
              <span class="progress-text">{{ state?.progress }}%</span>
            </div>
          }
        </div>

        @if (src) {
          <div class="media-controls">
            <span class="video-name">🎥 {{ fileName }}</span>
            <button type="button" class="replace-media" (click)="vidInput.click()">Replace</button>
            <input type="text" class="caption-input" placeholder="Caption (optional)"
                   [value]="caption"
                   (input)="setCaption($event)">
          </div>
        }

        <input type="file" #vidInput (change)="host.onVideoSelected($event, id)" hidden accept="video/*">
        <button type="button" class="remove-media" (click)="remove()">✕</button>
      </div>
    </div>
  `
})
export class VideoBlockComponent extends AngularNodeViewComponent implements OnInit, OnDestroy {
  private cdr = inject(ChangeDetectorRef);
  private sub?: Subscription;

  get host(): MediaHost { return (this.extension().options as any).host; }
  get id(): string { return this.node().attrs['localId']; }
  get state(): BlockUIState | undefined { return this.host.uiState.get(this.id); }
  get src(): string | null { return this.state?.previewUrl || this.node().attrs['url'] || null; }
  get caption(): string { return this.node().attrs['caption'] ?? ''; }

  /** Filename tail of the media URL, for the label. */
  get fileName(): string {
    const url = this.src;
    return url ? url.substring(url.lastIndexOf('/') + 1) : '';
  }

  ngOnInit() {
    this.sub = this.host.uiChanged.subscribe(id => {
      if (id === this.id) this.cdr.detectChanges();
    });
  }

  ngOnDestroy() {
    this.sub?.unsubscribe();
  }

  setCaption(event: Event) {
    this.updateAttributes()({ caption: (event.target as HTMLInputElement).value });
  }

  remove() {
    this.deleteNode()();
  }
}
