#!/usr/bin/env python3
"""
build_report.py — turn a code-review findings JSON into ONE self-contained HTML report.

Usage:
    python3 build_report.py findings.json [out.html] [mermaid.min.js] [--no-open | --open]
    python3 build_report.py findings.json --revise previous-report.html [--no-open | --open]

- Flight-strip look: a white top bar (title, verdict, progress, Copy comments), a rack of finding
  strips with severity holder bands under To do / Cleared / All tabs, and the open strip on the
  right with a docked Previous / Next / Mark done bar. Light and dark follow the OS. Open Sans is inlined from
  ../assets. Check-offs persist via localStorage.
- Every issue pane carries a comment box. Comments persist under `<storageKey>:comments`,
  a commented issue shows a comment icon in the list and a Commented filter appears, and the header's
  "Copy comments" button exports every comment as one instruction block — the report's own
  file path, the PR url, the head commit, then id/severity/title/location + comment per
  finding. That block is meant to be pasted into an AI tool as the next set of actions.
  Comments live in the reader's browser, so they do not travel with the file and
  extract_findings.py does not see them.
- Diagrams are embedded as Mermaid SOURCE and rendered in-browser by the vendored
  mermaid.min.js inlined into the file. No SVG, no external assets, works offline.
- Impact / Fix prose is auto-split into readable paragraphs. They are the glance: five bold-lead
  lines (Breaks / Because / Reach, Do / Check). Long-form prose goes in `reasoning`, which renders
  collapsed under "Full reasoning". The builder warns when an issue strays from that shape.
- The input findings dict is embedded verbatim in a <script type="application/json"
  id="crv-findings"> block, so extract_findings.py can round-trip it exactly for a re-review.

Findings JSON schema (see references/findings.md):
{
  "meta": {"title": str, "subtitle": str,
           "storageKey": str,           # storageKey namespaces the localStorage check-offs
           "prUrl": str,                # ALWAYS set for a PR -> link at the top of the summary pane
           "headCommit": str,           # OPTIONAL sha reviewed -> lets the next revision skip guessing
           "revision": {...}},          # OPTIONAL -> pins a "Since last review" pane
  "severities": [                        # OPTIONAL — sensible defaults provided
     {"key","label","icon","color","group"} ...],
  "issues": [
     {"id","sev","cat"?,"verify"?,"tag"?,"guide"?,"loc"?,"title","impact","fix",
      # verify: "CONFIRMED"|"PLAUSIBLE" on high and medium; PLAUSIBLE never counts as a blocker
      "earlier"?: [{"who","loc","url"}],  # earlier review threads this finding repeats -> strip marker
      "src"?: ["claude","opencode"],           # which engines raised it -> provenance chips
      # guide?: label of the repo standard it came from (e.g. "styleguide scs-5") -> 📏 chip; cap severity at medium
      "isNew"?: true,                # found in the amended code -> own sidebar group + 🆕 chip
      "status"?: {"state": "fixed"|"external"|"dropped"|"partial"|"rebutted"|"open",
                  "note": str, "evidence": str, "commits": [str],
                  "dev": {"quote","who","when","where","verdict"}},
      "reasoning"?: str,             # long-form prose (### headings ok) -> collapsed "Full reasoning"
      "mermaid"?: "<flowchart source>", "htmlExtra"?: "<trusted raw html>"} ...]
}
The builder computes the result (Blockers found / No blockers / No findings) from the issues.
It ignores meta.verdict and meta.verdictTone, so no agent text decides the result.
meta.engines (optional): ["claude", ...] or [{"name","lenses":[...]}] -> "Reviewed by" roster
in the Overview pane.

Re-review: the three `state` values marked resolved below move an issue out of its severity group
into a collapsed "Resolved" group at the bottom, and drop it from the progress bar. The other three
keep the issue actionable.
"""
import base64, json, re, sys, html as H, os, subprocess

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lens_hash import lens_hash  # noqa: E402

SKILL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")

DEFAULT_SEVS = [
    {"key":"high","label":"High","icon":"","color":"#D52043","group":"High"},
    {"key":"medium","label":"Medium","icon":"","color":"#D87A1C","group":"Medium"},
    {"key":"low","label":"Low","icon":"","color":"#1C73A8","group":"Low"},
    {"key":"struct","label":"Design","icon":"","color":"#0F8171","group":"Design candidates"},
    {"key":"nit","label":"Nit","icon":"","color":"#795F9A","group":"Nits"},
    {"key":"ci","label":"CI","icon":"","color":"#6D7979","group":"CI"},
]

# Re-review resolution states. `r` (resolved) decides sidebar placement: resolved issues leave
# their severity group for the collapsed "Resolved" group and stop counting toward progress.
STATUSES = {
    "fixed":    {"l":"Fixed",           "i":"fixed",    "c":"#0E893C", "r":True},
    "external": {"l":"Fixed elsewhere", "i":"external", "c":"#0F8171", "r":True},
    "dropped":  {"l":"Dropped",         "i":"dropped",  "c":"#6D7979", "r":True},
    "partial":  {"l":"Partly fixed",    "i":"partial",  "c":"#D87A1C", "r":False},
    "rebutted": {"l":"Author rebutted", "i":"rebutted", "c":"#795F9A", "r":False},
    "open":     {"l":"Still open",      "i":"open",     "c":"#D52043", "r":False},
}

def esc(s): return H.escape(s or "", quote=False)

def inline(s):
    """Inline markdown on ALREADY-ESCAPED text: `code` -> <code>, **bold** -> <strong>.
    Must run after esc(), so the span contents are already HTML-safe."""
    s = re.sub(r'``([^`\n]+)``|`([^`\n]+)`', lambda m: f"<code>{m.group(1) or m.group(2)}</code>", s)
    s = re.sub(r'\*\*(\S(?:[^*]*\S)?)\*\*', r'<strong>\1</strong>', s)
    return s

def split_sentences(t):
    """Split prose on '. ' outside parentheses and inline `code` spans."""
    parts, cur, depth, in_code, i, n = [], [], 0, False, 0, len(t)
    while i < n:
        ch = t[i]
        if ch == "`":
            in_code = not in_code
            cur.append(ch); i += 1; continue
        if not in_code:
            if ch == "(": depth += 1
            elif ch == ")" and depth > 0: depth -= 1
            elif ch == "." and depth == 0:
                j = i + 1
                while j < n and t[j] == " ": j += 1
                if j > i + 1 and j < n and re.match(r"([A-Z(`]|\*\*)", t[j:]):
                    cur.append(ch)
                    parts.append("".join(cur).strip())
                    cur = []; i = j; continue
        cur.append(ch); i += 1
    tail = "".join(cur).strip()
    if tail: parts.append(tail)
    return parts

def paras(text, split_at=520):
    """Split a prose blob into <p>, <h3>, <h5>, <ul>, and .diaslot blocks, rendering inline `code` and **bold**.
    A block starting with '### ' becomes an <h5> section heading — meant for the collapsed
    `reasoning` field; impact/fix stay to five bold-lead lines (references/findings.md).
    Leading '**What it does.**' and '**Coverage.**' markers become <h3> headings, '- ' / '* '
    lines become <ul><li> bullet lists, and fenced ```mermaid blocks become .diaslot diagrams.
    Honours explicit blank lines and newlines as paragraph breaks, and within a long single-paragraph
    blob falls back to splitting at sentence boundaries (~split_at chars/para) outside parentheses
    and inline code."""
    out = []
    for chunk in re.split(r'(```mermaid\s*\n[\s\S]*?```)', text or ""):
        mm = re.match(r'^```mermaid\s*\n([\s\S]*?)```$', chunk.strip())
        if mm:
            out.append(("mermaid", mm.group(1).strip()))
            continue
        for raw_block in re.split(r'\n\s*\n', chunk):
            lines = [l.strip() for l in raw_block.splitlines() if l.strip()]
            if not lines: continue
            bullet_buf = []
            def flush_prose(t):
                if not t: return
                if t.startswith("### "):
                    out.append(("h5", t[4:].strip())); return
                cur = ""
                for s in split_sentences(t):
                    if cur and (s.startswith("**") or (len(cur) + len(s) > split_at and len(cur) >= 45 and len(s) >= 45)):
                        out.append(("p", cur)); cur = s
                    else:
                        cur = (cur + " " + s).strip()
                if cur: out.append(("p", cur))
            def flush_bullets():
                if not bullet_buf: return
                out.append(("ul", list(bullet_buf)))
                bullet_buf.clear()
            for line in lines:
                hm = re.match(r"^\*\*(What it does|Human Focus|Coverage)[.:]?\*\*\s*(.*)$", line)
                if hm:
                    flush_bullets()
                    out.append(("h3", hm.group(1)))
                    line = hm.group(2).strip()
                    if not line: continue
                bm = re.match(r"^[-*]\s+(.*)$", line)
                if bm:
                    bullet_buf.append(bm.group(1).strip())
                else:
                    flush_bullets()
                    flush_prose(line)
            flush_bullets()
    parts = []
    for k, v in out:
        if k == "ul":
            parts.append("<ul>" + "".join(f"<li>{inline(esc(x))}</li>" for x in v) + "</ul>")
        elif k == "mermaid":
            parts.append(f'<div class="diaslot"><div class="mermaid">{esc(v)}</div></div>')
        else:
            parts.append(f"<{k}>{inline(esc(v))}</{k}>")
    return "".join(parts)

RESOLVED = tuple(k for k, v in STATUSES.items() if v["r"])
VERIFY = ("CONFIRMED", "PLAUSIBLE")
def earlier_of(x):
    """The earlier review threads an issue repeats, escaped for the page: [{"who","loc","url"}].
    Entries with no reviewer are dropped; url is quote-escaped because it lands in an href."""
    out = []
    for e in x.get("earlier") or []:
        if isinstance(e, dict) and str(e.get("who") or "").strip():
            out.append({"who": esc(str(e["who"]).strip()), "loc": esc(str(e.get("loc") or "")),
                        "url": H.escape(str(e.get("url") or ""), quote=True)})
    return out

def is_open(x):
    """True unless the issue's re-review state is resolved (fixed, external, dropped)."""
    return ((x.get("status") or {}).get("state") or "open") not in RESOLVED

def review_result(findings):
    """(label, tone) from the open issues. A blocker is an open high whose verify is not PLAUSIBLE."""
    open_issues = [x for x in findings.get("issues", []) if is_open(x)]
    if any(x.get("sev") == "high" and x.get("verify") != "PLAUSIBLE" for x in open_issues):
        return "Blockers found", "bad"
    if open_issues:
        return "No blockers", "warn"
    return "No findings", "none"

LEADS_IMPACT = ("**Breaks:**", "**Because:**", "**Reach:**")
LEADS_FIX = ("**Do:**", "**Check:**")
SLOP_RE = re.compile(
    r"\b(?:delve|tapestry|testament|underscore[sd]?|pivotal|crucial|seamlessly|holistic|"
    r"paradigm|synergy|foster|elevate|beacon|landscape|interplay|intricate|meticulous|"
    r"multifaceted|overarching|robust|streamline|utilize|leverage|load-bearing|fans out|"
    r"poisons|evaporates|bolted on|earns its place|makes the call|leans on|sit with|"
    r"the estate|closes the hole|hits a wall|single pane of glass)\b",
    re.IGNORECASE,
)
NOT_X_BUT_Y_RE = re.compile(r"\bnot\s+(?:just\s+|only\s+)?[^,;.]{2,35},\s*but\s+(?:rather\s+)?", re.IGNORECASE)

