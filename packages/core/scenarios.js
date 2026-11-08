'use strict';

/**
 * Scenario coverage: compares the agreed Given/When/Then scenarios of a story (for example the ones One Lens shows,
 * which come from JIRA) with the tests in a PR's Layer 4 behavioural test matrix.
 *
 * Tests link to scenarios by a tag in the test name, for example `[LUP-204-SC-1] member sees offline error`.
 * Everything here is pure (the one file loader aside) so it is unit-testable.
 *
 * Note on scope: Layer 4 only contains the test files CHANGED in the PR. A story that is delivered in several PRs
 * (backend, iOS, Android) will therefore look partly uncovered in each one. The result says so; the optional hard
 * rule is meant for teams that ship a story's scenarios in one PR.
 */

const fs = require('fs');

const MAX_SCENARIO_FILE_BYTES = 1024 * 1024;
const MAX_SCENARIOS = 500;
const MAX_REPORTED = 50;

const KEY_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
// `[LUP-204-SC-1]`, `LUP-204-SC-1`, `[lup-204_sc-1]`, `[LUP-204 SC-1]`, `[LUP-204-SC1]`
const TAG_RE = /\[?\b([A-Za-z][A-Za-z0-9]*-\d+)[-_ ][Ss][Cc][-_ ]?(\d+)\b\]?/g;
const FULL_RE = /^\[?([A-Za-z][A-Za-z0-9]*-\d+)[-_ ][Ss][Cc][-_ ]?(\d+)\]?$/;
const SCENARIO_ID_RE = /^[Ss][Cc][-_ ]?(\d+)$/;

function makeTag(storyKey, n) {
  return `${String(storyKey).toUpperCase()}-SC-${Number(n)}`;
}

/** All normalised scenario tags found in a piece of text (order preserved, duplicates kept). */
function extractScenarioTags(text) {
  const out = [];
  const s = String(text == null ? '' : text);
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(s))) out.push(makeTag(m[1], m[2]));
  return out;
}

/** Resolves one entry (string or object) to a normalised tag, or null when it cannot be understood. */
function resolveEntry(entry, defaultKey) {
  const raw = entry && typeof entry === 'object' ? entry.id || entry.tag || entry.scenarioId : entry;
  const key = entry && typeof entry === 'object' ? entry.storyKey || entry.key || defaultKey : defaultKey;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const text = String(raw).trim();
  if (text.length > 80) return null;
  const fm = FULL_RE.exec(text);
  if (fm) return makeTag(fm[1], fm[2]);
  const idMatch = SCENARIO_ID_RE.exec(text) || (typeof raw === 'number' ? [null, String(raw)] : null);
  if (idMatch && key && KEY_RE.test(String(key))) return makeTag(key, idMatch[1]);
  return null;
}

/**
 * Accepts any of:
 *   { "storyKey": "LUP-204", "scenarios": ["SC-1", { "id": "SC-2", "title": "..." }] }
 *   { "stories": [ { "key": "LUP-204", "scenarios": [...] } ] }
 *   [ "LUP-204-SC-1", { "storyKey": "LUP-204", "id": "SC-2" } ]
 * Returns { scenarios: [{ tag, title }], duplicates: [tag], invalid: [string] }. Never throws on bad entries.
 */
function parseScenarioInput(json) {
  const scenarios = [];
  const seen = new Set();
  const duplicates = [];
  const invalid = [];

  function add(entry, defaultKey) {
    if (scenarios.length >= MAX_SCENARIOS) return;
    const tag = resolveEntry(entry, defaultKey);
    if (!tag) {
      if (invalid.length < MAX_REPORTED) invalid.push(String(typeof entry === 'object' ? JSON.stringify(entry) : entry).slice(0, 80));
      return;
    }
    if (seen.has(tag)) {
      if (!duplicates.includes(tag)) duplicates.push(tag);
      return;
    }
    seen.add(tag);
    const title = entry && typeof entry === 'object' && typeof entry.title === 'string' ? entry.title.slice(0, 120) : '';
    scenarios.push({ tag, title });
  }

  if (Array.isArray(json)) {
    for (const e of json) add(e, undefined);
  } else if (json && typeof json === 'object') {
    if (Array.isArray(json.stories)) {
      for (const st of json.stories) {
        const key = st && (st.storyKey || st.key);
        for (const e of (st && Array.isArray(st.scenarios) ? st.scenarios : [])) add(e, key);
      }
    }
    if (Array.isArray(json.scenarios)) {
      for (const e of json.scenarios) add(e, json.storyKey || json.key);
    }
  }
  return { scenarios, duplicates, invalid };
}

/** Reads and parses a scenarios JSON file with a size cap. The file is data: it is never executed. */
function loadScenarioFile(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`Scenarios path ${filePath} is not a file`);
  if (stat.size > MAX_SCENARIO_FILE_BYTES) throw new Error(`Scenarios file exceeds ${MAX_SCENARIO_FILE_BYTES} bytes`);
  let json;
  try {
    json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`Scenarios file is not valid JSON: ${err.message}`);
  }
  const parsed = parseScenarioInput(json);
  if (!parsed.scenarios.length) throw new Error('Scenarios file contains no usable scenarios');
  return parsed;
}

/**
 * parsed: result of parseScenarioInput. testMatrix: Layer 4 (`[{ file, suite, cases: [{ behavior, hollow }] }]`).
 * A scenario counts as covered by at least one tagged test that is not hollow (zero assertions).
 */
function matchScenarioCoverage(parsed, testMatrix) {
  const known = new Map((parsed.scenarios || []).map((s) => [s.tag, s]));
  const found = new Map(); // tag -> [{ file, behavior, hollow }]
  const unknownTags = [];

  for (const tm of testMatrix || []) {
    for (const c of (tm && tm.cases) || []) {
      const text = `${(tm && tm.suite) || ''} ${(c && c.behavior) || ''}`;
      for (const tag of new Set(extractScenarioTags(text))) {
        const hit = { file: (tm && tm.file) || '', behavior: String((c && c.behavior) || '').slice(0, 100), hollow: Boolean(c && c.hollow) };
        if (known.has(tag)) {
          if (!found.has(tag)) found.set(tag, []);
          found.get(tag).push(hit);
        } else if (unknownTags.length < MAX_REPORTED) {
          unknownTags.push({ tag, ...hit });
        }
      }
    }
  }

  const covered = [];
  const uncovered = [];
  const testCounts = {};
  for (const { tag } of parsed.scenarios || []) {
    const tests = found.get(tag) || [];
    testCounts[tag] = tests.length;
    if (tests.some((t) => !t.hollow)) covered.push(tag);
    else uncovered.push({ tag, reason: tests.length ? 'hollow-only' : 'no-test' });
  }
  return {
    total: (parsed.scenarios || []).length,
    covered,
    uncovered,
    unknownTags,
    duplicates: parsed.duplicates || [],
    invalid: parsed.invalid || [],
    testCounts
  };
}

module.exports = {
  MAX_SCENARIO_FILE_BYTES,
  extractScenarioTags,
  parseScenarioInput,
  loadScenarioFile,
  matchScenarioCoverage
};
