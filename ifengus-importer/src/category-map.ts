// ---------------------------------------------------------------------------
// Source category -> ours. Keyed on the Chinese label as printed in 本文分类.
// Anything absent from this table is NOT imported: no fallback bucket.
//
// Nine destinations, ten source buckets — the two CES feeds merge.
// ---------------------------------------------------------------------------
export const CATEGORY_MAP: Record<string, string> = {
  // renames
  '美洲':               '美洲头条',
  '非常美洲':            '美国观察',
  '精英访谈':            '天天话题',

  // CES: two source feeds, one destination
  'CES消费电子展新闻':    'CES消费电子展',
  'CES消费电子展视频':    'CES消费电子展',

  // preserved as-is
  '工商新闻':            '工商新闻',
  '悠游全攻略':          '悠游全攻略',
  '美食那些事':          '美食那些事',
  '教育资讯':            '教育资讯',
  '环球星动':            '环球星动',

  // merges into an existing destination
  '留学历程':            '教育资讯',
  '文化娱乐':            '悠游全攻略',
  '西望成都':            '悠游全攻略',
  '名人访谈':            '天天话题',
};
