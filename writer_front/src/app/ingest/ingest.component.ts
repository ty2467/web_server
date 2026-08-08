import { Component, OnInit, OnDestroy, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormGroup, FormControl, Validators } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Params } from '@angular/router';
import { CdkDragDrop, moveItemInArray, DragDropModule } from '@angular/cdk/drag-drop';

import { TiptapEditorDirective } from 'ngx-tiptap';
import { Editor, Extensions, JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Underline from '@tiptap/extension-underline';

import {
  Block, ParagraphBlock, BlockType, BlockUIState, ImageAlign,
  emptyUIState, newBlock, blockToDto, dtoToBlock, isParagraph
} from './ingest-block.model';
import { parseClipboardToBlockSeeds } from './paste.util';
import { MediaUploadService } from './media-upload.service';

@Component({
  selector: 'app-ingest',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, TiptapEditorDirective, DragDropModule],
  templateUrl: './ingest.component.html',
  styleUrls: ['./ingest.component.css']
})
export class IngestComponent implements OnInit, OnDestroy {
  metaForm!: FormGroup;
  status = '';
  isSuccess = false;
  editingId: string | null = null;

  // ---- Canonical content model + its two localId-keyed projections ----
  blocks: Block[] = [];
  editors: Map<string, Editor> = new Map();
  uiState: Map<string, BlockUIState> = new Map();

  // Lead image — article-level metadata, like title/author/category, NOT a
  // content block. lead_image_url/lead_image_caption live in metaForm like
  // the other scalar fields; only upload progress/preview need separate
  // state here since a FormControl alone can't represent "uploading".
  leadImagePreview: string | null = null;
  leadImageUploading = false;
  leadImageProgress = 0;

  private readonly extensions: Extensions = [
    StarterKit,
    Underline,
    Link.configure({ openOnClick: false }),
    Placeholder.configure({ placeholder: 'Type something or paste content...' })
  ];

  private readonly baseURL = `http://${window.location.hostname}:9000/api`;
  private readonly API_URL = `${this.baseURL}/ingest`;

  private route = inject(ActivatedRoute);

  constructor(
    private http: HttpClient,
    private cdr: ChangeDetectorRef,
    private mediaUpload: MediaUploadService
  ) {}

  ngOnInit() {
    // Only scalar, fixed-shape fields live in Reactive Forms. content_blocks
    // is dynamic and index-sensitive in a way FormArray actively fights —
    // it stays a plain array, assembled into the payload at submit time.
    this.metaForm = new FormGroup({
      id: new FormControl<number | null>(null),
      title: new FormControl('', [Validators.required]),
      summary: new FormControl(''),
      author: new FormControl(''),
      category: new FormControl('', [Validators.required]),
      date_time: new FormControl(this.getCurrentDateTime()),
      section_zone: new FormControl('', [Validators.required]),
      intra_section_zone: new FormControl<number | null>(null, [Validators.min(0), Validators.max(255)]),
      lead_image_url: new FormControl(''),
      lead_image_caption: new FormControl('')
    });
    // Keep 排列 (intra_section_zone) in sync with 位置 (section_zone): whenever
    // the zone changes to something that doesn't offer the currently-selected
    // permutation (or offers none at all — column/no zone), clear it instead
    // of leaving a now-invalid stored number sitting in the form.
    this.metaForm.get('section_zone')!.valueChanges.subscribe(() => this.syncIntraZoneValidity());
    this.syncIntraZoneValidity(); // apply once for the initial (empty) zone


    this.route.queryParams.subscribe((params: Params) => {
      this.clearAllBlocks();
      const idFromUrl = params['edit'];
      if (idFromUrl) {
        this.editingId = idFromUrl;
        this.loadArticleForEdit(idFromUrl);
      } else {
        this.editingId = null;
        this.metaForm.reset({ date_time: this.getCurrentDateTime() });
        this.leadImagePreview = null;
        this.insertBlock('paragraph', null);
      }
    });
  }

