import { Component, OnInit, OnDestroy, inject, ChangeDetectorRef, Injector } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  ReactiveFormsModule, FormGroup, FormControl, Validators,
  AbstractControl, ValidationErrors
} from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Params, Router } from '@angular/router';
import { Subject } from 'rxjs';

import { TiptapEditorDirective } from 'ngx-tiptap';
import { Editor, Extension, Extensions, JSONContent } from '@tiptap/core';
import { TextStyle, FontSize } from '@tiptap/extension-text-style';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Underline from '@tiptap/extension-underline';
import { Slice, Fragment, Node as PMNode, DOMParser as PMDOMParser } from '@tiptap/pm/model';

import { BlockUIState, emptyUIState } from './ingest-block.model';
import { clipboardImageFile, textLinesToHtml, preparePastedHtml, imageMarkerIndex, ImageSeed } from './paste.util';
import { MediaUploadService } from './media-upload.service';
import { ImageBlock, VideoBlock, MediaHost } from './media-nodes';

/** 位置 — the three mutually-exclusive fronts. 栏目 is not one of these. */
export type ZoneFront = 'super_main' | 'main' | 'sub_main' | 'tertiary';

type MediaNodeType = 'imageBlock' | 'videoBlock';


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

/**
 * Tab never leaves the editor (the browser default moves focus to the next
 * control). In a list it indents/outdents the item; elsewhere Tab writes a
 * tab character at the caret and Shift+Tab does nothing. Priority above
 * ListItem's own Tab binding so this owns the key outright.
 */
const TabKeys = Extension.create({
  name: 'tabKeys',
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      Tab: () => {
        if (this.editor.isActive('listItem')) {
          this.editor.commands.sinkListItem('listItem');
          return true;
        }
        const { view, state } = this.editor;
        view.dispatch(state.tr.insertText('\t').scrollIntoView());
        return true;
      },
      'Shift-Tab': () => {
        if (this.editor.isActive('listItem')) this.editor.commands.liftListItem('listItem');
        return true;
      }
    };
  }
});

@Component({
  selector: 'app-ingest',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, TiptapEditorDirective],
  templateUrl: './ingest.component.html',
  styleUrls: ['./ingest.component.css']
})
export class IngestComponent implements OnInit, OnDestroy, MediaHost {
  metaForm!: FormGroup;
  status = '';
  isSuccess = false;
  isSubmitting = false;
  editingId: string | null = null;

  // ---- One document for the whole article. Paragraphs, headings and lists
  // are ordinary ProseMirror nodes; image/video are atom nodes whose attrs
  // carry exactly what a content_blocks media entry carries. ----
  editor!: Editor;

  // Upload state that is not article content (progress, preview, the File),
  // keyed by the media node's attrs.localId. Node views read it; uiChanged
  // tells the one node view whose state moved to re-render.
  uiState: Map<string, BlockUIState> = new Map();
  readonly uiChanged = new Subject<string>();

  /** Kept for the toolbar bindings: there is only one editor now. */
  get activeEditor(): Editor | null {
    return this.editor ?? null;
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
  private injector = inject(Injector);

  constructor(
    private http: HttpClient,
    private cdr: ChangeDetectorRef,
    private mediaUpload: MediaUploadService
  ) {}

   ngOnInit() {
     // Only scalar, fixed-shape fields live in Reactive F ms. content_blocks
     // is dynamic and index-sensitive in a way FormArray actively fights —
     // it stays out of the form, assembled into the payload at submit time.
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

     this.editor = new Editor({
       extensions: [
         ...this.extensions,
         TabKeys,
         ImageBlock.configure({ host: this, injector: this.injector }),
         VideoBlock.configure({ host: this, injector: this.injector })
       ],
       content: { type: 'doc', content: [{ type: 'paragraph' }] },
       editorProps: {
         handlePaste: (view: any, event: ClipboardEvent) => this.handlePaste(view, event)
       }
     });

     this.route.queryParams.subscribe((params: Params) => {
       const idFromUrl = params['edit'];
       if (idFromUrl) {
         this.editingId = idFromUrl;
         this.loadArticleForEdit(idFromUrl);
       } else {
         this.editingId = null;
         this.resetMetaForm();
         this.leadImagePreview = null;
         this.loadContent([]);
       }
     });
   }

  ngOnDestroy() {
    this.editor?.destroy();
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

  // ===========================================================================
  // content_blocks <-> document. The wire format is a flat list of six-key
  // entries (type is the discriminant; fields that don't apply are null).
  // The document is a flat list of top-level nodes. These two functions are
  // the only places that know both shapes.
  // ===========================================================================

  /** Stored entries -> one doc. Paragraph entries drop their per-entry doc wrapper. */
  private contentBlocksToDoc(dtos: any[]): JSONContent {
    const content: JSONContent[] = [];
    for (const dto of [...dtos].sort((a, b) => a.order_id - b.order_id)) {
      if (dto.type === 'image' || dto.type === 'video') {
        const localId = crypto.randomUUID();
        this.uiState.set(localId, { ...emptyUIState(), previewUrl: dto.media_url || null });
        // Same defaults dtoToBlock applied, so an entry saves back exactly as blockToDto wrote it.
        content.push({
          type: dto.type === 'image' ? 'imageBlock' : 'videoBlock',
          attrs: { localId, url: dto.media_url ?? '', caption: dto.caption ?? '', align: dto.align ?? 'center' }
        });
      } else {
        content.push(...(dto.content_json?.content ?? []));
      }
    }
    return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
  }

  /** One doc -> stored entries. Every non-media node goes out as a paragraph entry, re-wrapped. */
  private docToContentBlocks(doc: JSONContent): any[] {
    return (doc.content ?? []).map((node, i) => {
      const media = node.type === 'imageBlock' || node.type === 'videoBlock';
      return {
        align:        media ? node.attrs?.['align'] ?? 'center' : null,
        caption:      media ? node.attrs?.['caption'] || null : null,
        content_json: media ? null : { type: 'doc', content: [node] },
        media_url:    media ? node.attrs?.['url'] ?? '' : null,
        order_id:     i,
        type:         node.type === 'imageBlock' ? 'image' : node.type === 'videoBlock' ? 'video' : 'paragraph'
      };
    });
  }

  /**
   * Replaces the whole document without an undo step: Ctrl+Z after opening
   * an article must not undo the load back to a blank page.
   */
  private loadContent(dtos: any[]) {
    this.uiState.clear();
    const doc = this.editor.schema.nodeFromJSON(this.contentBlocksToDoc(dtos));
    const { state, view } = this.editor;
    view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content).setMeta('addToHistory', false));
    this.cdr.detectChanges();
  }

