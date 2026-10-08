import { Node, mergeAttributes } from '@tiptap/core';
import { Injector } from '@angular/core';
import { AngularNodeViewRenderer } from 'ngx-tiptap';
import { Subject } from 'rxjs';

import { BlockUIState } from './ingest-block.model';
import { ImageBlockComponent } from './image-block.component';
import { VideoBlockComponent } from './video-block.component';

/**
 * What a media node view needs from the ingest component: upload state that
 * must NOT live in the document (progress, preview, the File), a channel to
 * hear about changes to it, and the upload entry points.
 */
export interface MediaHost {
  uiState: Map<string, BlockUIState>;
  uiChanged: Subject<string>;
  onImageSelected(event: Event, localId: string): void;
  onVideoSelected(event: Event, localId: string): void;
}

export interface MediaNodeOptions {
  host: MediaHost | null;
  injector: Injector | null;
}

/**
 * Same four fields as a content_blocks media entry (minus type/order_id,
 * which come from the node's type and position). Defaults are null so an
 * untouched field goes back to the wire as null, exactly as stored now.
 *
 * localId is never rendered to HTML, and every parse mints a fresh one: an
 * image copied and pasted inside the editor must not share an id (and
 * therefore upload state) with the original.
 */
const mediaAttributes = () => ({
  localId: {
    default: null,
    parseHTML: () => crypto.randomUUID(),
    renderHTML: () => ({})
  },
  url: {
    default: null,
    parseHTML: (el: HTMLElement) => el.getAttribute('data-url'),
    renderHTML: (a: Record<string, any>) => (a['url'] != null ? { 'data-url': a['url'] } : {})
  },
  caption: {
    default: null,
    parseHTML: (el: HTMLElement) => el.getAttribute('data-caption'),
    renderHTML: (a: Record<string, any>) => (a['caption'] != null ? { 'data-caption': a['caption'] } : {})
  },
  align: {
    default: null,
    parseHTML: (el: HTMLElement) => el.getAttribute('data-align'),
    renderHTML: (a: Record<string, any>) => (a['align'] != null ? { 'data-align': a['align'] } : {})
  }
});

export const ImageBlock = Node.create<MediaNodeOptions>({
  name: 'imageBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return { host: null, injector: null };
  },

  addAttributes() {
    return mediaAttributes();
  },

  parseHTML() {
    return [{ tag: 'figure[data-image-block]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    return ['figure', mergeAttributes(HTMLAttributes, { 'data-image-block': '' }),
      ['img', { src: node.attrs['url'] ?? '' }]];
  },

  addNodeView() {
    return AngularNodeViewRenderer(ImageBlockComponent, { injector: this.options.injector! });
  }
});

export const VideoBlock = Node.create<MediaNodeOptions>({
  name: 'videoBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return { host: null, injector: null };
  },

  addAttributes() {
    return mediaAttributes();
  },

  parseHTML() {
    return [{ tag: 'figure[data-video-block]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    return ['figure', mergeAttributes(HTMLAttributes, { 'data-video-block': '' }),
      ['video', { src: node.attrs['url'] ?? '', controls: '' }]];
  },

  addNodeView() {
    return AngularNodeViewRenderer(VideoBlockComponent, { injector: this.options.injector! });
  }
});