  private syncIntraZoneValidity() {
    const zone = this.metaForm.get('section_zone')!.value;
    const intraCtrl = this.metaForm.get('intra_section_zone')!;

    const stillValid = this.intraSectionZoneOptions.some(opt => opt.value === intraCtrl.value);
    if (!stillValid) intraCtrl.setValue(null, { emitEvent: false });

    const validators = [Validators.min(0), Validators.max(255)];
    if (zone !== 'column') validators.push(Validators.required);
    intraCtrl.setValidators(validators);
    intraCtrl.updateValueAndValidity({ emitEvent: false });
  }
  ngOnDestroy() {
    this.editors.forEach(ed => ed.destroy());
  }

  getCurrentDateTime(): string {
    const now = new Date();
    return new Date(now.getTime() - 7 * 60 * 60 * 1000).toISOString().slice(0, 16);
  }

  // Fixed publication categories — the template renders these as a dropdown
  // so editors can't free-type a variant that won't match on the read side.
  readonly categories: string[] = [
    '美洲头条', '美国观察', '工商新闻', '天天话题', '非常美洲', '精英访谈', 'CES 国际消费电子展'
  ];

  // ===========================================================================
  // 位置 (section_zone) / 排列 (intra_section_zone) — display config.
  // Stored values are stable English keys / fixed numbers; only the labels
  // shown in the dropdowns are Chinese. This keeps the DB-facing shape of
  // metaForm untouched while making the UI unambiguous to click through.
  // ===========================================================================

  readonly sectionZoneOptions: { value: string; label: string }[] = [
    { value: 'main',     label: '主板' },   // zhu ye — main page
    { value: 'sub_main',  label: '次板' }, // ci zhu ye — major front
    { value: 'tertiary',  label: '三版' },   // san ban — half front
    { value: 'column',    label: '栏目' }    // lan mu — columns
  ];

  // Fixed numeric encoding, independent of which subset is offered:
  // 0 = center, 1 = side, 2 = bottom.
  private readonly intraFull: { value: number; label: string }[] = [
    { value: 0, label: '中心' }, // zhong xin — center
    { value: 1, label: '侧' },   // ce — side
    { value: 2, label: '底' }    // di — bottom
  ];
  private readonly intraNoBottom = this.intraFull.slice(0, 2); // center, side only

  get intraSectionZoneOptions(): { value: number; label: string }[] {
    const zone = this.metaForm?.get('section_zone')?.value;
    if (zone === 'main' || zone === 'sub_main') return this.intraFull;
    if (zone === 'tertiary') return this.intraNoBottom;
    return []; // no zone selected yet, or 'column' — field is disabled
  }

  get intraSectionZoneDisabled(): boolean {
    const zone = this.metaForm?.get('section_zone')?.value;
    return !zone || zone === 'column';
  }

  get lastBlockId(): string | null {
    return this.blocks.length ? this.blocks[this.blocks.length - 1].localId : null;
  }

  // ===========================================================================
  // Reconciliation — the ONLY methods allowed to mutate `blocks`, `editors`,
  // or `uiState`. Paste, typing, uploads, and drag/drop all route through
  // these instead of touching the three structures directly.
  // ===========================================================================

  private findIndex(localId: string): number {
    return this.blocks.findIndex(b => b.localId === localId);
  }

  findBlock(localId: string): Block | undefined {
    return this.blocks.find(b => b.localId === localId);
  }

  insertBlock(type: BlockType, afterLocalId: string | null, seed?: { json?: JSONContent; url?: string; caption?: string; align?: ImageAlign }): Block {
    const block = newBlock(type, 0, seed);
    const insertAt = afterLocalId ? this.findIndex(afterLocalId) + 1 : this.blocks.length;
    this.blocks.splice(insertAt, 0, block);

    this.uiState.set(block.localId, {
      ...emptyUIState(),
      previewUrl: isParagraph(block) ? null : (block.url || null),
      charCount: isParagraph(block) ? this.textLength(block.json) : 0
    });

    if (isParagraph(block)) {
      this.mountEditor(block);
    }

    this.reindex();
    this.cdr.detectChanges();
    return block;
  }

