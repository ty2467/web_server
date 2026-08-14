import { Component, OnInit, OnDestroy, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  ReactiveFormsModule, FormGroup, FormControl, Validators,
  AbstractControl, ValidationErrors
} from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Params } from '@angular/router';
import { CdkDragDrop, moveItemInArray, DragDropModule } from '@angular/cdk/drag-drop';

import { TiptapEditorDirective } from 'ngx-tiptap';
import { Editor, Extensions, JSONContent } from '@tiptap/core';
import { TextStyle, FontSize } from '@tiptap/extension-text-style';
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

/** 位置 — the three mutually-exclusive fronts. 栏目 is not one of these. */
export type ZoneFront = 'main' | 'sub_main' | 'tertiary';

/**
 * section_zone used to be one required <select>. It is now a MariaDB SET,
 * and the UI splits it into a radio group (the fronts, mutually exclusive
 * by construction) plus a checkbox (栏目, which combines with a front).
 * "At least one placement" therefore becomes a group-level rule rather
 * than a control-level one.
 */
function zonePicked(g: AbstractControl): ValidationErrors | null {
  return (g.get('front')?.value || g.get('in_column')?.value) ? null : { zoneRequired: true };
}

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
    Placeholder.configure({ placeholder: 'Type something or paste content...' }),
    TextStyle,
    FontSize
  ];

  readonly fontSizes: string[] = ['12px', '14px', '16px', '18px', '20px', '24px', '30px', '36px', '48px'];

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
      front: new FormControl<ZoneFront | null>(null),
      in_column: new FormControl(false),
      intra_section_zone: new FormControl<number | null>(null, [Validators.min(0), Validators.max(255)]),
      lead_image_url: new FormControl(''),
      lead_image_caption: new FormControl(''),
      view_count: new FormControl<number>(0, [Validators.min(0), Validators.max(4294967295)]),
    }, { validators: zonePicked });

    // ONE rule, ONE place. Previously this subscription hand-inlined half of
    // syncIntraZoneValidity() while the method itself was never called from
    // anywhere — so the required-validator half of the rule never ran and
    // 排列 could be left blank on a front. The subscription now delegates.
    this.metaForm.get('front')!.valueChanges.subscribe(() => this.syncIntraZoneValidity());
    this.syncIntraZoneValidity();

    this.route.queryParams.subscribe((params: Params) => {
      this.clearAllBlocks();
      const idFromUrl = params['edit'];
      if (idFromUrl) {
        this.editingId = idFromUrl;
        this.loadArticleForEdit(idFromUrl);
      } else {
        this.editingId = null;
        this.resetMetaForm();
        this.leadImagePreview = null;
        this.insertBlock('paragraph', null);
      }
    });
  }

  ngOnDestroy() {
    this.editors.forEach(ed => ed.destroy());
  }

  // ===========================================================================
  // 位置 (section_zone) / 排列 (intra_section_zone)
  //
  // Stored values are stable English keys / fixed numbers; only the labels
  // shown in the UI are Chinese. section_zone leaves this component as the
  // comma string the SET column takes ('sub_main,column'); nothing between
  // the radio and the POST knows that string exists.
  // ===========================================================================

  readonly frontOptions: { value: ZoneFront; label: string }[] = [
    { value: 'main',     label: '主板' },
    { value: 'sub_main', label: '次板' },
    { value: 'tertiary', label: '三版' }
  ];

  // Fixed numeric encoding, independent of which subset is offered:
  // 0 = 中心, 1 = 侧, 2 = 底.
  private readonly intraFull: { value: number; label: string }[] = [
    { value: 0, label: '中心' },
    { value: 1, label: '侧' },
    { value: 2, label: '底' }
  ];
  private readonly intraNoBottom = this.intraFull.slice(0, 2); // 中心, 侧 only

  get intraSectionZoneOptions(): { value: number; label: string }[] {
    const front = this.metaForm?.get('front')?.value;
    if (front === 'main' || front === 'sub_main') return this.intraFull;
    if (front === 'tertiary') return this.intraNoBottom;
    return []; // 栏目-only, or nothing picked yet — 排列 has no meaning
  }

  get intraSectionZoneDisabled(): boolean {
    return !this.metaForm?.get('front')?.value;
  }

  /**
   * Keeps 排列 consistent with 位置: drops a now-unofferable value, and
   * makes the field required exactly when a front is selected. Disabled
   * state is driven from the control rather than a template [disabled]
   * binding — a disabled control is omitted from form.value entirely, so
   * the two must not be allowed to disagree.
   */
  private syncIntraZoneValidity() {
    const front = this.metaForm.get('front')!.value;
    const intraCtrl = this.metaForm.get('intra_section_zone')!;

    const stillValid = this.intraSectionZoneOptions.some(opt => opt.value === intraCtrl.value);
    if (!stillValid) intraCtrl.setValue(null, { emitEvent: false });

    const validators = [Validators.min(0), Validators.max(255)];
    if (front) validators.push(Validators.required);
    intraCtrl.setValidators(validators);

    if (front) intraCtrl.enable({ emitEvent: false });
    else intraCtrl.disable({ emitEvent: false });

    intraCtrl.updateValueAndValidity({ emitEvent: false });
  }

  /** front + in_column -> the SET string. Called once, at submit. */
  private buildSectionZone(): string {
    const v = this.metaForm.getRawValue();
    return [v.front, v.in_column ? 'column' : null].filter(Boolean).join(',');
  }

  /** The SET string -> front + in_column. Called once, on edit load. */
  private applySectionZone(sz: string | null) {
    const parts = (sz ?? '').split(',').map(s => s.trim()).filter(Boolean);
    this.metaForm.patchValue({
      front: (parts.find(p => p !== 'column') as ZoneFront) ?? null,
      in_column: parts.includes('column')
    });
  }

  private resetMetaForm() {
    // Explicit zone defaults: a bare reset() sets in_column to null rather
    // than false, which desyncs the checkbox from the control.
    this.metaForm.reset({
      date_time: this.getCurrentDateTime(),
      front: null,
      in_column: false,
      view_count: 0
    });
    this.syncIntraZoneValidity();
  }

  /**
   * <input type="datetime-local"> wants local wall-clock time as
   * 'yyyy-MM-ddTHH:mm'. Built from local date parts rather than by
   * subtracting a hardcoded 7h from UTC — that offset is only correct
   * during PDT and silently drifts an hour every November.
   */
  getCurrentDateTime(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
      `T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }

  // Fixed publication categories — the template renders these as a dropdown
  // so editors can't free-type a variant that won't match on the read side.
  readonly categories: string[] = [
    '美洲头条', '美国观察', '工商新闻', '天天话题', '非常美洲', '精英访谈', 'CES 国际消费电子展', '场景展示'
  ];
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

  onFontSizeChange(event: Event, editor: Editor) {
    const value = (event.target as HTMLSelectElement).value;
    if (value) {
      editor.chain().focus().setFontSize(value).run();
    } else {
      editor.chain().focus().unsetFontSize().run();
    }
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

      // Point the preview at the uploaded file's public URL, exactly as a
      // reloaded block does. Without this a just-uploaded video renders
      // differently from the same video after a page reload.
      state.previewUrl = url;
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
      // 位置 FIRST: patching front fires syncIntraZoneValidity, which clears
      // 排列 if it isn't offerable. Loading 排列 before the front would
      // therefore wipe the value that was just loaded.
      this.applySectionZone(data.section_zone);

      this.metaForm.patchValue({
        id: data.id,
        title: data.title,
        summary: data.summary,
        author: data.author,
        category: data.category,
        date_time: data.date_time,
        intra_section_zone: data.intra_section_zone,
        lead_image_url: data.lead_image_url,
        view_count: data.view_count ?? 0,
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
            // Images AND videos: previewUrl is the stored public URL. The
            // bytes were never lost — media_url survives the round trip in
            // content_blocks. The video simply had no template branch that
            // read it, so it rendered as an empty picker.
            previewUrl: isParagraph(block) ? null : (block.url || null),
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

    // getRawValue, not value: intra_section_zone is DISABLED whenever no
    // front is picked, and value silently omits disabled controls — the
    // field would vanish from the payload rather than arriving null.
    // front/in_column are UI-side only and must not reach the wire.
    const { front, in_column, ...meta } = this.metaForm.getRawValue();

    const payload = {
      ...meta,
      section_zone: this.buildSectionZone(),
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
    this.resetMetaForm();
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

  /** Filename tail of a stored media URL, for the video block's label. */
  fileNameOf(url: string | null | undefined): string {
    if (!url) return '';
    return url.substring(url.lastIndexOf('/') + 1);
  }

  get isAnyBlockUploading(): boolean {
    return Array.from(this.uiState.values()).some(s => s.isUploading);
  }
}
