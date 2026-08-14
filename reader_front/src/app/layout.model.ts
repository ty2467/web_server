// ---------------------------------------------------------------------------
// SHARED LAYOUT VOCABULARY
//
// Lives here rather than inside home.component.ts because category.component.ts
// needs the same types. A page component importing types from another page
// component is what produced the build break when home's layout shape changed.
// ---------------------------------------------------------------------------

export interface Article {
  id: string;
  slug: string;
  title: string;
  summary: string;
  image?: string;
  video?: string;
  category: string;

  // section_zone is a MariaDB SET column. It arrives as a comma-joined string
  // in SET-DEFINITION order (never write order), e.g. 'main', 'sub_main,column',
  // 'column'. It is NOT a single value: never compare it with ===, only test
  // membership via zonesOf()/hasZone() below.
  section_zone?: string | null;

  // 排列 within the chosen front. 0 = 中心, 1 = 侧, 2 = 底.
  // Null/absent for 栏目-only articles, which have no slot.
  intra_section_zone?: number | null;
}

export const SLOT = { CENTER: 0, SIDE: 1, BOTTOM: 2 } as const;

export type FrontKey = 'main' | 'sub_main' | 'tertiary';
export const FRONT_KEYS: FrontKey[] = ['main', 'sub_main', 'tertiary'];

export interface FrontBuckets {
  center: Article[];  // 中心
  side: Article[];    // 侧
  bottom: Article[];  // 底 — always empty for 三版, which offers no 底
}

export interface MatrixColumn { category: string; articles: Article[]; }

export function emptyFront(): FrontBuckets {
  return { center: [], side: [], bottom: [] };
}

export function emptyLayout(): Record<FrontKey, FrontBuckets> {
  return { main: emptyFront(), sub_main: emptyFront(), tertiary: emptyFront() };
}

export function zonesOf(art: Article): Set<string> {
  return new Set(
    (art.section_zone ?? '').split(',').map(s => s.trim()).filter(Boolean)
  );
}

/** True when the article sits on any of the three fronts (as opposed to 栏目-only). */
export function isOnAnyFront(art: Article): boolean {
  const zones = zonesOf(art);
  return FRONT_KEYS.some(k => zones.has(k));
}
