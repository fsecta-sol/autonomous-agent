#!/usr/bin/env python3
"""parse_feed.py — feed XML on stdin -> "url\\ttitle" lines (newest first, capped).

Robust to two realities:
  - Atom (<entry> + <link href> / <id>) vs RSS (<item> + <link>/<guid>).
  - fetch_url.sh returns scrapling's HTML-serialized body, which HTML-parses the
    XML: tags get lowercased and <link> is treated as a VOID element, so
    "<link>https://x</link>" becomes "<link> https://x" (closing tag dropped).
    So we must extract the permalink tolerantly, not assume well-formed XML.

Stdlib only. Usage:  cat feed.xml | parse_feed.py <max_items>
"""
import sys, re, html

cap = int(sys.argv[1]) if len(sys.argv) > 1 else 5
data = sys.stdin.read()


def clean(t: str) -> str:
    t = re.sub(r'<!\[CDATA\[(.*?)\]\]>', r'\1', t, flags=re.S)
    t = re.sub(r'<[^>]+>', '', t)
    t = html.unescape(t)
    return re.sub(r'\s+', ' ', t).strip()


def title_of(block: str) -> str:
    m = re.search(r'<title\b[^>]*>(.*?)</title>', block, re.S | re.I)
    return clean(m.group(1)) if m else ''


def url_of(block: str, atom: bool) -> str:
    if atom:
        # Atom: alternate link href, then any link href, then <id>
        for pat in (r'<link\b[^>]*rel=["\']alternate["\'][^>]*href=["\'](https?://[^"\']+)',
                    r'<link\b[^>]*href=["\'](https?://[^"\']+)',
                    r'<id\b[^>]*>\s*(https?://[^<\s]+)'):
            m = re.search(pat, block, re.I)
            if m:
                return m.group(1)
        return ''
    # RSS: <link> (proper OR HTML-void-mangled: URL as text right after <link>),
    # then <guid>. Deliberately NOT a generic href scan (would catch links
    # inside the description HTML).
    for pat in (r'<link\b[^>]*>\s*(https?://[^<\s]+)',
                r'<guid\b[^>]*>\s*(https?://[^<\s]+)'):
        m = re.search(pat, block, re.I)
        if m:
            return m.group(1)
    return ''


entries = re.findall(r'<entry\b.*?</entry>', data, re.S | re.I)  # Atom
if entries:
    blocks, atom = entries, True
else:
    blocks, atom = re.findall(r'<item\b.*?</item>', data, re.S | re.I), False  # RSS

n = 0
for b in blocks:
    url = url_of(b, atom).strip()
    if not url.startswith('http'):
        continue
    sys.stdout.write("%s\t%s\n" % (url, title_of(b)[:160]))
    n += 1
    if n >= cap:
        break