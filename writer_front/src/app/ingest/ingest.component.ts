import { Component, OnInit, OnDestroy, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  ReactiveFormsModule, FormGroup, FormControl, Validators,
  AbstractControl, ValidationErrors
} from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Params, Router } from '@angular/router';
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
import { clipboardImageFile, textLinesToHtml, preparePastedHtml, imageMarkerIndex, ImageSeed } from './paste.util';
import { Slice, DOMParser as PMDOMParser } from '@tiptap/pm/model';
import { MediaUploadService } from './media-upload.service';

/** 位置 — the three mutually-exclusive fronts. 栏目 is not one of these. */
export type ZoneFront = 'super_main' | 'main' | 'sub_main' | 'tertiary';

import { Selection } from '@tiptap/pm/state';
import { canJoin } from '@tiptap/pm/transform';


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
  isSubmitting = false;
  editingId: string | null = null;

  // ---- Canonical content model + its two localId-keyed projections ----
  blocks: Block[] = [];
  editors: Map<string, Editor> = new Map();
  uiState: Map<string, BlockUIState> = new Map();

  activeLocalId: string | null = null;

  get activeEditor(): Editor | null {
    return this.activeLocalId ? this.editors.get(this.activeLocalId) ?? null : null;
  }

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


  /**----------------
   * 固定栏位 — category dictates placement, decided at ingest, not at read time.
   * The writer picks a category; the placement follows and is not editable.
   */
   private readonly categoryZoneLock: Record<string, { front: ZoneFront; intra: number }> = {
     '美洲台探訪': { front: 'super_main', intra: 0 },  // 高光專區中心
     '出海專區':   { front: 'super_main', intra: 1 },  // 高光專區側
     '商務合作':   { front: 'super_main', intra: 2 }   // 高光專區底
   };

  /** 主板中心 is offered to this category alone. */
  private readonly MAIN_CENTER_CATEGORY = '美洲頭條';

  /** 主板 is picked but 中心 is withheld — drives the template notice. */
  get mainCenterReserved(): boolean {
    const v = this.metaForm?.getRawValue();
    return v?.front === 'main' && v?.category !== this.MAIN_CENTER_CATEGORY;
  }

  get canUseSuperMain(): boolean {
    return this.lockedZone?.front === 'super_main';
  }

  get availableFrontOptions(): { value: ZoneFront; label: string }[] {
    return this.canUseSuperMain
      ? this.frontOptions
      : this.frontOptions.filter(o => o.value !== 'super_main');
  }

  get lockedZone(): { front: ZoneFront; intra: number } | null {
    return this.categoryZoneLock[this.metaForm?.get('category')?.value] ?? null;
  }

  /**
   * Forces 位置/排列 for a locked category and disables both controls.
   * Both are read back with getRawValue() at submit, so a disabled control
   * still reaches the wire; the group validator reads .value directly, which
   * a disabled control also retains.
   */
  private applyCategoryLock() {
    const lock = this.lockedZone;
    const frontCtrl = this.metaForm.get('front')!;
    const intraCtrl = this.metaForm.get('intra_section_zone')!;

    if (!lock) {
          // Switching away from a 高光专区 category leaves its front behind —
          // that value is no longer offerable, so drop it.
          if (frontCtrl.value === 'super_main') frontCtrl.setValue(null, { emitEvent: false });
          frontCtrl.enable({ emitEvent: false });
          this.syncIntraZoneValidity();
          return;
        }

    frontCtrl.setValue(lock.front, { emitEvent: false });
    this.syncIntraZoneValidity();                          // front set -> intra required + enabled
    intraCtrl.setValue(lock.intra, { emitEvent: false });
    frontCtrl.disable({ emitEvent: false });
    intraCtrl.disable({ emitEvent: false });
  }