def shape_warnings(findings):
    """Warn per issue when impact/fix stray from the lesson shape (references/findings.md,
    "Write each finding as one lesson") or contain banned AI filler / figurative idioms.
    Warnings only, so older findings files still build. Resolved issues are skipped."""
    msgs = []
    summary_text = (findings.get("meta") or {}).get("summary") or ""
    sm = SLOP_RE.search(summary_text)
    if sm:
        msgs.append("meta.summary: contains banned AI filler or figurative idiom '%s'" % sm.group(0))
    for x in findings.get("issues", []):
        if not is_open(x):
            continue
        # A finding carried over from an older report has a status and may predate verify.
        if x.get("sev") in ("high", "medium") and not x.get("status") and x.get("verify") not in VERIFY:
            msgs.append("%s: missing verify (CONFIRMED or PLAUSIBLE)" % x["id"])
        imp, fix = x.get("impact") or "", x.get("fix") or ""
        missing = [l for l in LEADS_IMPACT if l not in imp] + [l for l in LEADS_FIX if l not in fix]
        if missing:
            msgs.append("%s: missing %s" % (x["id"], ", ".join(missing)))
        if len(imp) > 800:
            msgs.append("%s: impact is %d chars; aim under ~700 and move detail to `reasoning`" % (x["id"], len(imp)))
        if len(fix) > 500:
            msgs.append("%s: fix is %d chars; aim under ~450 and move detail to `reasoning`" % (x["id"], len(fix)))
        prose = " ".join([x.get("title") or "", imp, fix])
        m_slop = SLOP_RE.search(prose)
        if m_slop:
            msgs.append("%s: contains banned AI filler or figurative idiom '%s' (use literal prose)" % (x["id"], m_slop.group(0)))
        if NOT_X_BUT_Y_RE.search(prose):
            msgs.append("%s: contains 'not X, but Y' contrast (state the positive claim directly)" % x["id"])
    if msgs:
        print("SHAPE: %d problem(s) in findings.json: the lesson shape (Breaks/Because/Reach + Do/Check,\n"
              "       long reasoning in `reasoning`), verify, or literal prose rules. See references/findings.md.\n  %s"
              % (len(msgs), "\n  ".join(msgs)), file=sys.stderr)
    return len(msgs)

REVIEW_FIELDS = ("repo", "pr", "base", "head")

def review_problem(raw, review):
    """What makes meta.review unusable for a feedback file, or '' when it is complete.
    raw: meta.review as written; review: the copy with pr already coerced.
    e.g. 'is missing base, head' or 'is missing head; pr is not an integer'."""
    if not isinstance(raw, dict):
        return "is missing"
    missing = [f for f in REVIEW_FIELDS if not review.get(f)]
    pr = review.get("pr")
    bad_pr = bool(pr) and (isinstance(pr, bool) or not isinstance(pr, int))
    parts = (["is missing " + ", ".join(missing)] if missing else []) + (["pr is not an integer"] if bad_pr else [])
    return "; ".join(parts)

def build_status(raw):
    """Normalise an issue's `status` for the template, or None."""
    if not raw: return None
    state = raw.get("state") or "open"
    if state not in STATUSES:
        raise SystemExit(
            "unknown status.state %r — expected one of: %s" % (state, ", ".join(STATUSES)))
    dev = raw.get("dev") or None
    if dev:
        dev = {
            "quote": esc(" ".join((dev.get("quote") or "").split())),
            "who": esc(dev.get("who", "")), "when": esc(dev.get("when", "")),
            "where": esc(dev.get("where", "")), "verdict": paras(dev.get("verdict", "")),
        }
    return {
        "state": state,
        "note": paras(raw.get("note", "")),
        "evidence": esc(" ".join((raw.get("evidence") or "").split())),
        "commits": [esc(" ".join((c or "").split())) for c in (raw.get("commits") or [])],
        "dev": dev,
    }

FONT_FILES = (("open-sans-latin.woff2", "normal"), ("open-sans-italic-latin.woff2", "italic"))

def font_css():
    """@font-face rules with Open Sans (DDS type) inlined as data URIs; empty when the files are missing."""
    base = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets")
    rules = []
    for name, style in FONT_FILES:
        path = os.path.join(base, name)
        if not os.path.exists(path):
            continue
        with open(path, "rb") as f:
            data = base64.b64encode(f.read()).decode("ascii")
        rules.append('@font-face{font-family:"Open Sans";font-style:%s;font-weight:300 800;font-stretch:75%% 100%%;font-display:swap;'
                     'src:url(data:font/woff2;base64,%s) format("woff2")}' % (style, data))
    return "\n".join(rules)

def build(findings, mermaid_js, out_path=""):
    meta = findings.get("meta", {})
    sevs = findings.get("severities") or DEFAULT_SEVS
    order = [s["key"] for s in sevs]

    issues = []
    for x in findings["issues"]:
        html_extra = x.get("htmlExtra", "") or ""
        slot = '<div class="diaslot"></div>' if x.get("mermaid") else ""
        issues.append({
            "id": x["id"], "sev": x["sev"], "cat": x.get("cat", ""),
            "verify": x.get("verify") if x.get("verify") in VERIFY else "",
            "earlier": earlier_of(x),
            "src": [esc(s) for s in (x.get("src") or [])],
            "tag": esc(x.get("tag", "")), "guide": esc(x.get("guide", "")),
            "loc": esc(x.get("loc", "")),
            "title": esc(" ".join((x["title"] or "").split())),
            "impact": paras(x.get("impact", "")), "fix": paras(x.get("fix", "")),
            "reasoning": paras(x.get("reasoning", "")),
            "mermaid": x.get("mermaid", ""), "html": slot + html_extra,
            "isNew": bool(x.get("isNew")), "status": build_status(x.get("status")),
            "strength": esc(x.get("strength", "")), "scope": esc(x.get("scope", "")), "deps": esc(x.get("deps", "")),
        })

    # Optional PR/change summary -> pinned "Overview" pane, shown by default.
    summary_raw = meta.get("summary")
    summary_points = meta.get("summaryPoints") or meta.get("changes")
    # meta.engines: ["claude", ...] or [{"name","lenses":[...]}, ...] -> "Reviewed by" roster.
    # Guard a common authoring mistake: a plain string here would iterate per-character
    # (one bullet per letter). Wrap it as a single roster entry instead.
    raw_engines = meta.get("engines") or []
    if isinstance(raw_engines, str):
        raw_engines = [raw_engines]
    engines = []
    for e in raw_engines:
        if isinstance(e, str):
            engines.append({"name": esc(e), "lenses": ""})
        else:
            lens = e.get("lenses") or ""
            if isinstance(lens, list): lens = ", ".join(lens)
            engines.append({"name": esc(e.get("name", "")), "lenses": esc(lens)})
    # meta.prUrl -> a link pinned to the top of both summary panes. Label it with the PR reference
    # when the shape is recognisable, otherwise show the URL itself:
    #   github.com/o/r/pull/1            gitlab.com/g/p/-/merge_requests/1
    #   bitbucket.org/t/r/pull-requests/1
    #   dev.azure.com/org/proj/_git/repo/pullrequest/1   -> proj/repo #1
    # The url is quote-escaped because it lands in an href="…" attribute, unlike the prose fields.
    pr_obj = None
    pr_url = (meta.get("prUrl") or "").strip()
    if pr_url:
        label = pr_url
        az = re.match(r"https?://[^/]+/[^/]+/([^/]+)/_git/([^/]+)/pullrequest/(\d+)", pr_url)
        std = re.match(
            r"https?://[^/]+/([^/]+/[^/]+?)(?:/-)?/(?:pull|pulls|merge_requests|pull-requests)/(\d+)",
            pr_url)
        if az:
            label = "%s/%s #%s" % (az.group(1), az.group(2), az.group(3))
        elif std:
            label = "%s #%s" % (std.group(1), std.group(2))
        pr_obj = {"url": H.escape(pr_url, quote=True), "label": esc(label)}

    # meta.outside: verified defects the diff does not touch -> "Outside this change" in the Overview.
    # sev "high" puts the item in a warning block at the top of the Overview.
    outside = [{"loc": esc(o.get("loc", "")), "text": inline(esc(o.get("text", ""))), "ticket": inline(esc(o.get("ticket", ""))),
                "high": o.get("sev") == "high"}
               for o in (meta.get("outside") or []) if isinstance(o, dict)]

    summary_obj = None
    # pr_obj counts: a PR link alone is reason enough to pin the Overview pane, so the link still
    # has somewhere to render when there is no summary prose.
    if summary_raw or summary_points or engines or meta.get("headCommit") or pr_obj or outside or meta.get("mermaid"):
        summary_obj = {
            "html": paras(summary_raw) if summary_raw else "",
            "mermaid": meta.get("mermaid", ""),
            "points": [inline(esc(" ".join((p or "").split()))) for p in (summary_points or [])],
            "engines": engines,
            "headCommit": esc(meta.get("headCommit", "")),
            "outside": outside,
        }

    # Optional revision block -> pinned "Since last review" pane, shown by default when present.
    rev = meta.get("revision")
    rev_obj = None
    if rev:
        rev_obj = {
            "number": int(rev.get("number", 2)),
            "html": paras(rev.get("summary", "")),
            "prev": esc(rev.get("previousReport", "")),
            "reviewedAt": esc(rev.get("reviewedAt", "")),
            "reviewedCommit": esc(rev.get("reviewedCommit", "")),
            "headCommit": esc(rev.get("headCommit", "")),
            "commits": [esc(" ".join((c or "").split())) for c in (rev.get("commits") or [])],
        }

    # meta.review: what produced the review, copied into the feedback file. lensHash names the lens text.
    raw_review = meta.get("review")
    review = dict(raw_review) if isinstance(raw_review, dict) else {}
    if isinstance(review.get("pr"), str) and review["pr"].strip().isdigit():
        review["pr"] = int(review["pr"].strip())
    if pr_url:
        problem = review_problem(raw_review, review)
        if problem:
            print("WARNING: meta.review %s; the Download feedback button is hidden." % problem, file=sys.stderr)
            review.pop("pr", None)
    review["lensHash"] = lens_hash(SKILL_DIR)
    lens_dir = os.path.join(SKILL_DIR, "lenses")
    lenses = sorted(n[:-3] for n in os.listdir(lens_dir) if n.endswith(".md")) if os.path.isdir(lens_dir) else []

    result, tone = review_result(findings)

    markers = {
        "__TITLE__": esc(meta.get("title","Code review")),
        "__SUBTITLE__": esc(meta.get("subtitle","")),
        "__VERDICT__": esc(result),
        "__VTONE__": tone,
        "__STORAGE__": esc(meta.get("storageKey","crv-report-done")),
        "__SEV__": json.dumps({s["key"]: {"i": s["icon"], "l": s["label"], "c": s["color"],
                                          "g": s["group"]} for s in sevs}, ensure_ascii=False),
        "__ORDER__": json.dumps(order),
        "__STAT__": json.dumps(STATUSES, ensure_ascii=False),
        "__DATA__": json.dumps(issues, ensure_ascii=False),
        "__SUMMARY__": json.dumps(summary_obj, ensure_ascii=False),
        "__REVISION__": json.dumps(rev_obj, ensure_ascii=False),
        "__PR__": json.dumps(pr_obj, ensure_ascii=False),
        "__REVIEW__": json.dumps(review, ensure_ascii=False).replace("</", "<\\/"),
        "__LENSES__": json.dumps(lenses),
        # Identity for the "Copy comments" export. `path` is where this build wrote the file; the
        # page prefers its own location.pathname at runtime so a moved or copied report still
        # names itself correctly.
        "__EXPORTMETA__": json.dumps({
            "path": os.path.abspath(os.path.expanduser(out_path)) if out_path else "",
            "head": (meta.get("headCommit") or "").strip(),
            "title": (meta.get("title") or "Code review").strip(),
        }, ensure_ascii=False),
        # Verbatim source so extract_findings.py can round-trip losslessly. `</script` must not
        # close our block; `<\/script` is a legal JSON escape that decodes back to `</script`.
        "__SOURCE_JSON__": json.dumps(findings, ensure_ascii=False).replace("</script", "<\\/script"),
    }
    # ONE pass, so a replacement's own content is never rescanned for markers (findings prose can
    # legitimately contain a __LIKE_THIS__ token).
    out = re.sub(r"__[A-Z_]+__", lambda m: markers.get(m.group(0), m.group(0)), TEMPLATE)
    # Mermaid is injected separately: its marker carries /* */ delimiters that must go too,
    # otherwise the whole library ends up inside a comment.
    out = out.replace("/*__FONTS__*/", font_css())
    return out.replace("/*__MERMAID_LIB__*/", (mermaid_js or "").replace("</script", "<\\/script"))