  removeBlock(localId: string) {
    const idx = this.findIndex(localId);
    if (idx === -1) return;

    this.editors.get(localId)?.destroy();
    this.editors.delete(localId);
    this.uiState.delete(localId);
    this.blocks.splice(idx, 1);

    // Never let the canvas go fully empty — nothing to click into, nowhere
    // for a cursor to land. insertBlock already reindexes/detects changes,
    // so return rather than doing it twice.
    if (this.blocks.length === 0) {
      const fresh = this.insertBlock('paragraph', null);
      setTimeout(() => this.focusBlock(fresh.localId), 10);
      return;
    }

    this.reindex();
    this.cdr.detectChanges();
  }

  moveBlock(previousIndex: number, currentIndex: number) {
    if (previousIndex === currentIndex) return;
    moveItemInArray(this.blocks, previousIndex, currentIndex);
    this.reindex();
    this.cdr.detectChanges();
  }

  private reindex() {
    this.blocks.forEach((b, i) => (b.orderId = i));
  }

  private clearAllBlocks() {
    this.editors.forEach(ed => ed.destroy());
    this.editors.clear();
    this.uiState.clear();
    this.blocks = [];
  }

  private textLength(json: JSONContent): number {
    let len = 0;
    const walk = (node: JSONContent) => {
      if (node.type === 'text') len += (node.text ?? '').length;
      (node.content ?? []).forEach(walk);
    };
    walk(json);
    return len;
  }

  // ===========================================================================
  // Tiptap wiring — JSON in at mount, JSON out on every update. No HTML
  // round-trip. The Editor is disposable; block.json is not.
  // ===========================================================================

  private mountEditor(block: ParagraphBlock) {
    const editor = new Editor({
      extensions: this.extensions,
      content: block.json,
      onUpdate: ({ editor }) => {
        const current = this.findBlock(block.localId);
        if (current && isParagraph(current)) {
          current.json = editor.getJSON();
          const state = this.uiState.get(block.localId);
          if (state) state.charCount = editor.getText().length;
        }
      },
      editorProps: {
        // `view`/`event` typed loosely here — exact ProseMirror view import
        // path can shift between Tiptap versions; the shape used is stable.
        handleKeyDown: (view: any, event: KeyboardEvent) =>
          this.handleEditorKeyDown(block.localId, view, event),
        handlePaste: (_view: any, event: ClipboardEvent) => {
          this.handlePaste(event, block.localId);
          return true;
        }
      }
    });
    this.editors.set(block.localId, editor);
  }

  private handleEditorKeyDown(localId: string, view: any, event: KeyboardEvent): boolean {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const idx = this.findIndex(localId);
      const next = this.blocks[idx + 1];
      if (next && isParagraph(next)) {
        this.focusBlock(next.localId);
      } else {
        const created = this.insertBlock('paragraph', localId);
        setTimeout(() => this.focusBlock(created.localId), 10);
      }
      return true;
    }