//9.16
//   private readonly baseURL = `http://${window.location.hostname}:9000/api`;

  private readonly baseURL = '/api';
  private readonly API_URL = `${this.baseURL}/ingest`;



  private route = inject(ActivatedRoute);
  private router = inject(Router);

  constructor(
    private http: HttpClient,
    private cdr: ChangeDetectorRef,
    private mediaUpload: MediaUploadService
  ) {}

   ngOnInit() {
     // Only scalar, fixed-shape fields live in Reactive F ms. content_blocks
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
       cat_main: new FormControl(false),
       cat_column: new FormControl(false),
       category_intra: new FormControl<number | null>(null),
       lead_image_url: new FormControl(''),
       lead_image_caption: new FormControl(''),
       view_count: new FormControl<number>(0, [Validators.min(0), Validators.max(4294967295)]),
     }, { validators: zonePicked });

     // ONE rule, ONE place. Previously this subscription hand-inlined half of
     // syncIntraZoneValidity() while the method itself was never called from
     // anywhere — so the required-validator half of the rule never ran and
     // 排列 could be left blank on a front. The subscription now delegates.
     this.metaForm.get('front')!.valueChanges.subscribe(() => this.syncIntraZoneValidity());
     this.metaForm.get('category')!.valueChanges.subscribe(() => this.applyCategoryLock());
     this.metaForm.get('cat_main')!.valueChanges.subscribe(() => this.syncCategoryIntraValidity());
     this.applyCategoryLock();
     this.syncCategoryIntraValidity();

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

   private readonly BOTTOM_STRIP = ['天天話題', '美國觀察', '中美關係'];

  /**
   * 主板 withholds 中心 from every category but 美洲頭條. A 中心 carried in
   * from another 位置, or left behind by a category change, is not in this
   * list, so syncIntraZoneValidity()'s stillValid check drops it.
   */
  get intraSectionZoneOptions(): { value: number; label: string }[] {
    const front = this.metaForm?.get('front')?.value;
    const cat = this.metaForm?.get('category')?.value;
    if (front === 'main') {
      const opts = this.BOTTOM_STRIP.includes(cat) ? this.intraFull : this.intraNoBottom;
      return cat === this.MAIN_CENTER_CATEGORY ? opts : opts.filter(o => o.value !== 0);
    }
    if (front === 'super_main' || front === 'sub_main') return this.intraFull;
    if (front === 'tertiary') return this.intraNoBottom;
    return [];
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
    { value: 'super_main', label: '高光专区' },
    { value: 'main',       label: '主板' },
    { value: 'sub_main',   label: '次板' },
    { value: 'tertiary',   label: '三版' }
  ];

  // Fixed numeric encoding, independent of which subset is offered:
  // 0 = 中心, 1 = 侧, 2 = 底.
  private readonly intraFull: { value: number; label: string }[] = [
    { value: 0, label: '中心' },
    { value: 1, label: '侧' },
    { value: 2, label: '底' }
  ];
  private readonly intraNoBottom = this.intraFull.slice(0, 2); // 中心, 侧 only




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

  // ===========================================================================
  // 分类页位置 (category_position) / 分类页排列 (category_intra)
  //
  // category_position is SET('main','column') — both checkboxes may be on at
  // once. category_intra is 0 = 中心, 1 = 侧; no 底 on category pages. It is
  // required exactly when 'main' is checked, and disabled otherwise.
  // ===========================================================================

  readonly categoryIntraOptions = this.intraNoBottom;

  get categoryIntraDisabled(): boolean {
    return !this.metaForm?.get('cat_main')?.value;
  }

  private syncCategoryIntraValidity() {
    const onMain = this.metaForm.get('cat_main')!.value;
    const ctrl = this.metaForm.get('category_intra')!;

    if (!onMain) ctrl.setValue(null, { emitEvent: false });
    ctrl.setValidators(onMain ? [Validators.required] : []);

    if (onMain) ctrl.enable({ emitEvent: false });
    else ctrl.disable({ emitEvent: false });

    ctrl.updateValueAndValidity({ emitEvent: false });
  }

  /** cat_main + cat_column -> the SET string. Called once, at submit. */
  private buildCategoryPosition(): string {
    const v = this.metaForm.getRawValue();
    return [v.cat_main ? 'main' : null, v.cat_column ? 'column' : null].filter(Boolean).join(',');
  }

  /** The SET string -> cat_main + cat_column. Called once, on edit load. */
  private applyCategoryPosition(cp: string | null) {
    const parts = (cp ?? '').split(',').map(s => s.trim());
    this.metaForm.patchValue({
      cat_main: parts.includes('main'),
      cat_column: parts.includes('column')
    });
  }

  private resetMetaForm() {
    // Explicit zone defaults: a bare reset() sets in_column to null rather
    // than false, which desyncs the checkbox from the control.
    this.metaForm.reset({
      date_time: this.getCurrentDateTime(),
      front: null,
      in_column: false,
      cat_main: false,
      cat_column: false,
      view_count: 0
    });
    this.syncIntraZoneValidity();
    this.syncCategoryIntraValidity();
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
   readonly categories: string[] = ['美洲頭條', '天天話題', '美國觀察', '中美關係',
     '工商新聞', '出海專區', 'CES消費電子展', '美洲台探訪', '商務合作',];

  get lastBlockId(): string | null {
    return this.blocks.length ? this.blocks[this.blocks.length - 1].localId : null;
  }

  get firstParagraphId(): string | null {
    return this.blocks.find(isParagraph)?.localId ?? null;
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
    this.activeLocalId = null;
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
     onFocus: () => { this.activeLocalId = block.localId; },
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
       handlePaste: (view: any, event: ClipboardEvent) =>
         this.handlePaste(view, event, block.localId)
     }
   });
   this.editors.set(block.localId, editor);
  }

    private handleEditorKeyDown(localId: string, view: any, event: KeyboardEvent): boolean {
      // IME: while composing, Enter commits the candidate and Backspace edits
      // the pinyin buffer. Both belong to the input method. (229 = Safari.)
      if (event.isComposing || event.keyCode === 229) return false;

      if (event.key === 'Enter' && !event.shiftKey) {
        const { state } = view;
        const { from, to } = state.selection;
        // New paragraph right after this one, carrying whatever sits after the
        // caret. Caret at the end -> the tail is empty -> a plain new paragraph.
        const tail = state.doc.cut(to);
        view.dispatch(state.tr.delete(from, state.doc.content.size));
        const created = this.insertBlock('paragraph', localId, { json: tail.toJSON() });
        setTimeout(() => this.focusBlock(created.localId, 'start'), 10);
        return true;
      }

      if (event.key === 'Backspace') {
        const { selection, doc } = view.state;
        // Only at index 0 of this block with nothing selected. Every other
        // Backspace is ordinary character deletion and stays ProseMirror's.
        if (!selection.empty || selection.from !== Selection.atStart(doc).from) return false;

        const prev = this.blocks[this.findIndex(localId) - 1];
        if (!prev) return false;

        if (isParagraph(prev)) {
          const prevEditor = this.editors.get(prev.localId);
          if (!prevEditor) return false;

          // Append this block's nodes after prev's last node, then join across
          // that boundary so the two paragraphs become one. The caret goes to
          // the seam: the old end of prev's text.
          // Each Editor has its own Schema, so the nodes are rebuilt in prev's
          // schema first. Foreign node types are silently dropped by insert.
          const end = prevEditor.state.doc.content.size;
          const moved = prevEditor.schema.nodeFromJSON(doc.toJSON()).content;
          let tr = prevEditor.state.tr.insert(end, moved);
          const joined = canJoin(tr.doc, end);
          if (joined) tr = tr.join(end);
          tr.setSelection(Selection.near(tr.doc.resolve(joined ? end - 1 : end)));
          prevEditor.view.dispatch(tr);   // prev's onUpdate refreshes prev.json

          this.removeBlock(localId);
          setTimeout(() => prevEditor.commands.focus(), 10);  // no arg = keep the seam selection
          return true;
        }

        // Previous block is image/video: same as before, an empty paragraph
        // after it is removed and a non-empty one is left alone.
        if (doc.textContent.length === 0) {
          this.removeBlock(localId);
          setTimeout(() => this.focusBlock(prev.localId), 10);
          return true;
        }
      }

      // Up at index 0 -> nearest paragraph above, at its index -1.
      // Down at index -1 -> nearest paragraph below, at its index 0.
      // Image/video blocks in between are skipped. Shift+Arrow is left to
      // ProseMirror as in-block selection.
      if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.shiftKey) {
        const { selection, doc } = view.state;
        const up = event.key === 'ArrowUp';
        const edge = up ? Selection.atStart(doc).from : Selection.atEnd(doc).from;
        if (!selection.empty || selection.from !== edge) return false;

        const step = up ? -1 : 1;
        for (let i = this.findIndex(localId) + step; i >= 0 && i < this.blocks.length; i += step) {
          const target = this.blocks[i];
          if (isParagraph(target)) {
            this.focusBlock(target.localId, up ? 'end' : 'start');
            return true;
          }
        }
        return false;
      }

      // Tab never leaves the editor (the browser default moves focus to the
      // next control). In a list it indents/outdents the item; elsewhere Tab
      // writes a tab character at the caret and Shift+Tab does nothing.
      if (event.key === 'Tab') {
        const editor = this.editors.get(localId);
        if (!editor) return false;
        if (editor.isActive('listItem')) {
          if (event.shiftKey) editor.commands.liftListItem('listItem');
          else editor.commands.sinkListItem('listItem');
        } else if (!event.shiftKey) {
          view.dispatch(view.state.tr.insertText('\t').scrollIntoView());
        }
        return true;
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

   handlePaste(view: any, event: ClipboardEvent, localId: string): boolean {
     // Raw image bytes: exclusive, one image block after this one.
     const file = clipboardImageFile(event);
     if (file) {
       const block = this.insertBlock('image', localId, { url: '', caption: '' });
       this.resolvePastedImage(block.localId, file, null);
       return true;
     }

     const dt = event.clipboardData;
     const raw = dt?.getData('text/html') || textLinesToHtml(dt?.getData('text/plain') ?? '');
     if (!raw) return false;

     // Images out (markers in their place), then ONE parse for the paragraphs:
     // inline content stays in the open paragraph, only block-level markup
     // opens the next. The parsed slice is left open at both ends.
     const { html, images } = preparePastedHtml(raw);
     const dom = new DOMParser().parseFromString(html, 'text/html').body;
     let slice = PMDOMParser.fromSchema(view.state.schema).parseSlice(dom);

     // An image at either edge must not merge into the caret's paragraph:
     // close that edge so the marker lands as a node of its own.
     const c = slice.content;
     slice = new Slice(
       c,
       imageMarkerIndex(c.firstChild) !== null ? 0 : slice.openStart,
       imageMarkerIndex(c.lastChild) !== null ? 0 : slice.openEnd
     );

     // Assume it belongs in the current paragraph: write at the caret,
     // replacing any selection. The paste/uiEvent metas are what ProseMirror
     // sets on its own pastes; Tiptap's paste rules key off them.
     const tr = view.state.tr.replaceSelection(slice).scrollIntoView();
     tr.setMeta('paste', true).setMeta('uiEvent', 'paste');
     view.dispatch(tr);

     this.splitTopLevel(localId, images);
     return true;
   }

   /**
    * One block per top-level node. Image markers become image blocks; empty
    * paragraphs (source spacing) are dropped except the one holding the
    * caret. This block keeps the first node if it's a paragraph, and is
    * replaced otherwise, since a paragraph block can't become an image.
    */
   private splitTopLevel(localId: string, images: ImageSeed[]) {
     const editor = this.editors.get(localId);
     if (!editor) return;
     const { doc, selection } = editor.state;
     if (doc.childCount === 1 && imageMarkerIndex(doc.firstChild) === null) return;

     // Caret as (top-level index, offset inside that node). A node moved into
     // a fresh doc starts at position 0, so the offset carries over unchanged.
     const caretIndex = selection.$head.index(0);
     let caretNodeStart = 0;
     for (let i = 0; i < caretIndex; i++) caretNodeStart += doc.child(i).nodeSize;
     const caretOffset = selection.head - caretNodeStart;

     type Part =
       | { kind: 'image'; seed: ImageSeed }
       | { kind: 'paragraph'; json: JSONContent; caret: boolean };
     const parts: Part[] = [];
     doc.forEach((node, _offset, i) => {
       const k = imageMarkerIndex(node);
       if (k !== null) {
         if (images[k]) parts.push({ kind: 'image', seed: images[k] });
         return;
       }
       if (node.content.size === 0 && i !== caretIndex) return;
       parts.push({ kind: 'paragraph', json: node.toJSON(), caret: i === caretIndex });
     });

     const first = parts[0];
     const keepHere = first?.kind === 'paragraph';
     if (keepHere) {
       // A transaction, so onUpdate refreshes block.json.
       const node = editor.schema.nodeFromJSON(first.json);
       editor.view.dispatch(editor.state.tr.replaceWith(0, doc.content.size, node));
     }

     let anchor = localId;
     let caretLocalId: string | null = keepHere && first.caret ? localId : null;
     for (const part of parts.slice(keepHere ? 1 : 0)) {
       if (part.kind === 'image') {
         const b = this.insertBlock('image', anchor, { url: part.seed.remoteUrl ?? '', caption: part.seed.caption ?? '' });
         this.resolvePastedImage(b.localId, part.seed.sourceFile, part.seed.remoteUrl);
         anchor = b.localId;
       } else {
         const b = this.insertBlock('paragraph', anchor, { json: { type: 'doc', content: [part.json] } });
         if (part.caret) caretLocalId = b.localId;
         anchor = b.localId;
       }
     }
     if (!keepHere) this.removeBlock(localId);

     const target = caretLocalId ?? anchor;
     setTimeout(() => this.editors.get(target)?.commands.focus(caretLocalId ? caretOffset : 'end'), 10);
  }


  // Lazy image resolution: the block is already visible (with a temporary
  // preview) before any network activity resolves.
  private async resolvePastedImage(localId: string, sourceFile: File | null, remoteUrl: string | null) {
    const state = this.uiState.get(localId);
    if (!state) return;
    try {
      state.isUploading = true;
      this.cdr.detectChanges();

      let url: string;

      if (sourceFile) {
        // Clipboard bytes — already ours, existing path.
        state.file = sourceFile;
        const reader = new FileReader();
        reader.onload = () => { state.previewUrl = reader.result as string; this.cdr.detectChanges(); };
        reader.readAsDataURL(sourceFile);

        url = await this.mediaUpload.uploadImage(sourceFile, pct => {
          state.progress = pct;
          this.cdr.detectChanges();
        });
      } else if (remoteUrl) {
        // Foreign URL — the browser won't let us read those bytes, so the
        // server fetches them. Preview stays on the remote URL until it
        // resolves; <img> can load what fetch() can't.
        state.previewUrl = remoteUrl;
        this.cdr.detectChanges();
        url = await this.mediaUpload.uploadImageFromUrl(remoteUrl);
        state.previewUrl = url;
      } else {
        return;
      }

      const block = this.findBlock(localId);
      if (block && !isParagraph(block)) block.url = url;
      this.status = '';
    } catch (err: any) {
      this.status = 'Image paste failed: ' + (err?.error?.error || err?.message || err?.statusText || 'unknown error');
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
       // therefore wipe the value that was just loaded. Same for the
       // category pair.
       this.applySectionZone(data.section_zone);
       this.applyCategoryPosition(data.category_position);

       this.metaForm.patchValue({
         id: data.id,
         title: data.title,
         summary: data.summary,
         author: data.author,
         category: data.category,
         date_time: data.date_time,
         intra_section_zone: data.intra_section_zone,
         category_intra: data.category_intra,
         lead_image_url: data.lead_image_url,
         view_count: data.view_count ?? 0,
         lead_image_caption: data.lead_image_caption
       });
       this.leadImagePreview = data.lead_image_url || null;
       this.applyCategoryLock();

       // ... unchanged from here

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
     this.isSubmitting = true;

     // getRawValue, not value: intra_section_zone / category_intra are
     // DISABLED when their parent placement is off, and value silently
     // omits disabled controls — they'd vanish rather than arrive null.
     // front/in_column/cat_main/cat_column are UI-side only.
     const { front, in_column, cat_main, cat_column, ...meta } = this.metaForm.getRawValue();

     const payload = {
       ...meta,
       section_zone: this.buildSectionZone(),
       category_position: this.buildCategoryPosition(),
       content_blocks: this.blocks.map(blockToDto)
     };

     this.http.post(this.API_URL, payload).subscribe({
       next: () => {
         this.status = 'Success!';
         this.isSuccess = true;

         // Hold the ✓ long enough to be seen, then clear for the next article.
         setTimeout(() => {
           this.isSuccess = false;
           this.isSubmitting = false;
           if (this.editingId) {
             // Dropping ?edit fires the queryParams subscription, which
             // already clears blocks/meta and nulls editingId.
             this.router.navigate([], { relativeTo: this.route, queryParams: {} });
           } else {
             this.resetForm();
           }
           this.cdr.detectChanges();
         }, 1500);
       },
       error: () => {
       this.status = 'Submission failed.';
       this.isSubmitting = false;
       }
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
