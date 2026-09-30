import base64
import json
import os
import subprocess
import tempfile

import pika     # pip install pika
import pymysql  # pip install pymysql
from dotenv import load_dotenv

from llm import generate_subtitle

load_dotenv(os.path.join(os.path.expanduser('~'), '.env'))

EXCHANGE = 'editors_db.events'
QUEUE = 'subtitle.gen'

MEDIA_ROOT = '/srv/media/ifengus'   # DB '/media/<rest>' -> MEDIA_ROOT/<rest>
AUDIO_CAP_S = 3600                  # 32 kbps mono: an hour is ~14 MB, inside the inline request limit
FRAME_POINTS = (0.25, 0.5, 0.75)    # plus one frame near the start for title cards


def db_connect():
    # Per message, not held for the process lifetime: the listener can sit
    # idle past wait_timeout.
    return pymysql.connect(
        host=os.getenv('db_location', 'localhost'),
        user=os.getenv('db_user'),
        password=os.getenv('db_pswd'),
        database='phoenix_web',
        charset='utf8mb4',
        autocommit=True,
    )


def _pm_text(node):
    """Flatten ProseMirror JSON to plain text."""
    if node.get('type') == 'text':
        return node.get('text', '')
    return ''.join(_pm_text(c) for c in node.get('content', []))


def build_input(title, lead_caption, blocks_json):
    '''
        returns (text, has_body, first_video_url). Title + captions are
        always in text; has_body says whether any paragraph had words.
    '''
    parts = [title or '', lead_caption or '']
    has_body = False
    video_url = None
    for b in json.loads(blocks_json or '[]'):
        if b.get('type') == 'paragraph' and b.get('content_json'):
            t = _pm_text(b['content_json'])
            if t.strip():
                has_body = True
            parts.append(t)
        else:
            if b.get('type') == 'video' and b.get('media_url') and video_url is None:
                video_url = b['media_url']
            if b.get('caption'):
                parts.append(b['caption'])
    return '\n'.join(p for p in parts if p.strip()), has_body, video_url


def _disk_path(media_url):
    return os.path.join(MEDIA_ROOT, media_url.split('/media/', 1)[-1].lstrip('/'))


def video_input(media_url):
    '''
        ffmpeg the local file into LangChain content blocks: one low-bitrate
        mono audio track (skipped if the video has none) + a few frames.
    '''
    path = _disk_path(media_url)
    duration = float(subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
         '-of', 'default=nw=1:nk=1', path],
        capture_output=True, text=True, check=True).stdout.strip())

    blocks = []
    with tempfile.TemporaryDirectory() as tmp:
        audio = os.path.join(tmp, 'audio.mp3')
        # No check=True: a silent clip has no audio stream and ffmpeg exits
        # non-zero; that case just goes frames-only.
        r = subprocess.run(
            ['ffmpeg', '-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '16000',
             '-b:a', '32k', '-t', str(AUDIO_CAP_S), audio],
            capture_output=True)
        if r.returncode == 0 and os.path.exists(audio) and os.path.getsize(audio) > 0:
            with open(audio, 'rb') as f:
                blocks.append({'type': 'audio', 'mime_type': 'audio/mpeg',
                               'base64': base64.b64encode(f.read()).decode()})

        points = [min(1.0, duration / 2)] + [duration * p for p in FRAME_POINTS]
        for i, t in enumerate(points):
            frame = os.path.join(tmp, f'f{i}.jpg')
            subprocess.run(
                ['ffmpeg', '-v', 'error', '-ss', f'{t:.2f}', '-i', path,
                 '-frames:v', '1', '-vf', 'scale=-2:720', '-q:v', '3', frame],
                capture_output=True)
            if os.path.exists(frame):
                with open(frame, 'rb') as f:
                    blocks.append({'type': 'image', 'mime_type': 'image/jpeg',
                                   'base64': base64.b64encode(f.read()).decode()})
    return blocks


def handle(article_id, ch):
    conn = db_connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT title, summary, intra_section_zone, lead_image_caption, content_blocks "
                "FROM editors_db WHERE id = %s", (article_id,))
            row = cur.fetchone()
            if row is None:
                return
            title, summary, zone, lead_caption, blocks = row
            if zone != 0 or (summary and summary.strip()):
                return

            text, has_body, video_url = build_input(title, lead_caption, blocks)
            media = video_input(video_url) if (not has_body and video_url) else None
            if not text and not media:
                return
            subtitle = generate_subtitle(text, media)

            # Re-check emptiness at write time: an editor may have filled the
            # summary while the LLM call was running.
            cur.execute(
                "UPDATE editors_db SET summary = %s "
                "WHERE id = %s AND (summary IS NULL OR TRIM(summary) = '')",
                (subtitle, article_id))
            written = cur.rowcount
    finally:
        conn.close()

    if written:
        # Tell EditorsDisplaySync / HomePageSync the row changed. Our own
        # queue gets this too; the summary is non-empty now, so it's skipped.
        ch.basic_publish(
            exchange=EXCHANGE,
            routing_key='editors_db.update',
            body=json.dumps({'id': article_id, 'op': 'update'}),
            properties=pika.BasicProperties(delivery_mode=2, content_type='application/json'))


def on_message(ch, method, props, body):
    try:
        evt = json.loads(body)
        if evt.get('op') != 'delete':
            handle(int(evt['id']), ch)
    except Exception as e:
        print(f'subtitle_sync: failed on {body!r}: {e}', flush=True)
    finally:
        ch.basic_ack(delivery_tag=method.delivery_tag)


def main():
    params = pika.ConnectionParameters(
        host=os.getenv('rabbit_host', 'localhost'),
        port=int(os.getenv('rabbit_mq_port', '5672')),
        credentials=pika.PlainCredentials(os.getenv('rabbit_user'), os.getenv('rabbit_pswd')),
        # The LLM call runs inside the callback and blocks heartbeats;
        # a Pro call can outlast the 60s default.
        heartbeat=600,
    )
    conn = pika.BlockingConnection(params)
    ch = conn.channel()
    ch.exchange_declare(exchange=EXCHANGE, exchange_type='topic', durable=True)
    ch.queue_declare(queue=QUEUE, durable=True)
    ch.queue_bind(queue=QUEUE, exchange=EXCHANGE, routing_key='#')
    ch.basic_qos(prefetch_count=1)
    ch.basic_consume(queue=QUEUE, on_message_callback=on_message)
    ch.start_consuming()


if __name__ == '__main__':
    main()
