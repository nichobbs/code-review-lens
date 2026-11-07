'use strict';

/**
 * Turns the stdout of a read-only headless agent run into a validated `findings.json`.
 *
 * Why this exists: when the agent runs in a read-only mode it cannot write `findings.json` itself, so it returns the JSON
 * in its final response and crv writes the file. The agent's output is untrusted (it read untrusted PR content), so it is
 * parsed defensively, validated field by field, size-capped and only then written to a fixed path in the scratch directory.
 *
 * The exact envelope of `agy --output-format json` is NOT documented in `agy --help`. The parser therefore accepts every
 * plausible shape: a bare findings object, a wrapper whose `result`/`text`/`output`/... holds the findings (as an object or
 * as a string, optionally fenced or surrounded by prose), arrays of content blocks, and NDJSON event streams.
 */

const fs = require('fs');
const path = require('path');

const FINDINGS_SCHEMA_PATH = path.join(__dirname, 'findings.schema.json');

const SEVERITIES = new Set(['high', 'medium', 'low', 'nit', 'struct']);
const VERIFY_VALUES = new Set(['CONFIRMED', 'PLAUSIBLE']);
const MAX_ISSUES = 200;
const MAX_FIELD_CHARS = 20000;
const MAX_OUTPUT_CHARS = 8 * 1024 * 1024;
const MAX_DEPTH = 6;
const WRAPPER_KEYS = [
  'structured_output',
  'structuredOutput',
  'result',
  'output',
  'response',
  'text',
  'content',
  'message',
  'final',
  'data',
  'candidates',
  'parts'
];

function looksLikeFindings(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.issues);
}

/** Finds the first balanced `{ ... }` object in `text` that parses as findings (handles prose around the JSON). */
function extractJsonObjectFromText(text) {
  const src = String(text);
  for (let start = src.indexOf('{'); start !== -1; start = src.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < src.length; i++) {
      const ch = src[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(src.slice(start, i + 1));
            if (looksLikeFindings(parsed)) return parsed;
          } catch (e) {}
          break;
        }
      }
    }
  }
  return null;
}

function fromString(text, depth) {
  const trimmed = String(text).trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    const found = search(parsed, depth + 1);
    if (found) return found;
  } catch (e) {}
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced) {
    try {
      const found = search(JSON.parse(fenced[1].trim()), depth + 1);
      if (found) return found;
    } catch (e) {}
  }
  return extractJsonObjectFromText(trimmed);
}

function search(value, depth = 0) {
  if (depth > MAX_DEPTH || value === null || value === undefined) return null;
  if (typeof value === 'string') return fromString(value, depth);
  if (looksLikeFindings(value)) return value;
  if (Array.isArray(value)) {
    // Content blocks / event streams: the last block that yields findings wins (the final answer).
    for (let i = value.length - 1; i >= 0; i--) {
      const found = search(value[i], depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const key of WRAPPER_KEYS) {
      if (key in value) {
        const found = search(value[key], depth + 1);
        if (found) return found;
      }
    }
  }
  return null;
}

/** Returns the findings object found in the agent's stdout, or null. Never throws. */
function parseAgentFindings(stdout) {
  const text = String(stdout || '');
  if (!text.trim() || text.length > MAX_OUTPUT_CHARS) return null;
  const whole = search(text);
  if (whole) return whole;
  // NDJSON (`--output-format stream-json`): one JSON event per line; the last line that yields findings wins.
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length > 1) {
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const found = search(JSON.parse(lines[i]));
        if (found) return found;
      } catch (e) {}
    }
  }
  return null;
}

const clip = (v) => (typeof v === 'string' ? v.slice(0, MAX_FIELD_CHARS) : v);

/**
 * Validates and normalises a parsed findings object. Invalid issues are dropped (and reported), never repaired silently.
 * Returns `{ ok, findings, problems }`; `ok` is false when nothing usable remains.
 */
function validateAgentFindings(raw) {
  const problems = [];
  if (!looksLikeFindings(raw)) return { ok: false, findings: null, problems: ['output has no "issues" array'] };

  const issues = [];
  raw.issues.slice(0, MAX_ISSUES).forEach((x, i) => {
    const label = `issues[${i}]`;
    if (!x || typeof x !== 'object' || Array.isArray(x)) return problems.push(`${label}: not an object`);
    if (typeof x.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,15}$/.test(x.id)) return problems.push(`${label}: invalid id`);
    if (!SEVERITIES.has(x.sev)) return problems.push(`${x.id}: invalid sev "${x.sev}"`);
    if (typeof x.title !== 'string' || !x.title.trim()) return problems.push(`${x.id}: missing title`);
    if (typeof x.loc !== 'string') return problems.push(`${x.id}: missing loc`);
    if (x.verify !== undefined && !VERIFY_VALUES.has(x.verify)) return problems.push(`${x.id}: invalid verify "${x.verify}"`);
    const issue = {};
    for (const [k, v] of Object.entries(x)) issue[k] = clip(v);
    issues.push(issue);
  });
  if (raw.issues.length > MAX_ISSUES) problems.push(`only the first ${MAX_ISSUES} of ${raw.issues.length} issues were kept`);

  const meta = raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta) ? { ...raw.meta } : {};
  for (const k of Object.keys(meta)) meta[k] = clip(meta[k]);
  // An empty `issues` array is a legitimate "nothing found" review; invalid entries alone are not.
  const ok = issues.length > 0 || (raw.issues.length === 0 && problems.length === 0);
  return { ok, findings: ok ? { meta, issues } : null, problems };
}

/**
 * Parses, validates and writes `<scratchDir>/findings.json` (mode 0600) from the agent's stdout.
 * The path is fixed here; nothing from the agent's output chooses where the file goes.
 */
function writeFindingsFromAgentOutput(stdout, scratchDir) {
  const parsed = parseAgentFindings(stdout);
  if (!parsed) return { written: false, problems: ['no findings JSON found in the agent output'] };
  const { ok, findings, problems } = validateAgentFindings(parsed);
  if (!ok) return { written: false, problems };
  const target = path.join(scratchDir, 'findings.json');
  fs.mkdirSync(scratchDir, { recursive: true });
  fs.writeFileSync(target, JSON.stringify(findings, null, 2) + '\n', { mode: 0o600 });
  return { written: true, path: target, issueCount: findings.issues.length, problems };
}

module.exports = {
  FINDINGS_SCHEMA_PATH,
  parseAgentFindings,
  validateAgentFindings,
  writeFindingsFromAgentOutput
};