  // ===========================================================================
  // Media nodes
  // ===========================================================================

  /** Tells the media node view for localId (and this component) to re-render. */
  private touch(localId: string) {
    this.uiChanged.next(localId);
    this.cdr.detectChanges();
  }

  /** A media node's attrs with newBlock's defaults; registers its upload state. */
  private newMediaAttrs(attrs: { url?: string; caption?: string; align?: string } = {}) {
    const localId = crypto.randomUUID();
    this.uiState.set(localId, { ...emptyUIState(), previewUrl: attrs.url || null });
    return { localId, url: '', caption: '', align: 'center', ...attrs };
  }

  /** Inserts a media node at the selection; returns its localId. */
  private insertMediaNode(type: MediaNodeType, attrs: { url?: string; caption?: string; align?: string } = {}): string {
    const a = this.newMediaAttrs(attrs);
    this.editor.commands.insertContent({ type, attrs: a });
    return a.localId;
  }

  /** Menu bar: an empty image/video node at the caret, showing its picker. */
  insertMedia(type: MediaNodeType) {
    this.editor.commands.focus();
    this.insertMediaNode(type);
  }

  /** Bottom toolbar: a new node at the end of the article. */
  appendBlock(type: 'paragraph' | MediaNodeType) {
    const end = this.editor.state.doc.content.size;
    if (type === 'paragraph') {
      this.editor.chain().insertContentAt(end, { type: 'paragraph' }).focus('end').run();
      return;
    }
    this.editor.commands.insertContentAt(end, { type, attrs: this.newMediaAttrs() });
  }

