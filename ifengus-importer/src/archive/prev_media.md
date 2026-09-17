// ---------------------------------------------------------------------------
// Node counterpart to the editor's MediaUploadService.
//
// The endpoints return no public URL; the caller composes it. That rule now
// lives in two places — here and the Angular service — and the two must stay
// identical, or editor and importer write different media_url values for the
// same file.
//
// uploadImageFromUrl is present for parity with the editor's paste path but
// unused by the importer: the archive already holds the bytes, so it uploads
// them directly rather than asking the backend to re-fetch from ifengus.
// ---------------------------------------------------------------------------

const CHUNK_SIZE = 10 * 1024 * 1024;

export interface MediaConfig {
  /** Includes /api — e.g. 'http://192.168.123.72:9000/api' */
  apiBase: string;
  /** e.g. 'http://192.168.123.72:8080/media' */
  mediaHost: string;
  cookie?: string;
}

export class MediaUploader {
  constructor(private cfg: MediaConfig) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.cfg.cookie ? { ...extra, Cookie: this.cfg.cookie } : extra;
  }

  /**
   * Local bytes -> our media host. The handler writes the multipart filename
   * verbatim into the web root, so the name given here IS the served name.
   */
  async uploadImage(bytes: Uint8Array, fileName: string, contentType = 'application/octet-stream'): Promise<string> {
    const form = new FormData();
    form.append('image', new Blob([bytes], { type: contentType }), fileName);

    const res = await fetch(`${this.cfg.apiBase}/ingest/image-upload`, {
      method: 'POST',
      headers: this.headers(),
      body: form,
      redirect: 'manual',
    });

    if (res.status === 302) throw new Error('redirected to login — session expired');
    if (!res.ok) throw new Error(`image-upload ${res.status} for ${fileName}`);

    return `${this.cfg.mediaHost}/${fileName}`;
  }

  /** Foreign URL -> our media host, fetched server-side. Editor's paste path. */
  async uploadImageFromUrl(remoteUrl: string): Promise<string> {
    const res = await fetch(`${this.cfg.apiBase}/ingest/image-from-url`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ url: remoteUrl }),
      redirect: 'manual',
    });

    if (res.status === 302) throw new Error('redirected to login — session expired');
    if (!res.ok) throw new Error(`image-from-url ${res.status}: ${await res.text()}`);

    const body = await res.json() as { fileName?: string; error?: string };
    if (!body.fileName) throw new Error(`image-from-url returned no fileName: ${body.error ?? ''}`);

    return `${this.cfg.mediaHost}/${body.fileName}`;
  }

  /**
   * Sequential is not incidental: the handler writes <fileName>.part<N> into
   * one directory and assembles on receiving the last index, so every part
   * must arrive before it.
   */
  async uploadVideoChunked(
    bytes: Uint8Array,
    fileName: string,
    onProgress?: (pct: number) => void
  ): Promise<string> {
    const total = Math.ceil(bytes.byteLength / CHUNK_SIZE);

    for (let i = 0; i < total; i++) {
      const slice = bytes.subarray(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, bytes.byteLength));

      const form = new FormData();
      form.append('chunk', new Blob([slice]), fileName);
      form.append('chunkIndex', String(i));
      form.append('totalChunks', String(total));
      form.append('fileName', fileName);

      const res = await fetch(`${this.cfg.apiBase}/ingest/video-chunk`, {
        method: 'POST',
        headers: this.headers(),
        body: form,
        redirect: 'manual',
      });

      if (res.status === 302) throw new Error('redirected to login — session expired');
      // 200 on the assembling final chunk, 202 on every chunk before it.
      if (res.status !== 200 && res.status !== 202) {
        throw new Error(`video-chunk ${i + 1}/${total} failed: ${res.status}`);
      }

      onProgress?.(Math.round(((i + 1) / total) * 100));
    }

    return `${this.cfg.mediaHost}/${fileName}`;
  }
}
