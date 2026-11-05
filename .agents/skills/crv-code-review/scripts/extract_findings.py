#!/usr/bin/env python3
"""
extract_findings.py — recover a findings.json from a report.html built by build_report.py.

Usage:
    python3 extract_findings.py previous-report.html [out.json]

Writes out.json (default: <report-stem>-findings.json next to the report) and prints a one-line
summary to stdout. Use it to start a re-review: extract the previous findings, add a `status` to
each issue, then rebuild with `build_report.py --revise previous-report.html`.

Two recovery paths, tried in order:

1. EXACT — the report carries the original findings verbatim in a
   `<script type="application/json" id="crv-findings">` block. Lossless.

2. LOSSY FALLBACK — for reports built before that block existed. The runtime `DATA` array is
   scraped and the builder's rendering is reversed: `<p>` paragraphs are joined back into prose,
   HTML entities are unescaped, and the mermaid slot div is stripped off `htmlExtra`. Prose comes
   back readable but not byte-identical, so re-read the source before quoting it verbatim.

The fallback needs a real scanner, not a split. The report declares its runtime state as ONE
statement with comma-separated declarators:

    const DATA=[...], SEV={...}, ORDER=[...], KEY='...', SUMMARY={...};

so there is no `const SUMMARY` substring to split on, and the first `];` inside the array is not
the array's end. `_scan_json` bracket-matches while tracking string literals and escapes.
"""
import html as H
import json
import os
import re
import sys

DEFAULT_SEV_KEYS = ["high", "medium", "low", "nit", "struct", "ci"]

TONE_BY_BG = {"#fdecea": "bad", "#fff8e6": "warn", "#e6f4ea": "ok"}


def _scan_json(text, start):
    """Parse the JSON array/object that begins at text[start]. Returns (value, end_index).

    Counts only the bracket kind it opened with, and skips anything inside a string literal, so
    nested containers and brackets in prose ("[remote cache]") do not terminate the scan early.
    """
    open_ch = text[start]
    close_ch = {"[": "]", "{": "}"}.get(open_ch)
    if not close_ch:
        raise ValueError("expected '[' or '{' at offset %d, found %r" % (start, open_ch))
    depth, i, in_str, esc = 0, start, False, False
    while i < len(text):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c == open_ch:
            depth += 1
        elif c == close_ch:
            depth -= 1
            if depth == 0:
                return json.loads(text[start : i + 1]), i + 1
        i += 1
    raise ValueError("unterminated JSON starting at offset %d" % start)


def _find_value(text, decl):
    """Scan the JSON value assigned to `decl` (e.g. 'DATA' -> the array after `DATA=`)."""
    m = re.search(r"\b%s\s*=\s*(?=[\[{])" % re.escape(decl), text)
    if not m:
        return None
    return _scan_json(text, m.end())[0]


def _unesc(s):
    return H.unescape(s or "")


def _deparas(s):
    """Reverse paras(): '<p>a</p><p>b</p>' -> 'a b'."""
    if not s:
        return ""
    parts = re.findall(r"<p>(.*?)</p>", s, re.S)
    if not parts:
        parts = [s]
    return " ".join(_unesc(p).strip() for p in parts).strip()


def _tag_text(text, pattern):
    m = re.search(pattern, text, re.S)
    return _unesc(m.group(1)).strip() if m else ""


def from_embedded(text):
    """Path 1: the verbatim findings dict the builder embedded."""
    m = re.search(
        r'<script[^>]*id=["\'](?:crv|tu)-findings["\'][^>]*>(.*?)</script>', text, re.S
    )
    if not m:
        return None
    # `</script` was written as `<\/script`; JSON decodes `\/` back to `/` on its own.
    return json.loads(m.group(1).strip())