  /**
   * Writes attrs onto the media node with this localId, wherever it has
   * moved to. Kept out of history: undoing must not revert an upload's URL.
   */
  private setMediaAttrs(localId: string, attrs: Record<string, any>) {
    const { state, view } = this.editor;
    let found = false;
    state.doc.descendants((node, pos) => {
      if (found) return false;
      if (node.attrs['localId'] !== localId) return true;
      view.dispatch(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }).setMeta('addToHistory', false));
      found = true;
      return false;
    });
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
  // Paste. Content copied out of this editor carries ProseMirror's
  // data-pm-slice marker and goes through ProseMirror's own paste, which
  // parses media back via the nodes' parseHTML. Everything else goes through
  // preparePastedHtml: image markers become imageBlock nodes in the same
  // slice, so the whole paste is one transaction (one undo).
  // ===========================================================================

   handlePaste(view: any, event: ClipboardEvent): boolean {
     // Raw image bytes: exclusive, one image node at the caret.
     const file = clipboardImageFile(event);
     if (file) {
       const localId = this.insertMediaNode('imageBlock', { url: '', caption: '' });
       this.resolvePastedImage(localId, file, null);
       return true;
     }

     const dt = event.clipboardData;
     const clipHtml = dt?.getData('text/html') ?? '';
     if (clipHtml.includes('data-pm-slice')) return false;

     const raw = clipHtml || textLinesToHtml(dt?.getData('text/plain') ?? '');
     if (!raw) return false;

     const { html, images } = preparePastedHtml(raw);
     const dom = new DOMParser().parseFromString(html, 'text/html').body;
     const parsed = PMDOMParser.fromSchema(view.state.schema).parseSlice(dom);

     // Markers -> imageBlock nodes. Empty paragraphs between other content
     // (source spacing) are dropped; the edge ones are kept, since those
     // merge into the caret's paragraph.
     const schema = view.state.schema;
     const pending: { localId: string; seed: ImageSeed }[] = [];
     const nodes: PMNode[] = [];
     const last = parsed.content.childCount - 1;
     parsed.content.forEach((node: PMNode, _offset: number, i: number) => {
       const k = imageMarkerIndex(node);
       if (k !== null) {
         const seed = images[k];
         if (!seed) return;
         const localId = crypto.randomUUID();
         pending.push({ localId, seed });
         nodes.push(schema.nodes['imageBlock'].create({
           localId, url: seed.remoteUrl ?? '', caption: seed.caption ?? '', align: 'center'
         }));
         return;
       }
       if (node.type.name === 'paragraph' && node.content.size === 0 && i !== 0 && i !== last) return;
       nodes.push(node);
     });
     if (!nodes.length) return true;

     // An edge that is now an image (or no longer the parsed edge) is closed,
     // so the image lands as a node of its own instead of merging into the
     // caret's paragraph.
     const slice = new Slice(
       Fragment.from(nodes),
       nodes[0] === parsed.content.firstChild ? parsed.openStart : 0,
       nodes[nodes.length - 1] === parsed.content.lastChild ? parsed.openEnd : 0
     );

     for (const p of pending) {
       this.uiState.set(p.localId, { ...emptyUIState(), previewUrl: p.seed.remoteUrl || null });
     }

     // The paste/uiEvent metas are what ProseMirror sets on its own pastes;
     // Tiptap's paste rules key off them.
     const tr = view.state.tr.replaceSelection(slice).scrollIntoView();
     tr.setMeta('paste', true).setMeta('uiEvent', 'paste');
     view.dispatch(tr);

     for (const p of pending) this.resolvePastedImage(p.localId, p.seed.sourceFile, p.seed.remoteUrl);
     return true;
   }


  // Lazy image resolution: the node is already visible (with a temporary
  // preview) before any network activity resolves.
  private async resolvePastedImage(localId: string, sourceFile: File | null, remoteUrl: string | null) {
    const state = this.uiState.get(localId);
    if (!state) return;
    try {
      state.isUploading = true;
      this.touch(localId);

      let url: string;

      if (sourceFile) {
        // Clipboard bytes — already ours, existing path.
        state.file = sourceFile;
        const reader = new FileReader();
        reader.onload = () => { state.previewUrl = reader.result as string; this.touch(localId); };
        reader.readAsDataURL(sourceFile);

        url = await this.mediaUpload.uploadImage(sourceFile, pct => {
          state.progress = pct;
          this.touch(localId);
        });
      } else if (remoteUrl) {
        // Foreign URL — the browser won't let us read those bytes, so the
        // server fetches them. Preview stays on the remote URL until it
        // resolves; <img> can load what fetch() can't.
        state.previewUrl = remoteUrl;
        this.touch(localId);
        url = await this.mediaUpload.uploadImageFromUrl(remoteUrl);
        state.previewUrl = url;
      } else {
        return;
      }

      this.setMediaAttrs(localId, { url });
      this.status = '';
    } catch (err: any) {
      this.status = 'Image paste failed: ' + (err?.error?.error || err?.message || err?.statusText || 'unknown error');
    } finally {
      state.isUploading = false;
      this.touch(localId);
    }
  }
  // ===========================================================================
  // Lead image — article-level, singular, lives in metaForm not the document.
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
  // Direct media selection (file inputs inside the media node views)
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
    reader.onload = () => { state.previewUrl = reader.result as string; this.touch(localId); };
    reader.readAsDataURL(file);

    try {
      const url = await this.mediaUpload.uploadImage(file, pct => {
        state.progress = pct;
        this.touch(localId);
      });
      this.setMediaAttrs(localId, { url });
      this.status = '';
    } catch (err: any) {
      this.status = 'Upload failed: ' + (err?.message || err?.statusText || 'unknown error');
    } finally {
      state.isUploading = false;
      this.touch(localId);
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
        this.touch(localId);
      });
      this.setMediaAttrs(localId, { url });

      // Point the preview at the uploaded file's public URL, exactly as a
      // reloaded node does. Without this a just-uploaded video renders
      // differently from the same video after a page reload.
      state.previewUrl = url;
      this.status = '';
    } catch (err: any) {
      this.status = 'Video upload failed: ' + (err?.message || err?.statusText || 'unknown error');
    } finally {
      state.isUploading = false;
      this.touch(localId);
    }
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

       this.loadContent(data.content_blocks ?? []);
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
       content_blocks: this.docToContentBlocks(this.editor.getJSON())
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
             // already clears the document/meta and nulls editingId.
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
    this.resetMetaForm();
    this.leadImagePreview = null;
    this.loadContent([]);
  }

  get isAnyBlockUploading(): boolean {
    return Array.from(this.uiState.values()).some(s => s.isUploading);
  }
}