TEMPLATE = r'''<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<meta name=color-scheme content="light dark">
<title>__TITLE__</title>
<style>
/*__FONTS__*/
/* Flight progress strips: each finding is a strip with fixed fields and a coloured holder band. */
:root{
  --font:"Open Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
  --ground:#EEF2F5;--panel:#FFFFFF;--well:#EEF3F2; /* ground sampled from the approved comp */
  --ink:#212121;--ink2:#515151;--rule:#E3E6E5;--line:#ACB7B5;--outline:#6D7979;
  --green:#0F7936;--green-press:#0A5124;--on-green:#FFFFFF; /* DDS Primary/Green/600 and 700 */
  --green-tint:#E5F6E5;--link:#096B2F;
  --s-high:#D52043;--s-high-tint:#F7E4E6;--s-high-ink:#A01832;
  --s-medium:#D87A1C;--s-medium-tint:#FBE4CF;--s-medium-ink:#864E01;--s-medium-text:#BA5C12;--pill-warn-bg:#F8E9D8;--pill-warn-line:#C9A57A;--pill-warn-ink:#8A5A28;
  --s-low:#1C73A8;--s-low-tint:#D7EBF6;--s-low-ink:#15567E;
  --s-nit:#795F9A;--s-nit-tint:#F0E3F6;--s-nit-ink:#5B4774;
  --s-struct:#0F8171;--s-struct-tint:#E1F7F1;--s-struct-ink:#0A6458;
  --s-ci:#6D7979;--s-ci-tint:#EEF3F2;--s-ci-ink:#3F494B;
  --st-fixed:#055222;--st-external:#0A6458;--st-dropped:#3F494B;--st-partial:#864E01;--st-rebutted:#5B4774;--st-open:#A01832;
  --plus:#0E893C;--minus:#D52043;
  --strip-shadow:0 1px 2px rgba(0,0,0,.06);
}
@media (prefers-color-scheme:dark){:root{
  --ground:#19232A;--panel:#1D292F;--well:#222F34;
  --ink:#FFFFFF;--ink2:rgba(255,255,255,.8);--rule:#2B393B;--line:#4D5F5F;--outline:#8EA4A0;
  --green:#34B550;--green-press:#5ACB6D;--on-green:#212121;--green-tint:#003114;--link:#81E38D;
  --s-high:#F37589;--s-high-tint:#69021F;--s-high-ink:#F37589;
  --s-medium:#F4AA37;--s-medium-tint:#6A2A02;--s-medium-ink:#F4AA37;--s-medium-text:#F4AA37;--pill-warn-bg:#6A2A02;--pill-warn-line:#F4AA37;--pill-warn-ink:#F4AA37;
  --s-low:#319FCA;--s-low-tint:#01325C;--s-low-ink:#62B7E0;
  --s-nit:#B987D7;--s-nit-tint:#392364;--s-nit-ink:#B987D7;
  --s-struct:#2EB498;--s-struct-tint:#002E2C;--s-struct-ink:#2EB498;
  --s-ci:#8EA4A0;--s-ci-tint:#2B393B;--s-ci-ink:#8EA4A0;
  --st-fixed:#34B550;--st-external:#2EB498;--st-dropped:#8EA4A0;--st-partial:#F4AA37;--st-rebutted:#B987D7;--st-open:#F37589;
  --plus:#34B550;--minus:#F37589;
  --strip-shadow:0 1px 2px rgba(0,0,0,.4);
}}
html{font-size:clamp(14.9px,calc(100vw * 16 / 1376),18.6px)}
@media (max-width:1100px){html{font-size:15px}}
@media (max-width:760px){html{font-size:16px}}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{font-family:var(--font);font-stretch:93%;font-size:0.9375rem;line-height:1.375rem;color:var(--ink);background:var(--panel);
  display:flex;flex-direction:column;height:100vh;overflow:hidden;-webkit-font-smoothing:antialiased;
  caret-color:var(--green);scrollbar-color:var(--line) transparent}
::selection{background:var(--green-tint);color:var(--ink)}
:focus-visible{outline:2px solid var(--green);outline-offset:2px}
a{color:var(--link);text-underline-offset:0.1875rem}
button{font:inherit;color:inherit}
code{font-family:var(--mono);font-size:.84em;line-height:1;background:var(--well);color:var(--ink);padding:1px 0.3125rem;border-radius:0.25rem;overflow-wrap:anywhere}
pre{margin:0;font-family:var(--mono);font-size:0.8125rem;line-height:1.55;white-space:pre-wrap;background:var(--well);border-radius:0.375rem;padding:0.625rem 0.75rem;overflow:auto}
.ic{width:1.125rem;height:1.125rem;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round;flex:0 0 auto}
.num{font-variant-numeric:tabular-nums}

/* Top bar */
.bar{flex:0 0 auto;height:3.875rem;display:flex;align-items:center;gap:1rem;padding:0 1.5rem 0 0.875rem;background:var(--panel);border-bottom:1px solid var(--rule)}
.ovbtn{display:inline-flex;align-items:center;gap:0.375rem;height:2.125rem;padding:0 0.75rem 0 0.625rem;border:1px solid var(--line);border-radius:0.375rem;background:var(--panel);color:var(--ink);font-size:0.9375rem;font-weight:600;cursor:pointer;flex:0 0 auto}
.ovbtn:hover{border-color:var(--outline);background:var(--well)}
.ovbtn[aria-pressed="true"]{background:var(--green-tint);border-color:var(--green);color:var(--link)}
.ovbtn .ic{width:1.125rem;height:1.125rem}
.back{width:2rem;height:2rem;display:inline-flex;align-items:center;justify-content:center;border:0;background:none;border-radius:0.375rem;color:var(--ink2);cursor:pointer;flex:0 0 auto}
.back:hover{background:var(--well);color:var(--ink)}
.back .ic{width:1.375rem;height:1.375rem}
.who{flex:1 1 auto;min-width:0}
.who h1{font-stretch:100%;margin:0;font-size:1.25rem;line-height:1.625rem;font-weight:700;letter-spacing:-.005em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.who .sub{display:flex;align-items:center;gap:0.5rem;font-size:0.9375rem;line-height:1.25rem;color:var(--ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.who .sub .p{color:var(--plus)}.who .sub .m{color:var(--minus)}
.rev{font-size:0.75rem;font-weight:700;border:1px solid var(--line);border-radius:62.4375rem;padding:0 0.5rem;color:var(--ink2)}
.verdict{display:inline-flex;align-items:center;height:2.1875rem;padding:0 0.875rem;border-radius:62.4375rem;font-size:1rem;font-weight:500;white-space:nowrap;border:1px solid;flex:0 0 auto}
.verdict.v-bad{background:var(--s-high-tint);color:var(--s-high-ink);border-color:var(--s-high)}
.verdict.v-warn{background:var(--pill-warn-bg);color:var(--pill-warn-ink);border-color:var(--pill-warn-line)}
.verdict.v-ok{background:var(--green-tint);color:var(--link);border-color:var(--green)}
.verdict.v-none{background:var(--well);color:var(--ink);border-color:var(--line)}
.prog{display:flex;flex-direction:column;gap:0.375rem;width:8.125rem;flex:0 0 auto}
#pcount{font-variant-numeric:tabular-nums;font-size:1rem;line-height:1.125rem;color:var(--ink)}
.track{height:0.375rem;border-radius:0.375rem;background:var(--rule);overflow:hidden}
.track>i{display:block;height:100%;background:var(--green);transform-origin:left;transform:scaleX(0);transition:transform .4s cubic-bezier(.16,1,.3,1)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:0.5rem;height:2.1875rem;padding:0 0.875rem;border-radius:0.375rem;font-size:1rem;font-weight:500;cursor:pointer;white-space:nowrap;flex:0 0 auto}
.btn.primary{background:var(--green);color:var(--on-green);border:0}
.btn.primary:hover:not(:disabled){background:var(--green-press)}
.btn.primary:disabled{background:var(--well);color:var(--ink2);cursor:default}
.btn.ghost{background:var(--panel);color:var(--ink);border:1px solid var(--line)}
.btn.ghost:hover{border-color:var(--outline);background:var(--well)}

/* Work area: the strip rack on the left, the open strip on the right. */
.app{flex:1 1 auto;display:grid;grid-template-columns:var(--rack-w,minmax(0,1fr)) minmax(0,1fr);min-height:0}
.rackcol{background:var(--ground);display:flex;flex-direction:column;min-height:0;min-width:0}
.tabsrow{display:flex;align-items:flex-end;gap:0.75rem;margin:0.875rem 1.5rem 0;border-bottom:1px solid var(--rule)}
.tabs{display:flex;gap:1.375rem}
.tabs button{display:inline-flex;align-items:center;gap:0.5rem;height:1.875rem;padding:0 0 0.375rem;border:0;background:none;cursor:pointer;
  font-size:1rem;font-weight:500;color:var(--ink2);border-bottom:2px solid transparent;margin-bottom:-1px}
.tabs button:hover{color:var(--ink)}
.tabs button.on{color:var(--ink);font-weight:600;border-bottom-color:var(--ink)}
.cnt{font-variant-numeric:tabular-nums;display:inline-flex;align-items:center;justify-content:center;min-width:1.375rem;height:1.25rem;padding:0 0.375rem;border-radius:62.4375rem;background:var(--rule);font-size:0.8125rem;font-weight:600;color:var(--ink)}
.ftoggle{margin-left:auto;display:inline-flex;align-items:center;gap:0.375rem;height:1.75rem;padding:0 0.5rem 0.25rem;border:0;background:none;cursor:pointer;font-size:0.875rem;font-weight:600;color:var(--ink2)}
.ftoggle:hover,.ftoggle[aria-expanded="true"]{color:var(--ink)}
.ftoggle .ic{width:1rem;height:1rem}
.filters{display:none;flex-wrap:wrap;gap:0.5rem;margin:0.625rem 1.5rem 0}
.filters.open{display:flex}
.filters button{display:inline-flex;align-items:center;gap:0.375rem;height:1.75rem;padding:0 0.625rem;border-radius:62.4375rem;border:1px solid var(--line);background:var(--panel);cursor:pointer;font-size:0.8125rem;font-weight:600;color:var(--ink2)}
.filters button.on{border-color:var(--green);color:var(--link);background:var(--green-tint)}
.filters button:disabled{opacity:.45;cursor:default}
.filters i{width:0.5rem;height:0.5rem;border-radius:50%;display:block}
.filters .ic{width:0.9375rem;height:0.9375rem}
.rack{flex:1 1 auto;overflow:auto;padding:0.75rem 1.4375rem 1.5rem}
.rackhead{display:flex;align-items:center;gap:0.5rem;font-size:1rem;font-weight:500;color:var(--ink);margin:1.625rem 1px 0.625rem}
/* The strip: fixed fields, a holder band in the severity colour. */
.strip{position:relative;display:grid;grid-template-columns:2.125rem minmax(0,1fr) auto;align-items:center;column-gap:0.875rem;
  min-height:4.625rem;margin:0 0 0.625rem;padding:0.625rem 1.125rem 0.625rem 1.625rem;background:var(--panel);border:1px solid var(--rule);border-radius:0.375rem;
  box-shadow:var(--strip-shadow);cursor:pointer}
.strip::before{content:"";position:absolute;left:-1px;top:-1px;bottom:-1px;width:0.5rem;border-radius:0.375rem 0 0 0.375rem;background:var(--band)}
.strip:hover{border-color:var(--line)}
.strip.active{border:2px solid var(--green);padding:0.5625rem 1.0625rem 0.5625rem 1.5625rem}
.strip.active::before{left:-2px;top:-2px;bottom:-2px}
.sid{width:2.125rem;height:2.125rem;display:inline-flex;align-items:center;justify-content:center;border-radius:0.25rem;border:1px solid var(--band);
  background:var(--tint);color:var(--ink2);font-weight:700;font-size:0.9375rem;color:var(--idink)}
.sbody{min-width:0;display:flex;flex-direction:column;gap:0.1875rem}
.stitle{font-stretch:94%;letter-spacing:-.005em;font-size:0.9375rem;line-height:1.375rem;font-weight:700;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stitle code,.dtitle code{font-size:.9em;font-weight:600;background:var(--well)}
.smeta{display:flex;gap:1.125rem;font-size:0.8125rem;line-height:1.125rem;color:var(--ink);white-space:nowrap;overflow:hidden}
.smeta .lens{text-transform:uppercase;font-size:0.75rem;letter-spacing:.02em;color:var(--ink2)}
.smeta .loc{overflow:hidden;text-overflow:ellipsis}
.salso{display:flex;min-width:0;margin-top:0.3125rem}
.salso .also{display:inline-flex;align-items:center;gap:0.25rem;min-width:0;max-width:100%;padding:0 0.4375rem;border:1px solid var(--line);border-radius:0.625rem;background:var(--well);color:var(--ink2);font-size:0.75rem;line-height:1.125rem}
.salso .alsot{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.salso .ic{width:0.875rem;height:0.875rem;flex-shrink:0}
.alsolist{display:flex;flex-direction:column;gap:0.125rem}
.alsolist a{display:inline-flex;align-items:center;gap:0.25rem}
.alsolist .ic{width:0.875rem;height:0.875rem;flex-shrink:0}
.sflags{display:flex;align-items:center;gap:0.625rem}
.sflag,.cflag{display:flex}.sflag{color:var(--ink2)}.cflag{color:var(--link)}
.sflag .ic,.cflag .ic{width:1.0625rem;height:1.0625rem}
.strip .chk{appearance:none;-webkit-appearance:none;width:1.25rem;height:1.25rem;margin:0;border:1.5px solid var(--outline);border-radius:0.1875rem;background:var(--panel);cursor:pointer;display:grid;place-content:center;flex:0 0 auto;transition:background-color .2s,border-color .2s}
.strip .chk:hover{border-color:var(--green)}
.strip .chk:checked{width:1.5rem;height:1.5rem;border-radius:50%;border-color:var(--green);background:var(--green)}
.strip .chk:checked::after{content:"";width:0.375rem;height:0.6875rem;border:solid var(--on-green);border-width:0 0.1562rem 0.1562rem 0;transform:translateY(-1px) rotate(45deg);animation:tick .22s cubic-bezier(.16,1,.3,1)}
@keyframes tick{from{opacity:0;transform:translateY(-1px) rotate(45deg) scale(.4)}to{opacity:1;transform:translateY(-1px) rotate(45deg) scale(1)}}
.strip.done{background:color-mix(in srgb,var(--panel) 55%,var(--ground));box-shadow:none}
.strip.done::before{opacity:.45}
.strip.done .sid{opacity:.5}
.strip.done .stitle,.strip.done .smeta,.strip.done .smeta .lens{color:var(--ink2)}.strip.done .stitle{font-weight:600}
.strip.res .sbody,.strip.res .sid{opacity:.6}
.strip.ov{grid-template-columns:2.125rem minmax(0,1fr)}
.empty{color:var(--ink2);font-size:0.9375rem;padding:1.5rem 2px}

.pane{position:relative;display:flex;flex-direction:column;min-height:0;min-width:0;border-left:1px solid var(--rule);background:var(--panel)}
/* Divider handle: drag, or arrow keys when focused; double-click resets. */
.resizer{position:absolute;left:-0.375rem;top:0;bottom:0;width:0.75rem;cursor:col-resize;z-index:5;touch-action:none;outline:none}
.resizer::after{content:"";position:absolute;left:0.3125rem;top:0;bottom:0;width:2px;background:transparent;transition:background-color .15s}
.resizer:hover::after,.resizer:focus-visible::after,body.resizing .resizer::after{background:var(--green)}
body.resizing{cursor:col-resize;user-select:none}
main{flex:1 1 auto;overflow:auto;padding:1.25rem 1.625rem 2rem 1.6875rem;scrollbar-gutter:stable}
.finding{width:100%;max-width:none}
.dtitle{font-stretch:100%;margin:0;font-size:1.4375rem;line-height:1.75rem;font-weight:700;letter-spacing:-.01em}
.facts{display:flex;flex-wrap:wrap;gap:0.5rem 1.125rem;margin:0.625rem 0 0}
.fact{display:flex;flex-direction:column;min-width:0}
.fact .fl{font-size:0.7812rem;line-height:1rem;text-transform:uppercase;letter-spacing:.02em;color:var(--ink2)}
.fact .fv{font-size:0.9375rem;line-height:1.125rem;color:var(--ink);overflow-wrap:anywhere}
.fact .fv.sev{font-weight:500}
.fact.loc{flex:1 1 18.75rem}
.tag{display:inline-flex;align-items:center;gap:0.375rem;font-weight:600}
.tag .ic{width:0.9375rem;height:0.9375rem}
.prlink{display:inline-flex;align-items:center;gap:0.375rem;font-weight:600;font-size:0.9375rem}
.prlink .ic{width:1rem;height:1rem}
.block{margin:1.25rem 0 0}
.block.outhigh{padding:0.875rem 1rem;background:var(--s-high-tint);border:1px solid var(--s-high);border-radius:0.5rem}
.block.outhigh h3{color:var(--s-high-ink)}
.block+.block{margin-top:2.0625rem}
.block h3{margin:0 0 0.6875rem;font-size:1.25rem;line-height:1.5625rem;font-weight:700}
.block h3:not(:first-child){margin-top:2.0625rem}
.block p{margin:0 0 0.75rem;font-size:0.9688rem;line-height:1.5rem;font-weight:400}.block p:last-child{margin-bottom:0}
.block p strong{font-weight:700}
.block h5{margin:1.125rem 0 0.375rem;font-size:1rem;font-weight:700}
.block ul{margin:0 0 0.75rem;padding-left:1.25rem;font-size:0.9688rem;line-height:1.5rem}.block ul:last-child{margin-bottom:0}.block li{margin:0 0 0.375rem}
.block.since{width:100%;background:var(--ground);border-radius:0.375rem;padding:0.875rem 1rem}
blockquote.dev{margin:0.75rem 0 0;padding:0.625rem 0.875rem;background:var(--panel);border:1px solid var(--rule);border-radius:0.375rem;font-style:italic}
blockquote.dev footer{margin-top:0.375rem;font-style:normal;font-size:0.8125rem;color:var(--ink2)}
.nextcard{margin:1.25rem 0 0;width:100%}
.diaslot{margin:1.125rem 0;width:100%}.diaslot svg{max-width:100%;height:auto;display:block}
.tblwrap{margin:0.5rem 0;width:100%}
.panels{display:flex;gap:0.875rem;flex-wrap:wrap;margin-top:0.625rem}
.panel{flex:1;min-width:17.5rem;border-radius:0.375rem;padding:0.75rem 0.875rem}
.panel.bad{background:var(--s-high-tint)}.panel.good{background:var(--green-tint)}
.ptitle{font-weight:700;margin-bottom:0.375rem}
.note{font-size:0.8125rem;color:var(--ink2);margin-top:0.375rem}.note2{color:var(--ink2);font-size:0.875rem}
.reasoning{margin:1.25rem 0 0;width:100%;border-top:1px solid var(--rule);padding-top:0.75rem;font-size:0.9375rem;line-height:1.4375rem;color:var(--ink2)}
.reasoning summary{cursor:pointer;font-weight:600;color:var(--ink);display:flex;align-items:center;gap:0.375rem;list-style:none}
.reasoning summary::-webkit-details-marker{display:none}
.reasoning summary .ic{transition:transform .2s}.reasoning[open] summary .ic{transform:rotate(90deg)}
.reasoning p{margin:0.5rem 0}
.vtbl{border-collapse:collapse;width:100%;font-size:0.9375rem;font-variant-numeric:tabular-nums}
.vtbl th,.vtbl td{border-bottom:1px solid var(--rule);padding:0.5rem 0.375rem;text-align:left}
.vtbl thead th{font-size:0.75rem;text-transform:uppercase;color:var(--ink2);font-weight:600}
.vtbl td .ic{vertical-align:-4px;margin-right:0.5rem}
.vtbl .bw{color:var(--s-high-ink);font-weight:600}.vtbl .gone{color:var(--s-medium-ink);font-style:italic}
.cmt{margin:1.5625rem 0 0}
.cmt label{display:block;margin:0 0 0.375rem;font-size:1.0625rem;line-height:1.375rem;font-weight:600}
.cmt textarea{display:block;width:100%;min-height:2.25rem;resize:vertical;font:inherit;font-size:1rem;line-height:1.25rem;color:var(--ink);
  background:var(--panel);border:1px solid var(--outline);border-radius:0.375rem;padding:0.5rem 0.75rem}
.cmt textarea::placeholder{color:var(--ink2);opacity:.85}
.cmt textarea:focus{outline:none;border-color:var(--green);box-shadow:0 0 0 0.1875rem var(--green-tint)}
.rate{margin:1.25rem 0 0;display:flex;flex-direction:column;align-items:flex-start;gap:0.5rem}
.rate .rl{font-size:1.0625rem;line-height:1.375rem;font-weight:600}
.rbtns{display:flex;flex-wrap:wrap;gap:0.5rem}
.chip{height:2rem;padding:0 0.875rem;border-radius:1rem;border:1px solid var(--line);background:var(--panel);color:var(--ink);font:inherit;font-size:0.9375rem;cursor:pointer}
.chip:hover{border-color:var(--outline);background:var(--well)}
.chip.on{background:var(--green-tint);border-color:var(--green);font-weight:600}
.rsub{display:flex;align-items:center;gap:0.5rem;font-size:0.9375rem}
.rhint{font-size:0.875rem;color:var(--ink2)}
.rnote,.rsub select,.mform input,.mform select,.mform textarea{font:inherit;font-size:0.9375rem;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:0.375rem;padding:0.375rem 0.5rem}
.rnote{width:100%;max-width:32rem}
.mform .mrow{display:flex;flex-direction:column;gap:0.25rem;margin:0 0 0.75rem;font-size:0.9375rem;font-weight:600}
.mform .mrow textarea{width:100%;resize:vertical}
.mform .mrow2{display:flex;flex-wrap:wrap;align-items:flex-end;gap:0.75rem;font-size:0.9375rem;font-weight:600}
.mform .mrow2 label{display:flex;flex-direction:column;gap:0.25rem}
.block .mlist{list-style:none;margin:0.875rem 0 0;padding:0;display:flex;flex-direction:column;gap:0.5rem}
.block .mlist li{display:grid;grid-template-columns:2rem minmax(0,1fr) auto;align-items:start;column-gap:0.75rem;margin:0;padding:0.625rem 0.75rem;background:var(--ground);border:1px solid var(--rule);border-radius:0.375rem}
.mid{width:2rem;height:1.75rem;display:inline-flex;align-items:center;justify-content:center;border-radius:0.25rem;border:1px solid var(--line);background:var(--panel);font-weight:700;font-size:0.8125rem;color:var(--ink2);font-variant-numeric:tabular-nums}
.mbody{min-width:0;display:flex;flex-direction:column;gap:0.25rem}
.mtext{font-size:0.9375rem;line-height:1.375rem;color:var(--ink);white-space:pre-wrap;overflow-wrap:anywhere}
.mmeta{display:flex;flex-wrap:wrap;align-items:center;gap:0.375rem 0.75rem;font-size:0.8125rem;line-height:1.125rem;color:var(--ink2)}
.mmeta .lens{text-transform:uppercase;font-size:0.75rem;letter-spacing:.02em;font-weight:600}
.cmt .row{display:flex;align-items:flex-start;gap:0.625rem;margin-top:2px;min-height:1.25rem}
.cmt .hint{font-size:0.9062rem;line-height:1.25rem;color:var(--ink2)}
.clr{height:1.5rem;padding:0 0.5rem;border-radius:0.375rem;border:0;background:none;cursor:pointer;font:inherit;font-size:0.875rem;font-weight:600;color:var(--link);margin-left:auto}
.clr:hover{background:var(--green-tint)}
.dock{flex:0 0 auto;height:3.875rem;display:flex;align-items:center;gap:0.5rem;padding:0.75rem 1.5625rem 0.75rem 1.6875rem;border-top:1px solid var(--rule);background:var(--panel)}
.dock .btn{height:2.3125rem}
.keys{font-size:0.8125rem;color:var(--ink2);margin-left:0.5rem}
.keys kbd{font-family:var(--font);font-size:0.75rem;font-weight:600;border:1px solid var(--line);border-radius:0.25rem;padding:0 0.3125rem}
#markDone{margin-left:auto}
#markDone.is-done{background:var(--green-tint);color:var(--link)}

.modal{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;padding:1.5rem;z-index:50}
.modal .box{background:var(--panel);color:var(--ink);border-radius:0.5rem;max-width:51.25rem;width:100%;max-height:80vh;display:flex;flex-direction:column;padding:1.125rem;gap:0.75rem;box-shadow:0 0.5rem 2rem rgba(0,0,0,.2)}
.modal h3{margin:0;font-size:1.0625rem}
.modal textarea{flex:1 1 auto;min-height:20rem;font-family:var(--mono);font-size:0.75rem;line-height:1.5;background:var(--well);color:var(--ink);border:0;border-radius:0.375rem;padding:0.625rem}

@media (max-width:1100px){.app{grid-template-columns:var(--rack-w,minmax(18.75rem,2fr)) minmax(0,3fr)}.prog{width:6.875rem}.verdict{font-size:0.875rem;padding:0 0.75rem}}
@media (max-width:760px){
  .bar{height:auto;flex-wrap:wrap;padding:0.625rem 0.875rem;gap:0.5rem 0.75rem}
  .who{flex:1 1 calc(100% - 3.125rem)}
  .who h1{font-size:1.0625rem;line-height:1.375rem;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .who .sub{font-size:0.8125rem}
  .ovbtn .ol{display:none}.ovbtn{padding:0 0.5rem}
  .verdict{height:1.875rem;font-size:0.875rem;padding:0 0.75rem;margin-left:2.875rem}
  .prog{width:6rem}#pcount{font-size:0.875rem}
  .btn{font-size:0.9375rem}
  #copyCmt{margin-left:auto}
  body.show-detail .verdict,body.show-detail .prog,body.show-detail #copyCmt{display:none}
  .app{grid-template-columns:minmax(0,1fr)}
  .pane{display:none;border-left:0}
  .resizer{display:none}
  body.show-detail .rackcol{display:none}
  body.show-detail .pane{display:flex}
  .tabsrow{margin:0.75rem 0.875rem 0}.filters{margin:0.625rem 0.875rem 0}.rack{padding:0.625rem 0.8125rem 1.25rem}
  .strip{padding-left:1.375rem;column-gap:0.75rem}
  .stitle{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  main{padding:1.125rem 1rem 1.75rem}
  .dock{padding:0.625rem 0.875rem}
  .keys{display:none}
  .dtitle{font-size:1.3125rem;line-height:1.6875rem}
}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
</style></head><body>
<header class="bar">
  <button class="ovbtn" id="ovbtn" type="button" aria-pressed="false" title="What this change does"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8.5L19 7.5V21H6z"/><path d="M14 3v5h5M9.5 13h6M9.5 17h4"/></svg><span class="ol">Overview</span></button>
  <button class="back" id="back" type="button" aria-label="Back to findings" title="Back to findings" style="display:none"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>
  <div class="who"><h1>__TITLE__</h1><div class="sub"><span id="subline">__SUBTITLE__</span><span class="rev" id="revchip" style="display:none"></span></div></div>
  <span class="verdict v-__VTONE__" id="result" title="Computed from the findings. The review never approves a pull request.">__VERDICT__</span>
  <div class="prog"><span id="pcount" class="num">0 of 0 done</span><span class="track"><i id="pbar"></i></span></div>
  <button id="dlFb" class="btn ghost" type="button" disabled>Download feedback</button>
  <button id="copyCmt" class="btn primary" disabled>Copy comments</button>
</header>
<div class="app">
  <nav class="rackcol" aria-label="Findings">
    <div class="tabsrow"><div class="tabs" role="tablist" id="tabs"></div>
      <button class="ftoggle" id="ftoggle" type="button" aria-expanded="false" aria-controls="filters"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg>Filter</button></div>
    <div class="filters" id="filters"></div>
    <div class="rack list" id="list"></div>
  </nav>
  <section class="pane"><div class="resizer" id="resizer" role="separator" aria-orientation="vertical" aria-label="Resize the findings list" aria-valuemin="20" aria-valuemax="70" tabindex="0" title="Drag to resize. Double-click to reset."></div><main id="detail"><div class="empty">Select a finding.</div></main>
    <div class="dock">
      <button id="prev" class="btn ghost" type="button" title="Previous finding (k)">Previous</button>
      <button id="next" class="btn ghost" type="button" title="Next finding (j)">Next</button>
      <button id="markDone" class="btn primary" type="button" title="Mark done (x)">Mark done</button>
    </div></section>
</div>
<script type="application/json" id="crv-findings">__SOURCE_JSON__</script>
<script>/*__MERMAID_LIB__*/</script>
<script>
const DATA=__DATA__, SEV=__SEV__, ORDER=__ORDER__, KEY='__STORAGE__', SUMMARY=__SUMMARY__;
const STAT=__STAT__, REV=__REVISION__, PR=__PR__, XMETA=__EXPORTMETA__, REVIEW=__REVIEW__, LENSES=__LENSES__;
const OV='__overview__', RV='__revision__';
// Drawn icons, one stroke weight. Status entries name their icon in STAT[k].i.
const IC={
  comment:'<path d="M4 5.5h16v10.5H9.5L4 20z"/>',
  check:'<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  chev:'<path d="M9 6l6 6-6 6"/>',
  link:'<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  ruler:'<path d="M3.5 16.5L16.5 3.5l4 4-13 13z"/><path d="M8 12l2 2M11 9l2 2M14 6l2 2"/>',
  fixed:'<circle cx="12" cy="12" r="8.5"/><path d="M8 12.5l3 3 5-6"/>',
  external:'<path d="M7 17L17 7M9 7h8v8"/>',
  dropped:'<circle cx="12" cy="12" r="8.5"/><path d="M6 18L18 6"/>',
  partial:'<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/>',
  rebutted:'<path d="M4 5.5h16v10.5H9.5L4 20z"/><path d="M9 11h6"/>',
  open:'<circle cx="12" cy="12" r="8.5"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  also:'<path d="M3.5 4.5h11v8H8.5l-5 4z"/><path d="M17.5 8.5h3v8.5l-3.5-3h-6v-2"/>',
  doc:'<path d="M6 3h8.5L19 7.5V21H6z"/><path d="M14 3v5h5M9.5 13h6M9.5 17h4"/>',
  rev:'<path d="M19.5 9.5A8 8 0 0 0 5 7.5"/><path d="M5 3.5v4h4"/><path d="M4.5 14.5A8 8 0 0 0 19 16.5"/><path d="M19 20.5v-4h-4"/>'
};
function ic(n,c){return '<svg class="ic'+(c?' '+c:'')+'" viewBox="0 0 24 24" aria-hidden="true">'+(IC[n]||'')+'</svg>';}
// Known severities and statuses take their token, so dark mode follows; custom ones keep their own colour.
function sc(k){return 'var(--s-'+k+','+(SEV[k]?SEV[k].c:'#6D7979')+')';}
function stc(k){return 'var(--st-'+k+','+STAT[k].c+')';}
function sevVars(k){return '--band:'+sc(k)+';--tint:var(--s-'+k+'-tint,var(--well));--idink:var(--s-'+k+'-ink,var(--ink))';}
// Titles keep their backticks in the export; on screen they render as inline code.
function tcode(s){return (s||'').replace(/`([^`]+)`/g,'<code>$1</code>');}
function outsideLi(o){return '<li>'+(o.loc?'<code>'+o.loc+'</code> ':'')+o.text+(o.ticket?' <b>'+o.ticket+'.</b>':'')+'</li>';}
function prLink(){return PR?'<a class="prlink" href="'+PR.url+'" target="_blank" rel="noopener">'+ic('link')+PR.label+'</a>':'';}
const dark=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;
try{mermaid.initialize({startOnLoad:false,securityLevel:'loose',theme:dark?'dark':'neutral',
  fontFamily:'"Open Sans",system-ui,sans-serif',flowchart:{useMaxWidth:true,htmlLabels:true},sequence:{useMaxWidth:true},state:{useMaxWidth:true}});}catch(e){}
let done=JSON.parse(localStorage.getItem(KEY)||'{}');
// Comments live under their own key, so a stale check-off map never carries note text and a
// revision's `-r<N>` storageKey namespaces both together.
const CKEY=KEY+':comments';
let notes=JSON.parse(localStorage.getItem(CKEY)||'{}');
// Ratings and missed items judge the review; they live beside comments and never tick a finding done.
const RKEY=KEY+':ratings',MKEY=KEY+':missed',RATER='crv-code-review:rater';
function readJSON(k,d){try{const v=JSON.parse(localStorage.getItem(k)||'null');return v==null?d:v;}catch(e){return d;}}
let ratings=readJSON(RKEY,{}),missed=readJSON(MKEY,[]);
let filter='all', tab='todo';
let current=REV?RV:(SUMMARY?OV:(DATA.length?DATA[0].id:null));
const $=s=>document.querySelector(s);
// A resolved issue counts as cleared work and stops counting toward progress.
function isRes(d){return !!(d.status&&STAT[d.status.state]&&STAT[d.status.state].r);}
function act(){return DATA.filter(d=>!isRes(d));}
function isOpen(d){return !isRes(d)&&!done[d.id];}
function passFilter(d){if(filter==='all')return true;if(filter==='resolved')return isRes(d);
  if(filter==='commented')return hasNote(d.id);return d.sev===filter&&!isRes(d);}
function rank(d){return (d.isNew?500:0)+ORDER.indexOf(d.sev);}
function sorted(list){return list.map((d,i)=>[d,i]).sort((a,b)=>rank(a[0])-rank(b[0])||a[1]-b[1]).map(p=>p[0]);}
// The racks this tab shows: To do lists open strips then the Cleared rack; Cleared and All show one rack.
function racks(){const p=sorted(DATA.filter(passFilter));
  if(tab==='todo')return [{items:p.filter(isOpen)},{label:'Cleared',items:p.filter(d=>!isOpen(d))}];
  if(tab==='done')return [{items:p.filter(d=>!isOpen(d))}];
  return [{items:p}];}
// Flat order matching the racks, so Previous/Next and j/k follow what the reader sees.
function visible(){const out=[];racks().forEach(r=>r.items.forEach(d=>out.push(d)));return out;}
// The next open finding after the current one, in severity order, regardless of tab and filter.
function nextOpen(){const all=sorted(DATA),o=all.filter(isOpen);if(!o.length)return null;
  const i=all.findIndex(d=>d.id===current);
  if(i>=0){for(let j=i+1;j<all.length;j++)if(isOpen(all[j]))return all[j];}
  return o.find(d=>d.id!==current)||o[0];}
function saveDone(){localStorage.setItem(KEY,JSON.stringify(done));}
function hasNote(id){return !!(notes[id]&&notes[id].trim());}
function noteIds(){return DATA.filter(d=>hasNote(d.id)).map(d=>d.id);}
// Empty text deletes the entry, so a cleared box never exports as a blank comment.
function saveNote(id,text){const t=(text||'').replace(/\s+$/,'');
  if(t.trim())notes[id]=t;else delete notes[id];
  localStorage.setItem(CKEY,JSON.stringify(notes));}
// Severity order, ignoring the current filter: an export always covers every comment.
function exportOrder(){const r=d=>(isRes(d)?1000:0)+rank(d);
  return DATA.map((d,i)=>[d,i]).filter(p=>hasNote(p[0].id))
    .sort((a,b)=>r(a[0])-r(b[0])||a[1]-b[1]).map(p=>p[0]);}
// Report prose is HTML-escaped for the DOM; the export is plain text, so decode it back.
function plain(s){const t=document.createElement('textarea');t.innerHTML=s||'';return t.value;}
function reportPath(){
  if(location.protocol==='file:'){try{return decodeURIComponent(location.pathname);}catch(e){}}
  return XMETA.path||location.href;}
function updateCopyBtn(){const n=noteIds().length,b=$('#copyCmt');
  b.disabled=!n;b.textContent=n?('Copy '+n+' comment'+(n===1?'':'s')):'Copy comments';}
function buildExport(){
  const list=exportOrder(),lines=[];
  lines.push('Act on the code-review comments below.','');
  lines.push('Report:       '+reportPath());
  if(PR)lines.push('Pull request: '+plain(PR.url));
  if(XMETA.head)lines.push('Head commit:  '+XMETA.head);
  lines.push('Comments:     '+list.length+' of '+DATA.length+' findings');
  lines.push('Exported:     '+new Date().toISOString());
  lines.push('',
    'Each comment names a finding by its id. Open the report file above and read that',
    "finding in full — the sidebar lists every finding by id, and each one carries its",
    'Impact, Fix, location and full reasoning. Address only the findings listed below,',
    'and treat each comment as the instruction for that finding.','');
  list.forEach(d=>{
    const bits=[d.id,SEV[d.sev]?SEV[d.sev].l.toLowerCase():d.sev];
    if(d.status&&STAT[d.status.state])bits.push(STAT[d.status.state].l.toLowerCase());
    bits.push(done[d.id]?'checked off':'not checked off');
    lines.push('-'.repeat(78),bits.join(' · '),plain(d.title));
    if(d.loc)lines.push(plain(d.loc));
    lines.push('','  '+notes[d.id].split('\n').join('\n  '),'');});
  lines.push('-'.repeat(78));
  return lines.join('\n');}
function showExport(text){
  const m=document.createElement('div');m.className='modal';
  m.innerHTML='<div class="box" role="dialog" aria-label="Copy comments"><h3>Copying failed. Select the text and copy it.</h3>'+
    '<textarea readonly></textarea><div><button class="btn ghost" data-x="1">Close</button></div></div>';
  m.querySelector('textarea').value=text;
  m.addEventListener('click',e=>{if(e.target===m||e.target.dataset.x)m.remove();});
  document.body.appendChild(m);const t=m.querySelector('textarea');t.focus();t.select();}
function copyComments(){
  if(!noteIds().length)return;
  const text=buildExport(),b=$('#copyCmt');
  const flash=()=>{b.textContent='Copied';setTimeout(updateCopyBtn,1600);};
  // file:// is a secure context in Chrome and Safari, so the async API usually works. Firefox and
  // a denied permission fall through to execCommand, and a modal is the last resort.
  const fallback=()=>{const ta=document.createElement('textarea');
    ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);
    ta.focus();ta.select();let ok=false;
    try{ok=document.execCommand('copy');}catch(e){ok=false;}
    ta.remove();if(ok)flash();else showExport(text);};
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(flash,fallback);
  }else fallback();}
function updateProgress(){const a=act(),t=a.length,n=a.filter(d=>done[d.id]).length,r=DATA.length-t;
  $('#pcount').textContent=(r?r+' resolved · ':'')+n+' of '+t+' done';
  $('#pbar').style.transform='scaleX('+(t?n/t:0)+')';
  if(REV){const c=$('#revchip');c.textContent='r'+REV.number;c.style.display='';}
  renderTabs();}
function renderTabs(){const todo=DATA.filter(isOpen).length,all=DATA.length;
  const t=[['todo','To do',todo],['done','Cleared',all-todo],['all','All',all]];
  $('#tabs').innerHTML=t.map(x=>'<button role="tab" data-t="'+x[0]+'" aria-selected="'+(tab===x[0])+'"'+
    (tab===x[0]?' class="on"':'')+'>'+x[1]+'<span class="cnt num">'+x[2]+'</span></button>').join('');}
function renderFilters(){let h='<button data-f="all" class="on">All severities</button>';
  ORDER.forEach(k=>{if(act().some(d=>d.sev===k))h+='<button data-f="'+k+'"><i style="background:'+sc(k)+'"></i>'+SEV[k].l+'</button>';});
  if(DATA.some(isRes))h+='<button data-f="resolved">'+ic('fixed')+'Resolved</button>';
  h+='<button data-f="commented" id="fcmt" disabled>'+ic('comment')+'Commented</button>';
  $('#filters').innerHTML=h;
  $('#filters').addEventListener('click',e=>{const b=e.target.closest('button[data-f]');if(!b)return;
    filter=b.dataset.f;if(filter==='resolved'&&tab==='todo'){tab='all';renderTabs();}
    $('#filters').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));renderList();});
  $('#tabs').addEventListener('click',e=>{const b=e.target.closest('button[data-t]');if(!b)return;
    tab=b.dataset.t;renderTabs();renderList();});
  $('#ftoggle').addEventListener('click',()=>{const o=$('#filters').classList.toggle('open');$('#ftoggle').setAttribute('aria-expanded',String(o));});}
// Earlier review threads this finding repeats: a marker on the strip, links on the pane.
function alsoWho(d){return [...new Set((d.earlier||[]).map(e=>e.who))].join(', ');}
function alsoChip(d){const w=alsoWho(d);
  return w?'<span class="salso"><span class="also" title="Also raised by '+w+' in an earlier review thread">'+ic('also')+
    '<span class="alsot">Also raised by '+w+'</span></span></span>':'';}
function alsoLinks(d){return '<span class="alsolist">'+d.earlier.map(e=>{const t=e.who+(e.loc?' · '+e.loc.split('/').pop():'');
  return e.url?'<a href="'+e.url+'" target="_blank" rel="noopener">'+ic('link')+t+'</a>':'<span>'+t+'</span>';}).join('')+'</span>';}
function itemHTML(d){const res=isRes(d),st=d.status?STAT[d.status.state]:null;
  const short=d.loc?d.loc.split('/').pop():'';
  let h='<div class="item strip'+(d.id===current?' active':'')+(done[d.id]?' done':'')+(res?' res':'')+'" data-id="'+d.id+'" style="'+sevVars(d.sev)+'">';
  h+='<span class="sid">'+d.id+'</span><span class="sbody"><span class="stitle">'+tcode(d.title)+'</span>'+
     '<span class="smeta">'+(d.strength?'<span class="lens">'+d.strength+(d.scope?' · '+d.scope:'')+'</span>':(d.cat?'<span class="lens">'+d.cat+'</span>':''))+(short?'<span class="loc num">'+short+'</span>':'')+'</span>'+alsoChip(d)+'</span>';
  h+='<span class="sflags">';
  if(d.isNew)h+='<span class="sflag" title="New since the last review">'+ic('plus')+'</span>';
  if(st)h+='<span class="sflag" style="color:'+stc(d.status.state)+'" title="'+st.l+'">'+ic(st.i)+'</span>';
  if(hasNote(d.id))h+='<span class="cflag" title="Has a comment">'+ic('comment')+'</span>';
  if(!res)h+='<input type="checkbox" class="chk" aria-label="Mark '+d.id+' done" '+(done[d.id]?'checked':'')+'>';
  return h+'</span></div>';}
function renderList(){
  let h='';
  if(REV)h+='<div class="item strip ov'+(current===RV?' active':'')+'" data-id="'+RV+'" style="--band:var(--green);--tint:var(--green-tint);--idink:var(--link)">'+
    '<span class="sid">'+ic('rev')+'</span><span class="sbody"><span class="stitle">Since the last review (r'+REV.number+')</span></span></div>';
  const rs=racks();let any=false;
  rs.forEach(r=>{if(!r.items.length&&!r.label)return;
    if(r.label){if(!r.items.length)return;h+='<div class="rackhead">'+r.label+'<span class="cnt num">'+r.items.length+'</span></div>';}
    r.items.forEach(d=>{any=true;h+=itemHTML(d);});});
  if(!any)h+='<div class="empty">'+(tab==='todo'?'Nothing left to do.':tab==='done'?'Nothing is cleared yet.':'Nothing matches.')+'</div>';
  const L=$('#list');L.innerHTML=h;
  L.querySelectorAll('.item').forEach(el=>{const id=el.dataset.id;
    const chk=el.querySelector('.chk');
    if(chk)chk.addEventListener('click',e=>{e.stopPropagation();toggle(id,e.target.checked);});
    el.addEventListener('click',()=>{select(id);document.body.classList.add('show-detail');updateBack();});});}
function statusBlock(d){const s=d.status;if(!s)return '';
  let b='';
  if(s.note)b+=s.note;
  if(s.evidence)b+='<p class="note2">Evidence: <code>'+s.evidence+'</code></p>';
  if(s.commits&&s.commits.length)b+='<p class="note2">Commits: <code>'+s.commits.join('</code> <code>')+'</code></p>';
  if(s.dev){const v=s.dev;
    b+='<blockquote class="dev">“'+v.quote+'”<footer>'+v.who+
       (v.when?' · '+v.when:'')+(v.where?' · <code>'+v.where+'</code>':'')+'</footer></blockquote>';
    if(v.verdict)b+=v.verdict;}
  return b?'<section class="block since"><h3>Since the last review</h3>'+b+'</section>':'';}
function countsTable(){const c={},nw=DATA.filter(d=>d.isNew).length;
  // New findings get their own row, so keep them out of the state tally — a new issue carries no
  // status and would otherwise be counted a second time as "Still open".
  DATA.forEach(d=>{if(d.isNew)return;const k=d.status?d.status.state:'open';c[k]=(c[k]||0)+1;});
  let rows='';
  Object.keys(STAT).forEach(k=>{if(!c[k])return;
    rows+='<tr><td><span style="color:'+stc(k)+'">'+ic(STAT[k].i)+'</span>'+STAT[k].l+'</td><td>'+c[k]+'</td></tr>';});
  if(nw)rows+='<tr><td>'+ic('plus')+'New since r'+(REV?REV.number-1:1)+'</td><td>'+nw+'</td></tr>';
  rows+='<tr><th>Total</th><th>'+DATA.length+'</th></tr>';
  return '<div class="tblwrap"><table class="vtbl"><thead><tr><th>Status</th><th>Count</th></tr></thead><tbody>'+rows+'</tbody></table></div>';}
function fact(label,value,cls){return '<div class="fact'+(cls?' '+cls:'')+'"><span class="fl">'+label+'</span><span class="fv'+(cls==='sevf'?' sev':'')+'">'+value+'</span></div>';}
function runMermaid(src){
  if(src){const s=$('#detail .diaslot:empty');if(s){const m=document.createElement('div');m.className='mermaid';m.textContent=src;s.appendChild(m);}}
  const go=()=>document.querySelectorAll('#detail .diaslot .mermaid').forEach(mm=>{
    try{mermaid.run({nodes:[mm]});}catch(e){mm.parentElement.innerHTML='<div class="note">The diagram failed to render.</div>';}});
  if(document.fonts&&document.fonts.status==='loading')document.fonts.ready.then(go,go);else go();}
function renderDetail(){
  const mark=$('#markDone'),M=document.querySelector('main');
  if(current===RV&&REV){
    let h='<article class="finding"><h2 class="dtitle">What changed since r'+(REV.number-1)+'</h2><div class="facts">';
    if(PR)h+=fact('Pull request',prLink());
    if(REV.reviewedAt)h+=fact('Previous review',REV.reviewedAt);
    h+='</div>';
    if(REV.html)h+='<section class="block"><h3>Summary</h3>'+REV.html+'</section>';
    let rng='';
    if(REV.reviewedCommit||REV.headCommit)rng+='<p class="note2">Range: <code>'+
      (REV.reviewedCommit||'?')+'</code> → <code>'+(REV.headCommit||'HEAD')+'</code></p>';
    if(REV.prev)rng+='<p class="note2">Previous report: <code>'+REV.prev+'</code></p>';
    if(rng)h+='<section class="block"><h3>Reviewed range</h3>'+rng+'</section>';
    if(REV.commits&&REV.commits.length)h+='<section class="block"><h3>Commits since r'+(REV.number-1)+
      '</h3><ul>'+REV.commits.map(c=>'<li><code>'+c+'</code></li>').join('')+'</ul></section>';
    h+='<section class="block"><h3>Where the findings stand</h3>'+countsTable()+'</section></article>';
    $('#detail').innerHTML=h;mark.style.display='none';M.scrollTop=0;runMermaid();return;}
  if(current===OV&&SUMMARY){
    let h='<article class="finding"><h2 class="dtitle">What this change does</h2><div class="facts">';
    if(PR)h+=fact('Pull request',prLink());
    if(SUMMARY.headCommit)h+=fact('Head commit','<code>'+SUMMARY.headCommit+'</code>');
    h+='</div>';
    const outHigh=(SUMMARY.outside||[]).filter(o=>o.high);
    if(outHigh.length)h+='<section class="block outhigh"><h3>Found outside this change</h3>'+
      '<p>The diff does not cause this, so it does not count as a blocker.</p><ul>'+
      outHigh.map(outsideLi).join('')+'</ul></section>';
    const n=nextOpen();
    if(n)h+='<div class="nextcard"><div class="rackhead" style="margin:0 0 8px">Start here</div>'+itemHTML(n).replace(' active','')+'</div>';
    if(SUMMARY.html)h+='<section class="block">'+SUMMARY.html+'</section>';
    if(SUMMARY.mermaid)h+='<div class="diaslot"></div>';
    const outLow=(SUMMARY.outside||[]).filter(o=>!o.high);
    if(outLow.length)h+='<section class="block"><h3>Outside this change</h3><ul>'+outLow.map(outsideLi).join('')+'</ul></section>';
    if(SUMMARY.points&&SUMMARY.points.length)h+='<section class="block"><h3>Key points</h3><ul>'+
      SUMMARY.points.map(p=>'<li>'+p+'</li>').join('')+'</ul></section>';
    if(SUMMARY.engines&&SUMMARY.engines.length)h+='<section class="block"><h3>Reviewed by</h3><ul>'+
      SUMMARY.engines.map(e=>'<li><b>'+e.name+'</b>'+(e.lenses?': '+e.lenses:'')+'</li>').join('')+'</ul></section>';
    h+=missedHTML()+'</article>';
    $('#detail').innerHTML=h;mark.style.display='none';M.scrollTop=0;wireMissed();runMermaid(SUMMARY.mermaid);
    const go=$('#detail .nextcard .item');if(go){const chk=go.querySelector('.chk');if(chk)chk.remove();
      go.addEventListener('click',()=>{select(go.dataset.id);document.body.classList.add('show-detail');});}
    return;}
  const d=DATA.find(x=>x.id===current);
  if(!d){$('#detail').innerHTML='<div class="empty">Select a finding.</div>';mark.style.display='none';return;}
  const res=isRes(d);mark.style.display=res?'none':'';
  const st=d.status?STAT[d.status.state]:null,m=SEV[d.sev];
  let h='<article class="finding"><h2 class="dtitle">'+tcode(d.title)+'</h2><div class="facts">'+
    fact('Severity','<span style="color:var(--s-'+d.sev+'-text,var(--s-'+d.sev+'-ink,'+m.c+'))">'+m.l+'</span>','sevf');
  if(d.verify)h+=fact('Verifier',d.verify==='PLAUSIBLE'?'Unverified':'Confirmed');
  if(d.cat)h+=fact('Lens',d.cat);
  if(d.strength)h+=fact('Strength',d.strength);
  if(d.scope)h+=fact('Scope',d.scope);
  if(d.deps)h+=fact('Tested',d.deps);
  if(st)h+=fact('Status','<span class="tag" style="color:'+stc(d.status.state)+'">'+ic(st.i)+st.l+'</span>');
  if(d.isNew)h+=fact('Since r'+(REV?REV.number-1:1),'New');
  if(d.tag)h+=fact('Tag',d.tag);
  if(d.guide)h+=fact('Standard','<span class="tag">'+ic('ruler')+d.guide+'</span>');
  if(d.src&&d.src.length)h+=fact('Raised by',d.src.join(', '));
  if(d.earlier&&d.earlier.length)h+=fact('Also raised by',alsoLinks(d));
  if(d.loc)h+=fact('Location',d.loc,'loc');
  h+='</div>';
  h+=statusBlock(d);
  const isStruct=d.sev==='struct';
  if(d.impact)h+='<section class="block"><h3>'+(isStruct?'Friction':'Impact')+'</h3>'+d.impact+'</section>';
  if(d.fix)h+='<section class="block"><h3>'+(isStruct?'Proposal':'Fix')+'</h3>'+d.fix+'</section>';
  if(d.html)h+=d.html;
  if(d.reasoning)h+='<details class="reasoning"><summary>'+ic('chev')+'Full reasoning</summary>'+d.reasoning+'</details>';
  h+='<div class="cmt"><label for="cmtbox">Your comment</label><textarea id="cmtbox" rows="1" '+
     'placeholder="What should happen with '+d.id+'? Copy comments turns every comment into one instruction for your coding agent."></textarea>'+
     '<div class="row"><span class="hint" id="cmthint"></span>'+
     '<button class="clr" id="cmtclr">Clear</button></div></div>'+ratingHTML(d)+'</article>';
  $('#detail').innerHTML=h;
  wireComment(d);wireRating(d);runMermaid(d.mermaid);
  mark.textContent=done[d.id]?'Done':'Mark done';mark.classList.toggle('is-done',!!done[d.id]);
  M.scrollTop=0;}
// Typing must not re-render the detail pane, or the textarea loses focus mid-word. Only the
// rack flag, the filter button and the header count follow each keystroke.
function wireComment(d){const ta=$('#cmtbox'),hint=$('#cmthint'),clr=$('#cmtclr');
  if(!ta)return;
  const grow=()=>{ta.style.height='auto';ta.style.height=Math.max(36,ta.scrollHeight+2)+'px';};
  const paint=()=>{const has=hasNote(d.id);
    clr.style.display=has?'':'none';
    hint.textContent=has?'Saved in this browser':'';
    $('#fcmt').disabled=!noteIds().length;
    updateCopyBtn();renderList();};
  ta.value=notes[d.id]||'';
  ta.addEventListener('input',()=>{saveNote(d.id,ta.value);paint();grow();});
  clr.addEventListener('click',()=>{ta.value='';saveNote(d.id,'');paint();grow();ta.focus();});
  paint();grow();}
function attr(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');}
// Useful, or Not useful with a reason; a duplicate also needs the finding it repeats.
function isComplete(r){return !!(r&&(r.rating==='useful'||(r.rating==='not-useful'&&r.reason&&(r.reason!=='duplicate'||r.duplicateOf))));}
function hasFeedback(){return DATA.some(d=>isComplete(ratings[d.id]))||missed.length>0;}
function updateFeedbackBtn(){const b=$('#dlFb');if(b)b.disabled=!hasFeedback();}
const REASONS=[['wrong','Wrong'],['not-worth-it','Not worth it'],['duplicate','Duplicate'],['intended','Intended']];
function setRating(id,patch){const r=Object.assign({},ratings[id]||{},patch);
  if(r.rating!=='not-useful'){delete r.reason;delete r.duplicateOf;}
  if(r.reason!=='duplicate')delete r.duplicateOf;
  if(!r.rating)delete ratings[id];else ratings[id]=r;
  localStorage.setItem(RKEY,JSON.stringify(ratings));updateFeedbackBtn();}
function ratingHTML(d){const r=ratings[d.id]||{};
  let h='<div class="rate" id="rate"><span class="rl">Was this finding useful?</span><div class="rbtns">'+
    '<button type="button" class="chip'+(r.rating==='useful'?' on':'')+'" data-rate="useful">Useful</button>'+
    '<button type="button" class="chip'+(r.rating==='not-useful'?' on':'')+'" data-rate="not-useful">Not useful</button></div>';
  if(r.rating==='not-useful'){
    h+='<div class="rbtns" role="group" aria-label="Reason">'+REASONS.map(([k,l])=>
      '<button type="button" class="chip'+(r.reason===k?' on':'')+'" data-reason="'+k+'">'+l+'</button>').join('')+'</div>';
    if(r.reason==='duplicate')h+='<label class="rsub">Duplicate of <select id="rdup"><option value="">Choose a finding</option>'+
      DATA.filter(x=>x.id!==d.id).map(x=>'<option value="'+x.id+'"'+(r.duplicateOf===x.id?' selected':'')+'>'+x.id+'</option>').join('')+
      '</select></label>';
    if(!isComplete(r))h+='<span class="rhint">'+(r.reason==='duplicate'?'Choose the finding this duplicates':'Pick a reason')+
      ' to include this rating in the feedback file.</span>';}
  if(r.rating)h+='<input id="rnote" class="rnote" type="text" maxlength="200" placeholder="Note (optional)" value="'+attr(r.note||'')+'">';
  return h+'</div>';}
// Re-render only the rating box, so the comment textarea keeps its state.
function wireRating(d){const box=$('#rate');if(!box)return;
  box.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;
    if(b.dataset.rate){const cur=(ratings[d.id]||{}).rating;setRating(d.id,{rating:cur===b.dataset.rate?null:b.dataset.rate});}
    else if(b.dataset.reason)setRating(d.id,{reason:b.dataset.reason});
    else return;
    box.outerHTML=ratingHTML(d);wireRating(d);});
  const dup=$('#rdup');if(dup)dup.addEventListener('change',()=>{setRating(d.id,{duplicateOf:dup.value||null});
    $('#rate').outerHTML=ratingHTML(d);wireRating(d);});
  const note=$('#rnote');if(note)note.addEventListener('input',()=>setRating(d.id,{note:note.value}));}
function rater(){try{return localStorage.getItem(RATER)||'';}catch(e){return '';}}
function saveMissed(){localStorage.setItem(MKEY,JSON.stringify(missed));updateFeedbackBtn();}
function missedHTML(){
  let h='<section class="block mform" id="missed"><h3>Missed something?</h3>'+
    '<label class="mrow">Your GitHub username<input id="mrater" type="text" autocomplete="off" value="'+attr(rater())+'"></label>'+
    '<label class="mrow">What did the review miss?<textarea id="mtext" rows="2"></textarea></label>'+
    '<div class="mrow2"><label>File and line<input id="mloc" type="text" placeholder="path:line"></label>'+
    '<label>Lens<select id="mlens"><option value="">Not sure</option>'+LENSES.map(l=>'<option value="'+l+'">'+l+'</option>').join('')+'</select></label>'+
    '<button type="button" class="btn ghost" id="madd">Add</button></div>';
  if(missed.length)h+='<ul class="mlist">'+missed.map((m,i)=>{
    const meta=(m.loc?'<code>'+attr(m.loc)+'</code>':'')+(m.lens?'<span class="lens">'+attr(m.lens)+'</span>':'');
    return '<li><span class="mid">X'+(i+1)+'</span><div class="mbody"><div class="mtext">'+attr(m.text)+'</div>'+
      (meta?'<div class="mmeta">'+meta+'</div>':'')+'</div><button type="button" class="clr" data-mdel="'+i+'">Remove</button></li>';
  }).join('')+'</ul>';
  return h+'</section>';}
function wireMissed(){const box=$('#missed');if(!box)return;
  $('#mrater').addEventListener('input',e=>{try{localStorage.setItem(RATER,e.target.value.trim());}catch(err){}});
  $('#madd').addEventListener('click',()=>{const text=$('#mtext').value.trim();if(!text){$('#mtext').focus();return;}
    missed.push({text,loc:$('#mloc').value.trim()||null,lens:$('#mlens').value||null});saveMissed();renderDetail();});
  box.addEventListener('click',e=>{const b=e.target.closest('[data-mdel]');if(!b)return;
    missed.splice(+b.dataset.mdel,1);saveMissed();renderDetail();});}
// The feedback file: spec section 2 schema. Only complete ratings go in; missed items get X1, X2...
// A duplicate also carries the duplicated finding's loc, title and lens, which may be unrated.
function buildFeedback(){
  const rs=DATA.filter(d=>isComplete(ratings[d.id])).map(d=>{const r=ratings[d.id];
    const t=r.reason==='duplicate'?DATA.find(x=>x.id===r.duplicateOf):null;
    return {id:d.id,lens:plain(d.cat||'')||null,sev:d.sev,loc:plain(d.loc)||null,title:plain(d.title),
      rating:r.rating,reason:r.rating==='not-useful'?r.reason:null,
      duplicateOf:r.reason==='duplicate'?r.duplicateOf:null,
      duplicateOfLoc:t?plain(t.loc)||null:null,duplicateOfTitle:t?plain(t.title)||null:null,
      duplicateOfLens:t?plain(t.cat||'')||null:null,
      note:(r.note||'').trim()||null,appliedIn:null};});
  const ms=missed.map((m,i)=>({id:'X'+(i+1),text:m.text,loc:m.loc||null,lens:m.lens||null,appliedIn:null}));
  const R=REVIEW||{};
  return {version:1,review:{repo:R.repo||null,pr:R.pr||null,base:R.base||null,head:R.head||null,
    agent:R.agent||null,model:R.model||null,lenses:R.lenses||[],lensHash:R.lensHash||null},
    rater:rater()||null,ratings:rs,missed:ms};}
function feedbackName(){return 'pr-'+REVIEW.pr+'-'+String(REVIEW.head||'').slice(0,7)+'.json';}
function downloadFeedback(){if(!hasFeedback())return;
  const blob=new Blob([JSON.stringify(buildFeedback(),null,2)+'\n'],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=feedbackName();
  document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
function toggle(id,val){const d=DATA.find(x=>x.id===id);if(d&&isRes(d))return;
  if(val)done[id]=1;else delete done[id];saveDone();updateProgress();renderList();if(id===current||current===OV)renderDetail();}
// Marking the open finding done moves on to the next open one, the way a strip clears from the bay.
function markCurrent(){if(current===OV||current===RV)return;const was=!!done[current];
  const n=was?null:nextOpen();toggle(current,!was);if(!was&&tab==='todo'&&n)select(n.id);}
// Overview button everywhere except a phone's finding view, where a chevron returns to the rack.
function narrow(){return !!(window.matchMedia&&window.matchMedia('(max-width:760px)').matches);}
function updateBack(){const b=$('#back'),o=$('#ovbtn'),hasOv=!!(SUMMARY||REV),onOv=current===OV||current===RV,
    det=document.body.classList.contains('show-detail'),phoneDetail=narrow()&&det;
  b.style.display=phoneDetail?'':'none';o.style.display=hasOv&&!phoneDetail?'':'none';
  o.setAttribute('aria-pressed',String(onOv&&!narrow()));o.setAttribute('aria-label',REV&&!SUMMARY?'Since the last review':'Overview');}
function select(id){current=id;renderList();renderDetail();updateBack();
  const el=document.querySelector('.rack .item[data-id="'+id+'"]');if(el)el.scrollIntoView({block:'nearest'});}
function step(dir){const v=visible();let i=v.findIndex(d=>d.id===current);
  if(i<0){if(v.length)select(v[0].id);return;}i+=dir;if(i<0)i=0;if(i>=v.length)i=v.length-1;select(v[i].id);}
$('#prev').onclick=()=>step(-1);$('#next').onclick=()=>step(1);
$('#markDone').onclick=markCurrent;
// The chevron opens the overview; in the phone's finding view it returns to the rack first.
// Overview opens the change summary; on phones the chevron returns from a finding to the rack.
$('#ovbtn').onclick=()=>{select(SUMMARY?OV:RV);if(narrow())document.body.classList.add('show-detail');updateBack();};
$('#back').onclick=()=>{document.body.classList.remove('show-detail');updateBack();};
// Rack width: stored per viewer as a fraction of the window; the finding pane keeps at least 420px.
(function(){const app=$('.app'),rz=$('#resizer'),RK='crv-code-review:rack-width',MIN=280,PANE=420;let f=null;
  function apply(x){if(x==null){app.style.removeProperty('--rack-w');return null;}
    const w=app.getBoundingClientRect().width;if(!w)return x;const px=Math.max(MIN,Math.min(w-PANE,x*w));
    app.style.setProperty('--rack-w',(px/w*100).toFixed(2)+'%');rz.setAttribute('aria-valuenow',String(Math.round(px/w*100)));return px/w;}
  const save=()=>{try{if(f==null)localStorage.removeItem(RK);else localStorage.setItem(RK,f.toFixed(4));}catch(e){}};
  try{const s=parseFloat(localStorage.getItem(RK));if(s>0&&s<1)f=apply(s);}catch(e){}
  rz.addEventListener('pointerdown',e=>{e.preventDefault();rz.focus();if(rz.setPointerCapture)rz.setPointerCapture(e.pointerId);document.body.classList.add('resizing');
    const r=app.getBoundingClientRect();const move=ev=>{f=apply((ev.clientX-r.left)/r.width);};
    const up=()=>{rz.removeEventListener('pointermove',move);rz.removeEventListener('pointerup',up);document.body.classList.remove('resizing');save();};
    rz.addEventListener('pointermove',move);rz.addEventListener('pointerup',up);});
  rz.addEventListener('keydown',e=>{if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight')return;e.preventDefault();e.stopPropagation();
    const w=app.getBoundingClientRect().width;const cur=f==null?$('.rackcol').getBoundingClientRect().width/w:f;
    f=apply(cur+(e.key==='ArrowLeft'?-0.02:0.02));save();});
  rz.addEventListener('dblclick',()=>{f=apply(null);save();});
  window.addEventListener('resize',()=>{if(f!=null)f=apply(f);updateBack();});})();
$('#copyCmt').onclick=copyComments;
$('#dlFb').onclick=downloadFeedback;
if(!REVIEW||!REVIEW.pr)$('#dlFb').style.display='none';
// Colour the change counts in the size line: +additions green, -deletions red.
(function(){const s=$('#subline');s.innerHTML=s.innerHTML.replace(/(^|\s)(\+\d[\d,]*)/g,'$1<span class="p">$2</span>').replace(/(^|\s)([−-]\d[\d,]*)/g,'$1<span class="m">$2</span>');})();
// TEXTAREA joins the guard: j/k/x are navigation shortcuts everywhere except inside a comment.
document.addEventListener('keydown',e=>{
  const t=e.target.tagName;if(t==='INPUT'||t==='TEXTAREA'||t==='SELECT')return;
  if(e.key==='j'||e.key==='ArrowDown'){e.preventDefault();step(1);}
  if(e.key==='k'||e.key==='ArrowUp'){e.preventDefault();step(-1);}
  if(e.key==='x'&&current!==OV&&current!==RV){e.preventDefault();markCurrent();}});
renderTabs();renderFilters();updateProgress();renderList();renderDetail();updateBack();
// The title can cut off in the top bar; the full text shows on hover.
$('.who h1').title=$('.who h1').textContent;
$('#fcmt').disabled=!noteIds().length;updateCopyBtn();updateFeedbackBtn();
</script></body></html>'''