    if (event.key === 'Backspace' && view.state.doc.textContent.length === 0) {
      const idx = this.findIndex(localId);
      const prev = this.blocks[idx - 1];
      if (prev) {
        this.removeBlock(localId);
        setTimeout(() => this.focusBlock(prev.localId), 10);
        return true;
      }
    }
    return false;
  }

  focusBlock(localId: string, position: 'start' | 'end' = 'start') {
    const editor = this.editors.get(localId);
    if (editor) {
      editor.commands.focus(position);
    } else {
      setTimeout(() => this.editors.get(localId)?.commands.focus(position), 50);
    }
  }

  setLink(editor: Editor) {
    const previousUrl = editor.getAttributes('link')['href'];
    const url = window.prompt('URL', previousUrl);
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }

  // ===========================================================================
  // Paste — fully buffered. parseClipboardToBlockSeeds is pure and returns
  // real ProseMirror JSON for text plus flags for images that still need a
  // network round trip (a remote URL, or raw file data from the clipboard).
  // ===========================================================================

  handlePaste(event: ClipboardEvent, afterLocalId: string) {
    const seeds = parseClipboardToBlockSeeds(event, this.extensions);
    let anchor = afterLocalId;

    for (const seed of seeds) {
      if (seed.kind === 'paragraph') {
        const block = this.insertBlock('paragraph', anchor, { json: seed.json });
        anchor = block.localId;
      } else {
        const block = this.insertBlock('image', anchor, { url: seed.remoteUrl ?? '', caption: seed.caption ?? '' });
        anchor = block.localId;
        this.resolvePastedImage(block.localId, seed.sourceFile, seed.remoteUrl);
      }
    }
  }

  // Lazy image resolution: the block is already visible (with a temporary
  // preview) before any network activity resolves.
  private async resolvePastedImage(localId: string, sourceFile: File | null, remoteUrl: string | null) {
    const state = this.uiState.get(localId);
    if (!state) return;
    try {
      state.isUploading = true;
      this.cdr.detectChanges();

      const file = sourceFile ?? (remoteUrl ? await this.mediaUpload.fetchRemoteAsFile(remoteUrl) : null);
      if (!file) return;

      state.file = file;
      const reader = new FileReader();
      reader.onload = () => { state.previewUrl = reader.result as string; this.cdr.detectChanges(); };
      reader.readAsDataURL(file);

      const url = await this.mediaUpload.uploadImage(file, pct => {
        state.progress = pct;
        this.cdr.detectChanges();
      });

      const block = this.findBlock(localId);
      if (block && !isParagraph(block)) block.url = url;
      this.status = '';
    } catch (err: any) {
      this.status = 'Image paste failed: ' + (err?.message || err?.statusText || 'unknown error');
    } finally {
      state.isUploading = false;
      this.cdr.detectChanges();
    }
  }

  // ===========================================================================
  // Lead image — article-level, singular, lives in metaForm not blocks[].
  // Same upload service as content-block images; no align (not requested).
  // ===========================================================================

  onLeadImageSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) this.uploadLeadImage(file);
  }

  private async uploadLeadImage(file: File) {
    this.leadImageUploading = true;
    const reader = new FileReader();
    reader.onload = () => { this.leadImagePreview = reader.result as string; this.cdr.detectChanges(); };
    reader.readAsDataURL(file);

    try {
      const url = await this.mediaUpload.uploadImage(file, pct => {
        this.leadImageProgress = pct;
        this.cdr.detectChanges();
      });
      this.metaForm.patchValue({ lead_image_url: url });
      this.status = '';
    } catch (err: any) {
      this.status = 'Lead image upload failed: ' + (err?.message || err?.statusText || 'unknown error');
    } finally {
      this.leadImageUploading = false;
      this.cdr.detectChanges();
    }
  }

  removeLeadImage() {
    this.metaForm.patchValue({ lead_image_url: '', lead_image_caption: '' });
    this.leadImagePreview = null;
  }

  // ===========================================================================
  // Direct media selection (file inputs)
  // ===========================================================================

  onImageSelected(event: Event, localId: string) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) this.uploadImageForBlock(file, localId);
  }

  private async uploadImageForBlock(file: File, localId: string) {
    const state = this.uiState.get(localId);
    if (!state) return;

    state.file = file;
    state.isUploading = true;
    const reader = new FileReader();
    reader.onload = () => { state.previewUrl = reader.result as string; this.cdr.detectChanges(); };
    reader.readAsDataURL(file);

    try {
      const url = await this.mediaUpload.uploadImage(file, pct => {
        state.progress = pct;
        this.cdr.detectChanges();
      });
      const block = this.findBlock(localId);
      if (block && !isParagraph(block)) block.url = url;
      this.status = '';
    } catch (err: any) {
      this.status = 'Upload failed: ' + (err?.message || err?.statusText || 'unknown error');
    } finally {
      state.isUploading = false;
      this.cdr.detectChanges();
    }
  }

  async onVideoSelected(event: Event, localId: string) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const state = this.uiState.get(localId);
    if (!state) return;

    state.file = file;
    state.isUploading = true;
    try {
      const url = await this.mediaUpload.uploadVideoChunked(file, pct => {
        state.progress = pct;
        this.cdr.detectChanges();
      });
      const block = this.findBlock(localId);
      if (block && !isParagraph(block)) block.url = url;
      this.status = '';
    } catch (err: any) {
      this.status = 'Video upload failed: ' + (err?.message || err?.statusText || 'unknown error');
    } finally {
      state.isUploading = false;
      this.cdr.detectChanges();
    }
  }

  // ===========================================================================
  // Drag/drop — only the order changes. editors/uiState are keyed by
  // localId, so they never need remapping when position changes.
  // ===========================================================================

  drop(event: CdkDragDrop<Block[]>) {
    this.moveBlock(event.previousIndex, event.currentIndex);
  }

  // ===========================================================================
  // Load / submit — the only two places that cross the DB boundary.
  // ===========================================================================

  loadArticleForEdit(id: string) {
    this.http.get<any>(`${this.baseURL}/articles/${id}`).subscribe(data => {
      this.metaForm.patchValue({
        id: data.id,
        title: data.title,
        summary: data.summary,
        author: data.author,
        category: data.category,
        date_time: data.date_time,
        section_zone: data.section_zone,
        intra_section_zone: data.intra_section_zone,
        lead_image_url: data.lead_image_url,
        lead_image_caption: data.lead_image_caption
      });
      this.leadImagePreview = data.lead_image_url || null;

      this.clearAllBlocks();

      const dtos = (data.content_blocks ?? []).slice()
        .sort((a: any, b: any) => a.order_id - b.order_id);

      if (dtos.length > 0) {
        for (const dto of dtos) {
          const block = dtoToBlock(dto);
          this.blocks.push(block);
          this.uiState.set(block.localId, {
            ...emptyUIState(),
            previewUrl: isParagraph(block) ? null : block.url,
            charCount: isParagraph(block) ? this.textLength(block.json) : 0
          });
          if (isParagraph(block)) this.mountEditor(block);
        }
        this.reindex();
      } else {
        this.insertBlock('paragraph', null);
      }

      this.cdr.detectChanges();
    });
  }

  submit() {
    if (!this.metaForm.valid) return;

    const payload = {
      ...this.metaForm.value,
      content_blocks: this.blocks.map(blockToDto)
    };

    this.http.post(this.API_URL, payload).subscribe({
      next: () => {
        this.status = 'Success!';
        this.isSuccess = true;
        if (!this.editingId) this.resetForm();
      },
      error: () => { this.status = 'Submission failed.'; }
    });
  }

  private resetForm() {
    this.clearAllBlocks();
    this.metaForm.reset({ date_time: this.getCurrentDateTime() });
    this.leadImagePreview = null;
    this.insertBlock('paragraph', null);
  }

  trackByLocalId(_index: number, block: Block) {
    return block.localId;
  }

  captionOf(block: Block): string {
    return isParagraph(block) ? '' : block.caption;
  }

  onCaptionInput(event: Event, localId: string) {
    const value = (event.target as HTMLInputElement).value;
    const block = this.findBlock(localId);
    if (block && !isParagraph(block)) block.caption = value;
  }

  alignOf(block: Block): ImageAlign {
    return isParagraph(block) ? 'center' : block.align;
  }

  setAlign(localId: string, align: ImageAlign) {
    const block = this.findBlock(localId);
    if (block && !isParagraph(block)) block.align = align;
  }

  get isAnyBlockUploading(): boolean {
    return Array.from(this.uiState.values()).some(s => s.isUploading);
  }
}
