#!/usr/bin/env python3
"""parse_feed.py — feed XML on stdin -> "url\\ttitle" lines (newest first, capped).

Auto-detects Atom (<entry> + <id>/<link href>) vs RSS (<item> + <link>/<guid>).
Stdlib only (regex-based for tolerance to namespaces / malformed feeds).

Usage:  cat feed.xml | parse_feed.py <max_items>
"""
import sys, re, html

cap = int(sys.argv[1]) if len(sys.argv) > 1 else 5
data = sys.stdin.read()


def clean(t: str) -> str:
    t = re.sub(r'<!\[CDATA\[(.*?)\]\]>', r'\1', t, flags=re.S)
    t = re.sub(r'<[^>]+>', '', t)
    t = html.unescape(t)
    return re.sub(r'\s+', ' ', t).strip()


def grab(block: str, tag: str) -> str:
    m = re.search(r'<%s\b[^>]*>(.*?)</%s>' % (tag, tag), block, re.S | re.I)
    return m.group(1) if m else ''


out = []
entries = re.findall(r'<entry\b.*?</entry>', data, re.S | re.I)  # Atom
if entries:
    for e in entries:
        m = (re.search(r'<link\b[^>]*rel=["\']alternate["\'][^>]*href=["\']([^"\']+)', e, re.I)
             or re.search(r'<link\b[^>]*href=["\']([^"\']+)', e, re.I))
        url = (m.group(1) if m else clean(grab(e, 'id'))).strip()
        out.append((url, clean(grab(e, 'title'))))
else:
    items = re.findall(r'<item\b.*?</item>', data, re.S | re.I)  # RSS
    for it in items:
        url = clean(grab(it, 'link')) or clean(grab(it, 'guid'))
        out.append((url, clean(grab(it, 'title'))))

n = 0
for url, title in out:
    if not url.startswith('http'):
        continue
    sys.stdout.write("%s\t%s\n" % (url, title[:160]))
    n += 1
    if n >= cap:
        break