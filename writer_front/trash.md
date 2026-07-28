```ts
import { Component, OnInit, OnDestroy, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormGroup, FormControl, Validators, FormArray } from '@angular/forms';
import { HttpClient, HttpEventType } from '@angular/common/http';
import { ActivatedRoute, Params } from '@angular/router';
import { CdkDragDrop, moveItemInArray, DragDropModule } from '@angular/cdk/drag-drop'; // Add this

// 2026 Tiptap Imports
import { TiptapEditorDirective } from 'ngx-tiptap';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Underline from '@tiptap/extension-underline';

@Component({
  selector: 'app-ingest',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, TiptapEditorDirective, DragDropModule],
  templateUrl: './ingest.component.html',
  styleUrls: ['./ingest.component.css']
})
export class IngestComponent implements OnInit, OnDestroy {
  ingestForm!: FormGroup;
  status: string = '';
  blockStates: any[] = [];
  editors: Map<number, Editor> = new Map();

  private route = inject(ActivatedRoute);
  editingId: string | null = null;

  private readonly serverIP: string = window.location.hostname;
  private readonly port: string = '9000';
  public readonly baseURL: string = `http://${this.serverIP}:${this.port}/api`;
  private readonly API_URL = this.baseURL + "/ingest";
  readonly CHUNK_SIZE = 10 * 1024 * 1024;

  isSuccess: boolean = false;

  activeIdx: number = 0;

  constructor(private http: HttpClient, private cdr: ChangeDetectorRef) {}



  ngOnInit() {
    this.ingestForm = new FormGroup({
      id: new FormControl(null),
      title: new FormControl('', [Validators.required]),
      summary: new FormControl(''),
      author: new FormControl(''),
      category: new FormControl(''),
      date_time: new FormControl(this.getCurrentDateTime()),
      is_featured: new FormControl(false),
      homepage_not_feature: new FormControl(false),
      content_blocks: new FormArray([])
    });

    this.route.queryParams.subscribe((params: Params) => {
      this.clearAllBlocks();
      const idFromUrl = params['edit'];
      if (idFromUrl) {
        this.editingId = idFromUrl;
        this.loadArticleForEdit(idFromUrl);
      } else {
        this.editingId = null;
        this.ingestForm.reset({ date_time: this.getCurrentDateTime() });
        this.addBlock('paragraph');
      }
    });
  }

  ngOnDestroy() {
    this.editors.forEach(editor => editor.destroy());
  }

  get contentBlocks(): FormArray {
    return this.ingestForm.get('content_blocks') as FormArray;
  }

  getCurrentDateTime(): string {
    const now = new Date();
    return new Date(now.getTime() - (7 * 60 * 60 * 1000)).toISOString().slice(0, 16);
  }

  // --- Tiptap Instance Management ---

  private createTiptapEditor(index: number, initialContent: string = ''): Editor {
    return new Editor({
      extensions: [
        StarterKit,
        Underline,
        Link.configure({ openOnClick: false }),
        Placeholder.configure({ placeholder: 'Type something or paste content...' })
      ],
      content: initialContent,
      onUpdate: ({ editor }) => {
        const html = editor.getHTML();
        this.contentBlocks.at(index).get('paragraph_text')?.setValue(html, { emitEvent: false });
        if (this.blockStates[index]) {
          this.blockStates[index].charCount = editor.getText().length;
        }
      },
      editorProps: {
        handleKeyDown: (view, event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault(); // Stop Tiptap from creating a newline inside the current editor

            const nextIndex = index + 1;
            const hasNextBlock = this.contentBlocks.length > nextIndex;

            if (hasNextBlock && this.contentBlocks.at(nextIndex).get('type')?.value === 'paragraph') {
              // If next block is already a paragraph, just move focus
              this.focusBlock(nextIndex);
            } else {
              // Otherwise, create a new one and focus it
              this.addBlock('paragraph', nextIndex);
              // We must wait for Angular to render the new block before focusing
              setTimeout(() => this.focusBlock(nextIndex), 10);
            }
            return true;
          }

          if (event.key === 'Backspace' && view.state.doc.textContent.length === 0 && index > 0) {
            this.removeBlock(index);
            // Focus the previous block at the end
            setTimeout(() => this.focusBlock(index - 1), 10);
            return true;
          }
          return false;
        },
        handlePaste: (view, event) => {
          this.handlePaste(event, index);
          return true;
        }
      }
    });
  }

  setLink(editor: Editor) {
    // Use bracket notation to satisfy the index signature requirement
    const previousUrl = editor.getAttributes('link')['href'];
    const url = window.prompt('URL', previousUrl);

    // User cancelled the prompt
    if (url === null) {
      return;
    }

    // User cleared the link
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }

    // Update or set the link
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }

  addBlock(type: 'paragraph' | 'image' | 'video', index?: number, initialData?: any) {
    const localId = initialData?.id || Math.random().toString(36).substring(2, 9);
    const block = new FormGroup({
      localId: new FormControl(localId), // Add this hidden control
      type: new FormControl(type),
      paragraph_text: new FormControl(initialData?.paragraph_text || ''),
      image_url: new FormControl(initialData?.image_url || ''),
      video_url: new FormControl(initialData?.video_url || ''),
      order_id: new FormControl(initialData?.order_id || 0)
    });

    const targetIndex = index !== undefined ? index : this.contentBlocks.length;

    // Shift editor mapping if inserting in the middle
    const updatedEditors = new Map<number, Editor>();
    this.editors.forEach((editor, i) => {
      const newKey = i >= targetIndex ? i + 1 : i;
      updatedEditors.set(newKey, editor);
    });
    this.editors = updatedEditors;

    this.contentBlocks.insert(targetIndex, block);

    // Initialize block state without fetching binary data
    this.blockStates.splice(targetIndex, 0, {
      preview: initialData?.image_url || initialData?.video_url || null,
      file: null, // We do NOT fetch the actual file for edits
      progress: initialData ? 100 : 0,
      isUploading: false,
      charCount: (initialData?.paragraph_text || '').length
    });

    if (type === 'paragraph') {
      const editor = this.createTiptapEditor(targetIndex, initialData?.paragraph_text || '');
      this.editors.set(targetIndex, editor);
    }

    this.updateOrderIds();
    this.cdr.detectChanges();
  }
  removeBlock(index: number) {
    const editor = this.editors.get(index);
    if (editor) {
      editor.destroy();
      this.editors.delete(index);
    }
    const updatedEditors = new Map<number, Editor>();
    this.editors.forEach((ed, i) => {
      const newKey = i > index ? i - 1 : i;
      updatedEditors.set(newKey, ed);
    });
    this.editors = updatedEditors;

    this.contentBlocks.removeAt(index);
    this.blockStates.splice(index, 1);
    this.updateOrderIds();
    this.cdr.detectChanges();
  }

  // private focusBlock(index: number) {
  //   const editor = this.editors.get(index);
  //   if (editor) editor.commands.focus('end');
  // }
  private focusBlock(index: number) {
    const editor = this.editors.get(index);
    if (editor) {
      editor.commands.focus('start'); // Use 'start' for new blocks, 'end' for backspace
    } else {
      // Fallback: If map isn't ready, try again shortly
      setTimeout(() => {
        this.editors.get(index)?.commands.focus();
      }, 50);
    }
  }



  drop(event: CdkDragDrop<any[]>) {
    if (event.previousIndex === event.currentIndex) return;

    // 1. Move the FormArray Control (the actual data)
    const control = this.contentBlocks.at(event.previousIndex);
    this.contentBlocks.removeAt(event.previousIndex);
    this.contentBlocks.insert(event.currentIndex, control);

    // 2. Move the UI State (Previews, Progress bars, etc.)
    const state = this.blockStates[event.previousIndex];
    this.blockStates.splice(event.previousIndex, 1);
    this.blockStates.splice(event.currentIndex, 0, state);

    // 3. Re-sync the Tiptap Editors Map
    // This part is tricky because the Map uses numeric indices as keys.
    const tempEditors = new Map(this.editors);
    this.editors.clear();

    // Create a sorted list of current editors
    const editorList: (Editor | undefined)[] = [];
    for (let i = 0; i < this.contentBlocks.length + 1; i++) {
      editorList.push(tempEditors.get(i));
    }

    // Move the editor instance in our temporary list
    moveItemInArray(editorList, event.previousIndex, event.currentIndex);

    // Re-populate the editors Map with the new indices
    editorList.forEach((ed, newIdx) => {
      if (ed) this.editors.set(newIdx, ed);
    });

    // 4. Update the order_id for the database
    this.updateOrderIds();
    this.cdr.detectChanges();
  }

  private updateOrderIds() {
    this.contentBlocks.controls.forEach((c, i) => c.get('order_id')?.setValue(i));
  }

  private clearAllBlocks() {
    this.editors.forEach(ed => ed.destroy());
    this.editors.clear();
    this.contentBlocks.clear();
    this.blockStates = [];
  }

  // --- Safe Media Selection (Fixes the Compiler Error) ---

  onImageSelected(event: Event, index: number) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.uploadFileAndSetUrl(input.files[0], index);
    }
  }

  async onVideoSelected(event: Event, index: number) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const state = this.blockStates[index];
    state.file = file;
    state.isUploading = true;
    const totalChunks = Math.ceil(file.size / this.CHUNK_SIZE);

    try {
      for (let i = 0; i < totalChunks; i++) {
        const chunk = file.slice(i * this.CHUNK_SIZE, Math.min((i + 1) * this.CHUNK_SIZE, file.size));
        const formData = new FormData();
        formData.append('chunk', chunk);
        formData.append('chunkIndex', i.toString());
        formData.append('totalChunks', totalChunks.toString());
        formData.append('fileName', file.name);

        await this.http.post(`${this.baseURL}/ingest/video-chunk`, formData).toPromise();
        state.progress = Math.round(((i + 1) / totalChunks) * 100);
        this.cdr.detectChanges();
      }
      const deterministicUrl = `http://${this.serverIP}:8080/media/${file.name}`;
      this.contentBlocks.at(index).patchValue({ video_url: deterministicUrl });
    } catch {
      this.status = 'Video upload failed.';
    } finally {
      state.isUploading = false;
    }
  }

  // --- Paste Logic (Medium Experience) ---
  async handlePaste(event: ClipboardEvent, index: number) {
    const htmlData = event.clipboardData?.getData('text/html');
    const textData = event.clipboardData?.getData('text/plain');
    const items = event.clipboardData?.items;

    // 1. Handle Direct Image Pastes (e.g. from Clipboard/Screenshots)
    if (items) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const file = items[i].getAsFile();
          // Only prevent default if it's a pure image paste, not an HTML img tag
          if (file && (!htmlData || !htmlData.includes('<img'))) {
            event.preventDefault();
            const targetIndex = index + 1;
            this.addBlock('image', targetIndex);
            this.uploadFileAndSetUrl(file, targetIndex);
            return;
          }
        }
      }
    }

    // 2. Handle Text/HTML Pastes
    if (htmlData || textData) {
      event.preventDefault();
      const parser = new DOMParser();

      // Define extensions for image detection
      const imageRegex = /\.(jpeg|jpg|gif|png|webp|svg|avif)$/i;

      // FIX: Check if the line is a direct image link before wrapping in <p>
      const contentToParse = htmlData || textData?.split(/\r?\n/).map(line => {
        const trimmed = line.trim();
        if (trimmed.startsWith('http') && imageRegex.test(trimmed)) {
          // Create an actual <img> tag for the DOMParser to identify later
          return `<img src="${trimmed}">`;
        }
        return `<p>${line}</p>`;
      }).join('') || '';

      const doc = parser.parseFromString(contentToParse, 'text/html');

      console.log("\n\nhere? \n\n", doc)
      // Iterate through top-level nodes of the pasted content
      const nodes = Array.from(doc.body.childNodes);
      console.log("\ndid tag corrupt here? \n", nodes)
      if (nodes.length > 0) {
        await this.processPastedNodes(nodes, index);
      }
    }
  }

  private async processPastedNodes(nodes: Node[], startIndex: number) {
    let currentIndex = startIndex;
    let firstBlockUsed = false;

    for (const node of nodes) {
      if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.TEXT_NODE) continue;

      const el = node as Element;
      // FIND THE IMAGE: Look at the node itself OR search inside it (for nested <img>)
      const foundImg = node.nodeType === Node.ELEMENT_NODE ?
        (el.tagName.toLowerCase() === 'img' ? el : el.querySelector('img')) : null;

      if (foundImg) {
        const src = (foundImg as HTMLImageElement).src;
        if (src) {
          currentIndex++;
          // Initialize with src so the preview works immediately
          this.addBlock('image', currentIndex, { image_url: src });

          try {
            const res = await fetch(src);
            const blob = await res.blob();
            const file = new File([blob], `pasted-${Date.now()}.png`, { type: blob.type });
            this.uploadFileAndSetUrl(file, currentIndex);
          } catch (e) {
            // Fallback handled by initialData in addBlock
          }
          continue;
        }
      }

      // HANDLE TEXT/SECTIONS: Use outerHTML to keep <section>, <ol>, <ul> intact
      const content = node.nodeType === Node.ELEMENT_NODE ?
        el.outerHTML.replace(/style="[^"]*"/g, '').trim() : node.textContent?.trim();

      if (!content || content === '<br>') continue;

      if (!firstBlockUsed && this.editors.has(currentIndex)) {
        this.editors.get(currentIndex)?.commands.insertContent(content);
        firstBlockUsed = true;
      } else {
        currentIndex++;
        this.addBlock('paragraph', currentIndex, { paragraph_text: content });
      }
    }
    this.cdr.detectChanges();
  }

  async uploadFileAndSetUrl(file: File, index: number) {
    const state = this.blockStates[index];
    state.file = file;
    state.isUploading = true;
    const deterministicUrl = `http://${this.serverIP}:8080/media/${file.name}`;
    this.contentBlocks.at(index).patchValue({ image_url: deterministicUrl });

    const reader = new FileReader();
    reader.onload = () => { state.preview = reader.result as string; this.cdr.detectChanges(); };
    reader.readAsDataURL(file);

    const formData = new FormData();
    formData.append('image', file);

    this.http.post(`${this.baseURL}/ingest/image-upload`, formData, {
      reportProgress: true, observe: 'events'
    }).subscribe({
      next: (event: any) => {
        if (event.type === HttpEventType.UploadProgress) {
          state.progress = Math.round((100 * event.loaded) / event.total);
          this.cdr.detectChanges();
        } else if (event.type === HttpEventType.Response) {
          state.isUploading = false;
        }
      },
      error: () => { state.isUploading = false; this.status = 'Upload failed.'; }
    });
  }

  loadArticleForEdit(id: string) {
    this.http.get<any>(`${this.baseURL}/articles/${id}`).subscribe(data => {
      // Patch main metadata (title, summary, author, etc.)
      this.ingestForm.patchValue({
        id: data.id,
        title: data.title,
        summary: data.summary,
        author: data.author,
        category: data.category,
        date_time: data.date_time,
        is_featured: data.is_featured,
        homepage_not_feature: data.homepage_not_feature
      });

      this.clearAllBlocks();

      // Reconstruct blocks using the data from the API
      if (data.content_blocks && data.content_blocks.length > 0) {
        data.content_blocks.forEach((block: any) => {
          // This now passes the full block data, ensuring URLs are never empty
          this.addBlock(block.type, undefined, block);
        });
      } else {
        this.addBlock('paragraph');
      }

      this.cdr.detectChanges();
    });
  }

  trackByFn(index: number, item: any) {
    return item.get('localId')?.value || index;
  }

  submit() {
    if (this.ingestForm.valid) {
      this.http.post(this.API_URL, this.ingestForm.value).subscribe({
        next: () => {
          this.status = 'Success!';
          this.isSuccess = true;
          if (!this.editingId) this.resetForm();
        },
        error: () => { this.status = 'Submission failed.'; }
      });
    }
  }

  private resetForm() {
    this.clearAllBlocks();
    this.ingestForm.reset({ date_time: this.getCurrentDateTime() });
    this.addBlock('paragraph');
  }

  get isAnyBlockUploading(): boolean {
    return this.blockStates.some(s => s.isUploading);
  }
}

```
