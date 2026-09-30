import os

import pika

# handle() re-checks zone/summary, calls generate_subtitle, writes, and
# publishes the update event so the display/home_page syncs pick it up.
from subtitle_sync import EXCHANGE, db_connect, handle


def main():
    conn = db_connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
               "SELECT id FROM editors_db "
               "WHERE intra_section_zone = 0 AND (summary IS NULL OR TRIM(summary) = '') "
               "AND date_time >= '2026-07-01' "
               "ORDER BY id")
            ids = [r[0] for r in cur.fetchall()]
    finally:
        conn.close()

    print(f'backfill: {len(ids)} articles', flush=True)

    params = pika.ConnectionParameters(
        host=os.getenv('rabbit_host', 'localhost'),
        port=int(os.getenv('rabbit_mq_port', '5672')),
        credentials=pika.PlainCredentials(os.getenv('rabbit_user'), os.getenv('rabbit_pswd')),
        heartbeat=600,
    )
    rabbit = pika.BlockingConnection(params)
    ch = rabbit.channel()
    ch.exchange_declare(exchange=EXCHANGE, exchange_type='topic', durable=True)

    for i, article_id in enumerate(ids, 1):
        try:
            handle(article_id, ch)
            print(f'[{i}/{len(ids)}] {article_id} done', flush=True)
        except Exception as e:
            print(f'[{i}/{len(ids)}] {article_id} failed: {e}', flush=True)

    rabbit.close()


if __name__ == '__main__':
    main()