def default_base():
    """<cwd>/.crv-skills/crv-code-review"""
    return os.path.join(os.getcwd(), ".crv-skills", "crv-code-review")

def ensure_ignore_file(root):
    """Creates root/.gitignore holding `*` when missing; an existing file stays as it is.
    root: the .crv-skills folder."""
    path = os.path.join(root, ".gitignore")
    if not os.path.exists(path):
        os.makedirs(root, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write("*\n")

def resolve_out(arg):
    # Bare file name -> <cwd>/.crv-skills/crv-code-review/<name>; a path with a directory -> as given.
    # No argument -> <cwd>/.crv-skills/crv-code-review/report.html.
    base = default_base()
    if not arg:
        return os.path.join(base, "report.html")
    if os.path.dirname(arg):
        return os.path.expanduser(arg)
    return os.path.join(base, arg)

def derive_revision_out(prev_path):
    """`pr1090-review.html` -> `pr1090-review-r2.html`, next to the previous report.

    The number comes from the PREVIOUS report's own suffix plus one (no suffix counts as r1), so the
    mapping is deterministic: revising the same previous report always writes the same output. That
    makes rebuilds idempotent while you iterate, instead of leaving an -r3, -r4, -r5 trail. Returns
    (out_path, revision_number). The previous report is never the target.
    """
    prev = os.path.abspath(os.path.expanduser(prev_path))
    if not os.path.exists(prev):
        raise SystemExit("--revise: previous report not found: %s" % prev)
    stem, ext = os.path.splitext(os.path.basename(prev))
    m = re.search(r"-r(\d+)$", stem)
    prev_n = int(m.group(1)) if m else 1
    root = stem[: m.start()] if m else stem
    n = prev_n + 1
    out = os.path.join(os.path.dirname(prev), "%s-r%d%s" % (root, n, ext))
    if os.path.abspath(out) == prev:
        raise SystemExit("--revise: refusing to overwrite the previous report %s" % prev)
    return out, n

def open_in_browser(path):
    try:
        if sys.platform == "darwin":
            subprocess.run(["open", path], check=False)
        elif sys.platform.startswith("linux"):
            subprocess.run(["xdg-open", path], check=False)
        elif sys.platform.startswith("win"):
            os.startfile(path)  # type: ignore[attr-defined]
        else:
            return False
        return True
    except Exception as e:
        print("could not open %s: %s" % (path, e), file=sys.stderr)
        return False

USAGE = ("usage: build_report.py findings.json [out.html] [mermaid.min.js] [--no-open | --open]\n"
         "       build_report.py findings.json --revise previous-report.html [--no-open | --open]")

if __name__ == "__main__":
    argv = sys.argv[1:]
    no_open = "--no-open" in argv
    force_open = "--open" in argv
    revise_prev = None
    if "--revise" in argv:
        i = argv.index("--revise")
        if i + 1 >= len(argv):
            print(USAGE, file=sys.stderr); sys.exit(1)
        revise_prev = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]
    args = [a for a in argv if a not in ("--no-open", "--open")]
    if not args:
        print(USAGE, file=sys.stderr); sys.exit(1)

    findings = json.load(open(args[0], encoding="utf-8"))
    rev_n = None
    if revise_prev:
        out_path, rev_n = derive_revision_out(revise_prev)
        libpath_arg = args[1] if len(args) > 1 else None
    else:
        out_path = resolve_out(args[1] if len(args) > 1 else None)
        libpath_arg = args[2] if len(args) > 2 else None
    base = default_base()
    if os.path.abspath(out_path).startswith(base + os.sep):
        ensure_ignore_file(os.path.dirname(base))
    libpath = libpath_arg or os.path.join(os.path.dirname(__file__), "..", "assets", "mermaid.min.js")
    mermaid_js = open(libpath, encoding="utf-8").read() if os.path.exists(libpath) else ""

    meta = findings.get("meta", {})
    if not (meta.get("prUrl") or "").strip():
        print("WARNING: meta.prUrl is not set, so the summary pane has no link to the PR. Set it to\n"
              "         the pull-request URL (omit it only for a review with no PR, e.g. a local diff).",
              file=sys.stderr)
    if rev_n is not None:
        rev = meta.setdefault("revision", {})
        stale = (rev.get("number") not in (None, rev_n)) and (rev.get("commits") or rev.get("summary"))
        # Assign, don't setdefault: a findings.json extracted from an earlier revision still carries
        # that revision's number and previousReport. The derived pair is the ground truth for which
        # revision this build is, so it wins.
        rev["number"], rev["previousReport"] = rev_n, os.path.basename(os.path.expanduser(revise_prev))
        if stale:
            print("NOTE: meta.revision.summary/commits still describe an earlier revision.\n"
                  "      Rewrite them for r%d, or the pane will describe the wrong range." % rev_n,
                  file=sys.stderr)
        key = meta.get("storageKey", "")
        if not re.search(r"-r%d$" % rev["number"], key):
            print("WARNING: meta.storageKey %r has no -r%d suffix, so this revision shares its\n"
                  "         check-offs with an earlier one. Bump it to keep the checklists separate."
                  % (key, rev["number"]), file=sys.stderr)

    n_shape = shape_warnings(findings)
    out = build(findings, mermaid_js, out_path)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    open(out_path, "w", encoding="utf-8").write(out)
    n_res = sum(1 for x in findings["issues"]
                if STATUSES.get((x.get("status") or {}).get("state", ""), {}).get("r"))
    print("wrote %s (%d bytes, %d issues%s%s, mermaid:%s)" % (
        out_path, len(out), len(findings["issues"]),
        ", revision r%d" % rev_n if rev_n else "",
        ", %d resolved" % n_res if n_res else "",
        "inlined" if mermaid_js else "MISSING"))
    # A build with SHAPE warnings gets rebuilt, so it opens nothing: one tab per review.
    if n_shape and not force_open and not no_open:
        print("not opened: fix the SHAPE warnings and build again, or pass --open")
    elif not no_open and open_in_browser(out_path):
        print("opened %s" % out_path)