def from_data_array(text):
    """Path 2: reverse-engineer the findings from the rendered runtime state."""
    data = _find_value(text, "DATA")
    if data is None:
        return None
    sev = _find_value(text, "SEV") or {}
    order = _find_value(text, "ORDER") or []
    summary = _find_value(text, "SUMMARY")

    issues = []
    for d in data:
        raw_html = d.get("html", "") or ""
        slot = '<div class="diaslot"></div>'
        if raw_html.startswith(slot):
            raw_html = raw_html[len(slot) :]
        issue = {
            "id": d.get("id", ""),
            "sev": d.get("sev", ""),
            "title": _unesc(d.get("title", "")),
            "impact": _deparas(d.get("impact", "")),
            "fix": _deparas(d.get("fix", "")),
        }
        for src_key, dst_key in (
            ("cat", "cat"),
            ("tag", "tag"),
            ("guide", "guide"),
            ("loc", "loc"),
        ):
            val = _unesc(d.get(src_key, ""))
            if val:
                issue[dst_key] = val
        if d.get("src"):
            issue["src"] = [_unesc(s) for s in d["src"]]
        if d.get("mermaid"):
            issue["mermaid"] = d["mermaid"]
        if raw_html:
            issue["htmlExtra"] = raw_html
        # A report built by a newer builder carries these through DATA already.
        if d.get("status"):
            issue["status"] = d["status"]
        if d.get("isNew"):
            issue["isNew"] = True
        issues.append(issue)

    meta = {}
    title = _tag_text(text, r"<title>(.*?)</title>")
    h1 = _tag_text(text, r"<h1>(.*?)</h1>")
    meta["title"] = h1 or title
    subtitle = _tag_text(text, r'<span class="meta">(.*?)</span>')
    if subtitle:
        meta["subtitle"] = subtitle
    verdict = _tag_text(text, r'<span class="verdict">(.*?)</span>')
    if verdict:
        meta["verdict"] = verdict
    bg = re.search(r"\.verdict\{[^}]*background:(#[0-9a-fA-F]{6})", text)
    if bg:
        meta["verdictTone"] = TONE_BY_BG.get(bg.group(1).lower(), "bad")
    key = re.search(r"KEY\s*=\s*'([^']*)'", text)
    if key:
        meta["storageKey"] = key.group(1)

    if summary:
        if summary.get("html"):
            meta["summary"] = _deparas(summary["html"])
        if summary.get("points"):
            meta["summaryPoints"] = [_unesc(p) for p in summary["points"]]
        if summary.get("engines"):
            meta["engines"] = [
                {"name": _unesc(e.get("name", "")), "lenses": _unesc(e.get("lenses", ""))}
                if e.get("lenses")
                else _unesc(e.get("name", ""))
                for e in summary["engines"]
            ]
        if summary.get("revision"):
            meta["revision"] = summary["revision"]

    out = {"meta": meta, "issues": issues}
    # Only carry a severities array when the report overrode the defaults.
    if order and list(order) != DEFAULT_SEV_KEYS:
        out["severities"] = [
            {
                "key": k,
                "label": sev.get(k, {}).get("l", k),
                "icon": sev.get(k, {}).get("i", "•"),
                "color": sev.get(k, {}).get("c", "#555"),
                "group": sev.get(k, {}).get("g", k),
            }
            for k in order
        ]
    return out


def extract(path):
    """Returns (findings_dict, mode) where mode is 'exact' or 'lossy'."""
    text = open(path, encoding="utf-8").read()
    embedded = from_embedded(text)
    if embedded is not None:
        return embedded, "exact"
    scraped = from_data_array(text)
    if scraped is None:
        raise SystemExit(
            "could not find findings in %s — no crv-findings block and no DATA array. "
            "Is this a report built by build_report.py?" % path
        )
    return scraped, "lossy"


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        print(
            "usage: extract_findings.py previous-report.html [out.json]", file=sys.stderr
        )
        sys.exit(1)
    src = os.path.expanduser(args[0])
    findings, mode = extract(src)
    if len(args) > 1:
        out = os.path.expanduser(args[1])
    else:
        stem = os.path.splitext(src)[0]
        out = stem + "-findings.json"
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(findings, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    rev = (findings.get("meta") or {}).get("revision") or {}
    print(
        "wrote %s (%d issues, mode:%s%s)"
        % (
            out,
            len(findings.get("issues", [])),
            mode,
            ", previous revision r%s" % rev["number"] if rev.get("number") else "",
        )
    )
    if mode == "lossy":
        print(
            "NOTE: recovered by scraping the rendered DATA array, because this report predates the\n"
            "      embedded-source block. Impact/Fix prose is readable but re-paragraphed, and any\n"
            "      htmlExtra is as-rendered. Re-read the source before quoting it verbatim.",
            file=sys.stderr,
        )
