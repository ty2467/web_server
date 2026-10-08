import { Component, ChangeDetectorRef, OnInit, OnDestroy, inject } from '@angular/core';
import { AngularNodeViewComponent } from 'ngx-tiptap';
import { Subscription } from 'rxjs';

import type { MediaHost } from './media-nodes';
import { BlockUIState, ImageAlign } from './ingest-block.model';

/**
 * The old image block markup, now rendered by ProseMirror as a node view.
 * Uses ingest.component.css directly: Angular scopes a component's styles to
 * its own template, so the node view has to load the same sheet to get them.
 */
@Component({
  selector: 'app-image-block',
  standalone: true,
  styleUrls: ['./ingest.component.css'],
  template: `
    <div class="block-unit">
      <div class="drag-gutter" data-drag-handle>
        <span class="drag-handle">⠿</span>
      </div>

      <div class="media-container">
        <div class="image-uploader" (click)="imgInput.click()" [class.processing]="state?.isUploading">
          @if (src) {
            <img [src]="src">
          }
          @if (state?.isUploading) {
            <div class="progress-container">
              <div class="progress-bar" [style.width.%]="state?.progress"></div>
              <span class="progress-text">{{ state?.progress }}%</span>
            </div>
          }
          @if (!src && !state?.isUploading) {
            <div class="upload-prompt">+ Add Image</div>
          }
        </div>

        <div class="media-controls">
          <div class="align-group">
            <button type="button" title="Align caption left" [class.is-active]="align === 'left'" (click)="setAlign('left')">←</button>
            <button type="button" title="Align caption center" [class.is-active]="align === 'center'" (click)="setAlign('center')">↔</button>
            <button type="button" title="Align caption right" [class.is-active]="align === 'right'" (click)="setAlign('right')">→</button>
          </div>
          <input type="text" class="caption-input" placeholder="Caption (optional)"
                 [value]="caption"
                 [style.textAlign]="align"
                 (input)="setCaption($event)">
        </div>

        <input type="file" #imgInput (change)="host.onImageSelected($event, id)" hidden accept="image/*">
        <button type="button" class="remove-media" (click)="remove()">✕</button>
      </div>
    </div>
  `
})
export class ImageBlockComponent extends AngularNodeViewComponent implements OnInit, OnDestroy {
  private cdr = inject(ChangeDetectorRef);
  private sub?: Subscription;

  get host(): MediaHost { return (this.extension().options as any).host; }
  get id(): string { return this.node().attrs['localId']; }
  get state(): BlockUIState | undefined { return this.host.uiState.get(this.id); }
  get src(): string | null { return this.state?.previewUrl || this.node().attrs['url'] || null; }
  get caption(): string { return this.node().attrs['caption'] ?? ''; }
  get align(): ImageAlign { return this.node().attrs['align'] ?? 'center'; }

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

  setAlign(align: ImageAlign) {
    this.updateAttributes()({ align });
  }

  remove() {
    this.deleteNode()();
  }
}
