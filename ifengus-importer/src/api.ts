// ---------------------------------------------------------------------------
// Client for writer_back. Node's fetch keeps no cookie jar, so the session is
// held by hand: log in once, capture JSESSIONID, replay it on every call.
//
// Spring Security answers an unauthenticated request with a 302 to the login
// form, not a 401. Left to itself fetch would follow that redirect and return
// a 200 carrying an HTML page — which looks like success. Hence
// redirect: 'manual' and an explicit 302 check on every call.
// ---------------------------------------------------------------------------

import type { JSONContent } from '@tiptap/core';

/** Mirrors the frontend's BlockDTO and the backend's ContentBlock. */
export interface BlockDTO {
  type: 'paragraph' | 'image' | 'video';
  order_id: number;
  content_json: JSONContent | null;
  media_url: string | null;
  caption: string | null;
  align: 'left' | 'center' | 'right' | null;
}

/** The body /api/ingest accepts — ArticleRequest on the Java side. */
export interface ArticlePayload {
  id: number | null;
  title: string;
  summary: string | null;
  author: string | null;
  category: string;
  date_time: string;            // 'yyyy-MM-ddTHH:mm'
  section_zone: string | null;
  intra_section_zone: number | null;
  lead_image_url: string | null;
  lead_image_caption: string | null;
  view_count: number;
  content_blocks: BlockDTO[];
}

export interface ApiConfig {
  /** Origin only, no /api — e.g. 'http://192.168.123.72:9000' */
  apiBase: string;
  mediaBase: string;
  username: string;
  password: string;
}

export class BackendClient {
  private cookie: string | null = null;

  constructor(private cfg: ApiConfig) {}

  /** The session cookie, for handing to MediaUploader. */
  cookieHeader(): string | undefined {
    return this.cookie ?? undefined;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.cookie ? { ...extra, Cookie: this.cookie } : extra;
  }

  private captureCookie(res: Response) {
    // getSetCookie() is the only way to see multiple Set-Cookie headers;
    // the plain .get() collapses them into one comma-joined string.
    const all = (res.headers as any).getSetCookie?.() ?? [];
    for (const raw of all) {
      if (raw.startsWith('JSESSIONID=')) this.cookie = raw.split(';')[0];
    }
  }

  async login(): Promise<void> {
    // Hit a protected endpoint first: the pre-auth session cookie Spring
    // sets there is the one the login POST expects to upgrade.
    const probe = await fetch(`${this.cfg.apiBase}/api/articles/summary`, { redirect: 'manual' });
    this.captureCookie(probe);

    const res = await fetch(`${this.cfg.apiBase}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: this.headers({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: new URLSearchParams({
        username: this.cfg.username,
        password: this.cfg.password,
      }),
    });
    this.captureCookie(res);

    if ((res.headers.get('location') ?? '').includes('error')) {
      throw new Error('login rejected — check username/password');
    }
    if (!this.cookie) {
      throw new Error(`login produced no JSESSIONID (status ${res.status})`);
    }

    // Prove it rather than assume it.
    const check = await fetch(`${this.cfg.apiBase}/api/articles/summary`, {
      headers: this.headers(),
      redirect: 'manual',
    });
    if (check.status !== 200) {
      throw new Error(`session not accepted (status ${check.status})`);
    }
  }

  async ingest(payload: ArticlePayload): Promise<number> {
    const res = await fetch(`${this.cfg.apiBase}/api/ingest`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
      redirect: 'manual',
    });

    if (res.status === 302) throw new Error('redirected to login — session expired');
    if (!res.ok) throw new Error(`ingest ${res.status}: ${await res.text()}`);

    const json = await res.json() as { id?: number; error?: string };
    if (json.id == null) throw new Error(`ingest returned no id: ${json.error ?? ''}`);
    return json.id;
  }
}
