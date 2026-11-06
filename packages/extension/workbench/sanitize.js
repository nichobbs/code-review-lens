'use strict';

/**
 * Allow-list HTML sanitiser shared by the Workbench UI (browser) and the CLI (node).
 *
 * Findings, PR comments and agent output are untrusted. The compiler emits a tiny HTML subset
 * (p, strong, code, ul/li, h3/h5, div.diaslot/div.mermaid), so everything else is neutralised:
 *  - disallowed tags are rendered as inert text (`&lt;script&gt;`),
 *  - comments are dropped,
 *  - only `class` (restricted charset) and `href` (http/https only) attributes survive,
 *  - no inline event handlers, `style`, `src`, `srcdoc`, `javascript:` URLs.
 *
 * UMD so one implementation serves `<script src>`, standalone inline HTML and `require()`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CrvSanitize = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const ALLOWED_TAGS = new Set([
    'p', 'strong', 'b', 'em', 'i', 'code', 'pre', 'ul', 'ol', 'li', 'br', 'hr',
    'h3', 'h4', 'h5', 'blockquote', 'a', 'div', 'span', 'details', 'summary'
  ]);
  const VOID_TAGS = new Set(['br', 'hr']);
  const TAG_RE = /<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>/g;
  const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  const MAX_CLASS_LEN = 80;

  function escapeText(s) {
    return String(s).replace(/&(?!(?:[a-zA-Z]{2,8}|#\d{1,6}|#x[0-9a-fA-F]{1,5});)/g, '&amp;').replace(/</g, '&lt;');
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function decodeBasicEntities(s) {
    return String(s)
      .replace(/&#x([0-9a-fA-F]+);?/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);?/g, (_, d) => String.fromCharCode(Number(d)))
      .replace(/&colon;/gi, ':')
      .replace(/&tab;|&newline;/gi, '');
  }

  function safeHref(raw) {
    const decoded = decodeBasicEntities(raw).replace(/[\u0000- \u007f-\u009f]/g, '');
    return /^https?:\/\//i.test(decoded) ? decodeBasicEntities(raw).trim() : null;
  }

  function sanitizeTag(token) {
    if (token.startsWith('<!--')) return '';
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)([\s\S]*?)(\/?)>$/.exec(token);
    if (!m) return escapeText(token);
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return escapeText(token);
    if (closing) return VOID_TAGS.has(tag) ? '' : `</${tag}>`;

    let attrs = '';
    let sawHref = false;
    let match;
    ATTR_RE.lastIndex = 0;
    while ((match = ATTR_RE.exec(m[3])) !== null) {
      const name = match[1].toLowerCase();
      const value = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4] || '';
      if (name === 'class' && value.length <= MAX_CLASS_LEN && /^[\w\s-]*$/.test(value)) {
        attrs += ` class="${escapeAttr(value)}"`;
      } else if (name === 'href' && tag === 'a' && !sawHref) {
        const href = safeHref(value);
        if (href) {
          attrs += ` href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer"`;
          sawHref = true;
        }
      }
    }
    return `<${tag}${attrs}${VOID_TAGS.has(tag) ? ' /' : ''}>`;
  }

  function sanitizeHtml(html) {
    if (html === null || html === undefined || html === '') return '';
    const src = String(html);
    let out = '';
    let last = 0;
    let m;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(src)) !== null) {
      out += escapeText(src.slice(last, m.index));
      out += sanitizeTag(m[0]);
      last = m.index + m[0].length;
    }
    out += escapeText(src.slice(last));
    return out;
  }

  /** Report keys whose string values are rendered as HTML by the Workbench. */
  const HTML_KEYS = new Set(['impact', 'fix', 'reasoning', 'html', 'verdict', 'overview', 'htmlExtra']);

  /**
   * Returns a deep copy of a report with every HTML-bearing field sanitised.
   * Non-HTML fields are untouched (the UI escapes them at render time).
   */
  function sanitizeReport(value, key) {
    if (typeof value === 'string') {
      return key && HTML_KEYS.has(key) ? sanitizeHtml(value) : value;
    }
    if (Array.isArray(value)) return value.map((v) => sanitizeReport(v, key));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = sanitizeReport(v, k);
      return out;
    }
    return value;
  }

  return { sanitizeHtml, sanitizeReport, escapeText, HTML_KEYS };
});
