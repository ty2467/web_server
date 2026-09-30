"""
Rewrite editors_db media URLs that still point at the old Mac
(http://192.168.x.x[:port]/media/<file>) to the file's real location
under /srv/media/ifengus, as /media/<path>. Then publish
editors_db.update for every changed row so the syncs re-read it.

Same pattern subtitle_sync uses: write editors_db (committed), then
send the id.

    python3 fix_lan_urls.py
"""
import os
import re

from republish import republish
from subtitle_sync import db_connect

MEDIA_ROOT = '/srv/media/ifengus'   # not /srv/media2 — that's the backup
URL_RE = re.compile(r'https?://192\.168\.[0-9.]+(?::[0-9]+)?/media/([^"]+)')
# Browser duplicate-download suffix: 'x (1).png' is really 'x.png' on disk.
DUP_SUFFIX = re.compile(r' \(\d+\)(?=\.[^.]+$)')


def disk_name(url_tail):
    return DUP_SUFFIX.sub('', url_tail.split('/')[-1])


def index_disk(names):
    found = {n: [] for n in names}
    for root, _, files in os.walk(MEDIA_ROOT):
        for f in files:
            if f in found:
                found[f].append(os.path.join(root, f))
    return found


def main():
    conn = db_connect()   # autocommit=True: every UPDATE below is committed
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, lead_image_url, content_blocks FROM editors_db "
                "WHERE CONCAT_WS(' ', lead_image_url, content_blocks) LIKE '%%192.168.%%'")
            rows = cur.fetchall()
            print(f'{len(rows)} rows with 192.168. URLs', flush=True)

            urls = {}
            for _, lead, blocks in rows:
                for m in URL_RE.finditer(f'{lead or ""} {blocks or ""}'):
                    urls[m.group(0)] = disk_name(m.group(1))
            index = index_disk(set(urls.values()))

            new_url = {}
            for old, name in urls.items():
                hits = index[name]
                if len(hits) == 1:
                    new_url[old] = '/media/' + os.path.relpath(hits[0], MEDIA_ROOT)
                else:
                    print(f'UNRESOLVED ({len(hits)} matches): {old}', flush=True)

            changed = []
            for article_id, lead, blocks in rows:
                new_lead, new_blocks = lead, blocks
                for old, new in new_url.items():
                    if new_lead:
                        new_lead = new_lead.replace(old, new)
                    if new_blocks:
                        new_blocks = new_blocks.replace(old, new)
                if (new_lead, new_blocks) != (lead, blocks):
                    cur.execute(
                        "UPDATE editors_db SET lead_image_url = %s, content_blocks = %s WHERE id = %s",
                        (new_lead, new_blocks, article_id))
                    changed.append(article_id)
                    print(f'{article_id}: rewritten', flush=True)
    finally:
        conn.close()

    if changed:
        republish(changed)


if __name__ == '__main__':
    main()
