'use strict';

const { spawnSync: defaultSpawnSync } = require('child_process');
const { parseGitHubRepoSlug } = require('./repo-config');
const { parsePaginatedGhJson } = require('./github-comments');

/**
 * 4-Layer Agentic PR Diff Classifier & Behavioral Test Matrix Extractor
 *
 * Replaces flat alphabetical file lists with human-leverage layers:
 * 1. `contracts`: API specs, Event/Topic schemas, DB models, Feature flags, ADRs & Solution Designs
 * 2. `flows`: Production business logic, service handlers, webhook pipelines, providers
 * 3. `tests`: Unit/integration tests -> converted into a Behavioral Test Matrix (raw diff collapsed by default)
 * 4. `config`: Package manifests, build/infra config
 */

const CONTRACT_PATTERNS = [
  /openapi-spec/i,
  /\.openapi\./i,
  /schema/i,
  /contract/i,
  /models\.ts$/i,
  /member-status\.ts$/i,
  /feature-flag/i,
  /firestore\.rules$/i,
  /\.graphql$/i,
  /\.proto$/i,
  /^docs\/design\//i,
  /adr-\d+/i,
  /(^|\/)(?:SKILL|AGENTS|CLAUDE)\.md$/i,
  /\.cursorrules$/i,
  /mcp\.json$/i
];

const TEST_PATTERNS = [
  /\.test\.[jt]sx?$/i,
  /\.spec\.[jt]sx?$/i,
  /(^|\/)test\//i,
  /(^|\/)__tests__\//i
];

const CONFIG_PATTERNS = [
  /package(-lock)?\.json$/i,
  /pnpm-lock\.yaml$/i,
  /tsconfig.*\.json$/i,
  /\.eslintrc/i,
  /jest\.config/i,
  /vitest\.config/i
];

function classifyFilePath(filePath) {
  const norm = String(filePath || '').replace(/\\/g, '/');
  if (TEST_PATTERNS.some((re) => re.test(norm))) {
    return {
      layer: 'tests',
      category: 'Unit / Integration Test',
      collapseDiffByDefault: true,
      humanFocus: 'Review Behavioral Test Matrix & assertion coverage; skip raw mock boilerplate.'
    };
  }
  if (CONTRACT_PATTERNS.some((re) => re.test(norm))) {
    let subcat = 'Contract / Schema';
    if (/docs\/design|adr-/i.test(norm)) subcat = 'ADR / Solution Design';
    else if (/(^|\/)(?:SKILL|AGENTS|CLAUDE)\.md$|\.cursorrules$|mcp\.json$/i.test(norm))
      subcat = 'AI Harness / Prompt Contract';
    else if (/openapi/i.test(norm)) subcat = 'OpenAPI Contract';
    else if (/feature-flag/i.test(norm)) subcat = 'Feature Flag Contract';
    else if (/topic|event|status|model/i.test(norm)) subcat = 'Domain / Event Schema';
    return {
      layer: 'contracts',
      category: subcat,
      collapseDiffByDefault: false,
      humanFocus: 'High human leverage: verify state transitions, public contracts, and ADR alignment.'
    };
  }
  if (CONFIG_PATTERNS.some((re) => re.test(norm))) {
    return {
      layer: 'config',
      category: 'Config / Manifest',
      collapseDiffByDefault: true,
      humanFocus: 'Low risk unless dependencies or runtime flags change.'
    };
  }
  return {
    layer: 'flows',
    category: inferFlowName(norm),
    collapseDiffByDefault: false,
    humanFocus: 'Core production flow: inspect state mutations, error handling, and side effects.'
  };
}

function inferFlowName(filePath) {
  const norm = String(filePath || '').replace(/\\/g, '/');

  // Function / route / feature module directory (e.g. src/functions/<name>/..., src/routes/<name>/..., src/modules/<name>/...)
  const fnMatch = /(?:^|\/)(?:functions|routes|controllers|handlers|modules|features|commands|queries|use-cases)\/([^/]+)/i.exec(
    norm
  );
  if (fnMatch) {
    return `Feature / Handler: ${fnMatch[1]}`;
  }

  // Monorepo service or app (e.g. services/<domain>/<service>/..., apps/<app>/..., packages/<pkg>/...)
  const svcMatch = /^(services|apps|packages)\/([^/]+)(?:\/([^/]+))?/i.exec(norm);
  if (svcMatch) {
    const [, root, first, second] = svcMatch;
    if (second && !['src', 'lib', 'dist', 'test', 'tests'].includes(second)) {
      return `${root}/${first}/${second}`;
    }
    return `${root}/${first}`;
  }

  const parts = norm.split('/').filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return 'Core Production Logic';
}

/**
 * Parses a unified git diff string into structured file diffs with line-numbered hunks.
 */
function parseUnifiedDiff(diffText) {
  if (!diffText || typeof diffText !== 'string') return [];
  const files = [];
  const chunks = diffText.split(/^diff --git /m).filter(Boolean);

  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    const headerMatch = /^a\/(\S+)\s+b\/(\S+)/.exec(lines[0] || '');
    const filePath = headerMatch ? headerMatch[2] : (lines[0] || '').trim();
    const classification = classifyFilePath(filePath);

    const hunks = [];
    let currentHunk = null;
    let oldLine = 0;
    let newLine = 0;
    let additions = 0;
    let deletions = 0;
    let fallbackAdditions = null;
    let fallbackDeletions = null;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const statsMatch = /^# crv-file-stats:\s*additions=(\d+)\s+deletions=(\d+)/.exec(line);
      if (statsMatch) {
        fallbackAdditions = Number(statsMatch[1]);
        fallbackDeletions = Number(statsMatch[2]);
        continue;
      }
      const hunkMatch = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)/.exec(line);
      if (hunkMatch) {
        currentHunk = {
          header: line,
          context: (hunkMatch[3] || '').trim(),
          oldStart: Number(hunkMatch[1]),
          newStart: Number(hunkMatch[2]),
          lines: []
        };
        hunks.push(currentHunk);
        oldLine = currentHunk.oldStart;
        newLine = currentHunk.newStart;
        continue;
      }

      if (!currentHunk) continue;

      if (line.startsWith('+') && !line.startsWith('+++')) {
        additions++;
        currentHunk.lines.push({
          type: 'add',
          oldNumber: null,
          newNumber: newLine++,
          content: line.slice(1)
        });
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deletions++;
        currentHunk.lines.push({
          type: 'del',
          oldNumber: oldLine++,
          newNumber: null,
          content: line.slice(1)
        });
      } else if (line.startsWith(' ')) {
        currentHunk.lines.push({
          type: 'ctx',
          oldNumber: oldLine++,
          newNumber: newLine++,
          content: line.slice(1)
        });
      }
    }

    if (hunks.length === 0 && fallbackAdditions !== null && fallbackDeletions !== null) {
      additions = fallbackAdditions;
      deletions = fallbackDeletions;
    }

    const fileEntry = {
      path: filePath,
      ...classification,
      additions,
      deletions,
      hunks
    };

    if (classification.layer === 'tests') {
      fileEntry.testMatrix = extractTestCasesFromHunks(filePath, hunks);
      fileEntry.internalMocks = extractInternalMocksFromHunks(hunks);
      fileEntry.shortcuts = [];
    } else if (classification.layer === 'flows' || classification.layer === 'contracts') {
      fileEntry.removedGuards = extractRemovedGuardsFromHunks(filePath, hunks);
      fileEntry.addedSymbols = extractAddedSymbolsFromHunks(filePath, hunks);
      fileEntry.shortcuts = extractShortcutsFromHunks(filePath, hunks);
    } else {
      fileEntry.shortcuts = extractShortcutsFromHunks(filePath, hunks);
    }

    files.push(fileEntry);
  }

  return files;
}

const IGNORED_SYMBOL_NAMES = new Set([
  'main',
  'init',
  'constructor',
  'render',
  'handler',
  'index',
  'anonymous',
  'setup',
  'teardown',
  'default',
  'execute'
]);

/**
 * Detects defensive guards, validation checks, auth checks, schema strictness,
 * or error handling removed in non-test diff hunks without an equivalent replacement.
 */
function extractRemovedGuardsFromHunks(filePath, hunks) {
  const removed = [];
  for (const hunk of hunks || []) {
    const addedLines = (hunk.lines || [])
      .filter((l) => l.type === 'add')
      .map((l) => String(l.content || '').trim());
    const addedJoined = addedLines.join('\n');

    for (const l of hunk.lines || []) {
      if (l.type !== 'del') continue;
      const trimmed = String(l.content || '').trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
        continue;
      }

      let category = null;
      if (/\b(?:isAuthorized|hasPermission|hasRole|requireAuth|verifyToken|checkAuth|canAccess|isAdmin|assertAuth)\b/i.test(trimmed)) {
        if (!/\b(?:isAuthorized|hasPermission|hasRole|requireAuth|verifyToken|checkAuth|canAccess|isAdmin|assertAuth)\b/i.test(addedJoined)) {
          category = 'auth-permission-check';
        }
      } else if (/\bif\s*\([^)]+\)\s*(?:\{\s*)?(?:throw\b|return\b)/.test(trimmed)) {
        if (!addedLines.includes(trimmed) && !/\bif\s*\([^)]+\)\s*(?:\{\s*)?throw\b/.test(addedJoined)) {
          category = 'early-return-or-throw';
        }
      } else if (/^throw\s+new\s+[A-Za-z0-9_$]+/.test(trimmed)) {
        if (!/\bthrow\s+new\b/.test(addedJoined)) {
          category = 'throw-guard';
        }
      } else if (/\.(?:strict|safeParse|parse)\s*\(/.test(trimmed)) {
        if (!/\.(?:strict|safeParse|parse)\s*\(/.test(addedJoined)) {
          category = 'schema-validation';
        }
      } else if (/\b(?:timeout|AbortSignal|signal|maxRetries)\s*:/.test(trimmed)) {
        if (!/\b(?:timeout|AbortSignal|signal|maxRetries)\s*:/.test(addedJoined)) {
          category = 'timeout-or-retry-guard';
        }
      }

      if (category) {
        removed.push({
          path: filePath,
          oldLine: l.oldNumber,
          newLine: hunk.newStart || l.oldNumber,
          category,
          code: trimmed.slice(0, 140)
        });
      }
    }
  }
  return removed;
}

/**
 * Extracts newly declared function/class/helper symbol names in production hunks
 * so `prepare_pr.mjs` and the `structure` lens can check for near-duplicate utilities.
 */
function extractAddedSymbolsFromHunks(filePath, hunks) {
  const deletedNames = new Set();
  const added = [];
  const seenAdded = new Set();

  const patterns = [
    /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/,
    /(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/,
    /(?:export\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/,
    /^\s*def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/
  ];

  for (const hunk of hunks || []) {
    for (const l of hunk.lines || []) {
      const text = String(l.content || '');
      for (const re of patterns) {
        const m = re.exec(text);
        if (m && m[1]) {
          if (l.type === 'del') {
            deletedNames.add(m[1]);
          } else if (l.type === 'add') {
            const name = m[1];
            if (name.length >= 4 && !IGNORED_SYMBOL_NAMES.has(name) && !seenAdded.has(name)) {
              seenAdded.add(name);
              added.push({ name, path: filePath, line: l.newNumber });
            }
          }
        }
      }
    }
  }

  return added.filter((s) => !deletedNames.has(s.name));
}

/**
 * Extracts deliberate shortcut (`shortcut:` / `ponytail:`) and deferral (`TODO:` / `FIXME:`)
 * comments added in diff hunks. Distinguishes bounded shortcuts with an explicit ceiling + upgrade
 * path (`hasTrigger: true`) from unbounded deferrals (`rotRisk: true`).
 */
function extractShortcutsFromHunks(filePath, hunks) {
  if (Array.isArray(filePath)) {
    const all = [];
    for (const f of filePath) {
      if (f.layer === 'tests') continue;
      all.push(...extractShortcutsFromHunks(f.path, f.hunks));
    }
    return all;
  }
  const normPath = String(filePath || '').replace(/\\/g, '/');
  if (/\.(?:md|mdx|txt|rst)$/i.test(normPath) || TEST_PATTERNS.some((re) => re.test(normPath))) {
    return [];
  }

  const shortcuts = [];
  // Match full-line comments or trailing comments not enclosed in quotes or backticks
  const fullLineCommentRe = /^\s*(?:\/\/|#|\/\*+|\*)\s*(shortcut|ponytail|todo|fixme)\s*:\s*(.+?)(?:\*\/)?$/i;
  const trailingCommentRe = /^[^'"`]*?(?:\/\/|#)\s*(shortcut|ponytail|todo|fixme)\s*:\s*(.+?)$/i;

  for (const hunk of hunks || []) {
    for (const l of hunk.lines || []) {
      if (l.type !== 'add') continue;
      const text = String(l.content || '').trim();
      const m = fullLineCommentRe.exec(text) || trailingCommentRe.exec(text);
      if (!m) continue;

      const marker = m[1].toLowerCase();
      const body = m[2].trim();
      let ceiling = '';
      let upgrade = '';
      let hasTrigger = false;

      if (marker === 'shortcut' || marker === 'ponytail') {
        const splitMatch = /^([^,;—–-]+?)(?:\s*(?:,|;|->|→|—|–|\bwhen\b|\buntil\b|\bbefore\b)\s*)(.+)$/i.exec(body);
        if (splitMatch && splitMatch[1].trim().length >= 3 && splitMatch[2].trim().length >= 3) {
          ceiling = splitMatch[1].trim();
          upgrade = splitMatch[2].trim();
          hasTrigger = true;
        } else {
          ceiling = body;
          hasTrigger = false;
        }
      } else {
        const triggerMatch = /\b(?:when|until|after|before|once|at\s+\d+|#[0-9]+|[A-Z]{2,}-\d+)\b/i.exec(body);
        hasTrigger = Boolean(triggerMatch);
        ceiling = body;
      }

      shortcuts.push({
        path: filePath,
        line: l.newNumber,
        marker,
        kind: marker,
        text: body.slice(0, 200),
        ceiling,
        upgrade,
        hasTrigger,
        rotRisk: !hasTrigger
      });
    }
  }
  return shortcuts;
}

/**
 * Parses a GitHub/GitLab CODEOWNERS file into ordered `{ pattern, regex, owners }` rules.
 */
function parseCodeowners(codeownersText) {
  if (!codeownersText || typeof codeownersText !== 'string') return [];
  const rules = [];
  for (const rawLine of codeownersText.split(/\r?\n/)) {
    const stripped = rawLine.replace(/\s+#.*$/, '').trim();
    if (!stripped || stripped.startsWith('#')) continue;
    const parts = stripped.split(/\s+/);
    if (parts.length < 2) continue;
    const pattern = parts[0];
    const owners = parts.slice(1).filter((p) => p.startsWith('@') || p.includes('@'));
    if (!owners.length) continue;

    const clean = pattern.replace(/^\//, '').replace(/\/$/, '');
    const anchored = pattern.startsWith('/') || clean.includes('/');
    const dirOnly = pattern.endsWith('/');
    const endsWithSingleWildcard = /(?:^|\/)\*[^/]*$/.test(clean) && !/\*\*$/.test(clean);
    const escaped = clean
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\?/g, '[^/]')
      .replace(/\/\*\*\//g, '__SLASH_DOUBLE_STAR_SLASH__')
      .replace(/\*\*/g, '__DOUBLE_STAR__')
      .replace(/\*/g, '[^/]*')
      .replace(/__SLASH_DOUBLE_STAR_SLASH__/g, '(?:/.*)?/')
      .replace(/__DOUBLE_STAR__/g, '.*');

    const suffix = dirOnly ? '(?:/.*)?$' : endsWithSingleWildcard ? '$' : '(?:/.*|$)';
    const regexStr =
      pattern === '*'
        ? '^.*$'
        : `${anchored ? '^' : '(?:^|/)'}${escaped}${suffix}`;
    try {
      rules.push({ pattern, regex: new RegExp(regexStr), owners });
    } catch (e) {}
  }
  return rules;
}

/**
 * Matches a repository-relative file path against parsed CODEOWNERS rules (last match wins).
 */
function matchCodeowners(filePath, rules = []) {
  const norm = String(filePath || '').replace(/\\/g, '/').replace(/^\//, '');
  let matched = [];
  for (const rule of rules || []) {
    if (rule.regex && rule.regex.test(norm)) {
      matched = rule.owners;
    }
  }
  return matched;
}

/**
 * Parses PR / ticket description text for:
 * - `outOfScope`: Negative Space / Out-of-Scope / Do-Not-Touch constraints
 * - `repoPrecedents`: Repo Precedent / Mirror references
 * - `specClauses`: BDD (`Given/When/Then`) and EARS (`WHEN ... SHALL`, `IF ... THEN ... SHALL`, `WHILE ... SHALL`) clauses
 * Cross-checks changed files against `outOfScope` (`negativeSpaceViolations`) and `specClauses` against `testMatrix`.
 */
function analyzeSpecAlignment(parsedFiles = [], prMeta = null) {
  const body = String((prMeta && prMeta.body) || '');
  const outOfScope = [];
  const repoPrecedents = [];
  const rawClauses = [];

  if (body.trim()) {
    const lines = body.split(/\r?\n/);
    let section = '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      const headingMatch = /^#{1,4}\s+(.+)$/.exec(line) || /^\*\*([^*]+)\*\*[:.]?$/.exec(line);
      if (headingMatch) {
        const h = headingMatch[1].toLowerCase();
        if (/out of scope|non-goals?|negative space|do not touch|untouched/i.test(h)) {
          section = 'out-of-scope';
        } else if (/repo precedent|precedent|mirror/i.test(h)) {
          section = 'precedent';
        } else if (/acceptance|scenarios?|requirements?|behaviour|behavior|ears|bdd/i.test(h)) {
          section = 'spec';
        } else {
          section = '';
        }
        continue;
      }

      const inlineOos = /^(?:[-*]\s+)?(?:\*{1,2})?(?:out of scope|do not touch|negative space|leave untouched)(?:\*{1,2})?[:\s-]+(.+)$/i.exec(line);
      if (inlineOos) {
        outOfScope.push(inlineOos[1].trim());
        continue;
      }

      const inlinePrec = /^(?:[-*]\s+)?(?:\*{1,2})?(?:repo precedent|precedent|mirror)(?:\*{1,2})?[:\s-]+(.+)$/i.exec(line);
      if (inlinePrec) {
        repoPrecedents.push(inlinePrec[1].trim());
        continue;
      }

      const bullet = /^[-*]\s+(.+)$/.exec(line) || /^\d+\.\s+(.+)$/.exec(line);
      const itemText = bullet ? bullet[1].trim() : line;

      if (section === 'out-of-scope' && bullet) {
        outOfScope.push(itemText);
        continue;
      } else if (section === 'precedent' && bullet) {
        repoPrecedents.push(itemText);
        continue;
      }

      const unbackticked = itemText.replace(/`[^`]*`/g, '');
      const allowSpecMatch =
        section === 'spec' || /^(?:given|when|while|if)\s+/i.test(unbackticked.trim());
      if (allowSpecMatch) {
        if (/\bGiven\s+[\s\S]+\bWhen\s+[\s\S]+\bThen\s+/i.test(unbackticked)) {
          rawClauses.push({ kind: 'BDD', clause: itemText.slice(0, 220) });
        } else if (
          /\b(?:WHEN|WHILE)\s+[^.]+?\bSHALL\s+|\bIF\s+[^.]+?\bTHEN\s+[^.]+?\bSHALL\s+/i.test(unbackticked)
        ) {
          rawClauses.push({ kind: 'EARS', clause: itemText.slice(0, 220) });
        }
      }
    }
  }

  const negativeSpaceViolations = [];
  if (outOfScope.length > 0) {
    for (const f of parsedFiles || []) {
      if ((f.additions || 0) + (f.deletions || 0) === 0) continue;
      const normPath = String(f.path || '').toLowerCase().replace(/\\/g, '/');
      for (const item of outOfScope) {
        const cleanToken = (t) => t.toLowerCase().trim().replace(/^[.,:;!?'"]+|[.,:;!?'"]+$/g, '').replace(/^\/+|\/+$/g, '');
        const isPathLike = (t) =>
          t.length >= 4 &&
          (t.includes('/') || /\.[a-z0-9]{1,5}$/i.test(t));
        const backticks = [...item.matchAll(/`([^`]+)`/g)].map((m) => cleanToken(m[1])).filter(isPathLike);
        const pathTokens = item
          .split(/[\s,;()]+/)
          .map(cleanToken)
          .filter(isPathLike);
        const candidates = [...new Set([...backticks, ...pathTokens])];
        const matchedToken = candidates.find((c) => {
          const esc = c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
          return new RegExp(`(?:^|/)${esc}(?:/|$)`).test(normPath);
        });
        if (matchedToken) {
          negativeSpaceViolations.push({
            path: f.path,
            matchedToken,
            outOfScopeItem: item,
            reason: `File "${f.path}" was modified (+${f.additions}/-${f.deletions}) despite Negative Space / Out-of-Scope constraint: "${item}"`
          });
          break;
        }
      }
    }
  }

  const allTests = [];
  for (const f of parsedFiles || []) {
    for (const tc of f.testMatrix || []) {
      if (!tc.hollow) {
        allTests.push({
          file: f.path,
          behavior: tc.behavior,
          text: `${tc.suite || ''} ${tc.behavior || ''}`.toLowerCase()
        });
      }
    }
  }

  const stopWords = new Set(['given', 'when', 'then', 'shall', 'should', 'while', 'system', 'service', 'request', 'response', 'return', 'returns', 'with', 'from', 'that', 'this', 'into', 'only']);
  const specClauses = rawClauses.map((sc) => {
    const keywords = sc.clause
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length >= 4 && !stopWords.has(w));
    const matchedTests = allTests
      .filter((t) => {
        if (keywords.length === 0) return false;
        const hits = keywords.filter((kw) => t.text.includes(kw));
        return hits.length >= Math.min(2, keywords.length);
      })
      .map((t) => `${t.file}: ${t.behavior}`);
    return {
      kind: sc.kind,
      clause: sc.clause,
      covered: matchedTests.length > 0,
      matchedTests: matchedTests.slice(0, 3)
    };
  });

  return {
    outOfScope,
    repoPrecedents,
    negativeSpaceViolations,
    specClauses
  };
}

/**
 * Extracts relative internal module paths mocked in a test file (`jest.mock('./...')`, `vi.mock('../...')`).
 */
function extractInternalMocksFromHunks(hunks) {
  const mocks = [];
  const seen = new Set();
  const re = /\b(?:jest|vi|sinon)\.(?:mock|doMock)\s*\(\s*(['"`])(\.\.?\/[^'"`]+)\1|\bmock\.module\s*\(\s*(['"`])(\.\.?\/[^'"`]+)\3/g;
  for (const hunk of hunks || []) {
    for (const l of hunk.lines || []) {
      if (l.type === 'del') continue;
      const text = String(l.content || '');
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(text)) !== null) {
        const modPath = m[2] || m[4];
        if (modPath && !seen.has(modPath)) {
          seen.add(modPath);
          mocks.push(modPath);
        }
      }
    }
  }
  return mocks;
}

function extractLeadingStringLiteral(str) {
  const first = /^\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/.exec(str);
  if (!first) return null;
  let result = first[2].replace(/\\(['"`])/g, '$1').replace(/\s+/g, ' ').trim();
  let rest = str.slice(first[0].length);
  while (true) {
    const nextPart = /^\s*\+\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/.exec(rest);
    if (!nextPart) break;
    result = `${result} ${nextPart[2].replace(/\\(['"`])/g, '$1').replace(/\s+/g, ' ').trim()}`.trim();
    rest = rest.slice(nextPart[0].length);
  }
  return result;
}

function advanceTestBlockDepth(state, lineText, startIndex = 0) {
  const len = lineText.length;
  for (let i = startIndex; i < len; i++) {
    const ch = lineText[i];
    const next = i + 1 < len ? lineText[i + 1] : '';

    if (state.inBlockComment) {
      if (ch === '*' && next === '/') {
        state.inBlockComment = false;
        i++;
      }
      continue;
    }

    if (state.inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === state.inString) {
        state.inString = null;
      }
      continue;
    }

    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      break;
    }
    if (ch === '/' && next === '*') {
      state.inBlockComment = true;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      state.inString = ch;
      continue;
    }

    if (ch === '(') {
      state.parenDepth++;
    } else if (ch === ')') {
      if (state.parenDepth > 0) state.parenDepth--;
      if (
        (state.seenBodyBrace || state.seenCallback) &&
        state.parenDepth === 0 &&
        state.braceDepth === 0
      ) {
        state.closed = true;
        return;
      }
    } else if (ch === '{') {
      state.braceDepth++;
      if (state.parenDepth >= 1) {
        state.seenBodyBrace = true;
      }
    } else if (ch === '}') {
      if (state.braceDepth > 0) state.braceDepth--;
      if (
        state.seenBodyBrace &&
        state.braceDepth === 0 &&
        (state.parenDepth === 0 || /^\s*\)/.test(lineText.slice(i + 1)))
      ) {
        state.closed = true;
        return;
      }
    } else if (ch === '=' && next === '>' && state.parenDepth >= 1) {
      state.seenCallback = true;
      i++;
    }
  }
  if (state.inString === "'" || state.inString === '"') {
    state.inString = null;
  }
}

/**
 * Extracts a Behavioral Test Matrix from test file diff hunks:
 * finds `describe(...)`, `it(...)`, `test(...)` blocks and counts `expect(...)` / `assert` calls,
 * flagging hollow tests (`assertions === 0`), mock-only tests (`mockOnly`), oracle tautologies (`tautology`),
 * and internal seam mocks (`internalMock`).
 *
 * Rules to prevent false positives from diff hunk context lines:
 * 1. Only extract `it(...)` / `test(...)` blocks that were added or modified in the diff (`hasChanges === true`).
 *    Unchanged neighbor tests appearing only in leading/trailing context lines (`ctx`) are skipped.
 * 2. Track brace/paren depth within the hunk and require the test block's closing `});` to be reached
 *    (`closed === true`) before flagging `hollow: true`, `mockOnly: true`, or `tautology: true`.
 */
function extractTestCasesFromHunks(filePath, hunks) {
  const cases = [];
  let currentSuite = '';
  let currentCase = null;
  const internalMocks = extractInternalMocksFromHunks(hunks);

  const literalTautologyRe =
    /\bexpect\s*\(\s*(true|false|null|undefined|\d+|'[^']*'|"[^"]*")\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual|toBeTruthy|toBeFalsy)\s*\(\s*\1?\s*\)|\bassert(?:\.strictEqual|\.equal)?\s*\(\s*(true|false|\d+|'[^']*'|"[^"]*")\s*(?:,\s*\2)?\s*\)/;
  const descOpenRe =
    /(?:^|[;{])\s*describe(?:\.(?:only|skip|concurrent|sequential))?(?:\.each\s*\([^)]*\))?\s*\(/;
  const itOpenRe =
    /(?:^|[;{])\s*(?:it|test)(?:\.(?:only|skip|concurrent|sequential))?(?:\.each\s*\([^)]*\))?\s*\(/;

  const finalizeCase = (tc) => {
    if (!tc || !tc.hasChanges) return;
    cases.push({
      suite: tc.suite,
      behavior: tc.behavior,
      line: tc.line,
      assertions: tc.assertions,
      mockAssertions: tc.mockAssertions,
      tautologyAssertions: tc.tautologyAssertions,
      verifiedTargets: tc.verifiedTargets,
      closed: Boolean(tc._depthState && tc._depthState.closed)
    });
  };

  for (const hunk of hunks || []) {
    if (hunk.context) {
      const ctxDesc = /\bdescribe\s*\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/.exec(hunk.context);
      if (ctxDesc) {
        currentSuite = ctxDesc[2];
      }
    }

    const lines = hunk.lines || [];
    for (let idx = 0; idx < lines.length; idx++) {
      const l = lines[idx];
      if (l.type === 'del') {
        if (currentCase) {
          currentCase.hasChanges = true;
        }
        continue;
      }
      const text = l.content;

      const descMatch = descOpenRe.exec(text);
      if (descMatch) {
        const descOpenParenIdx = descMatch.index + descMatch[0].length - 1;
        let descWindow = text.slice(descOpenParenIdx + 1);
        for (let k = idx + 1; k < lines.length && k <= idx + 3; k++) {
          if (lines[k].type !== 'del') {
            descWindow += '\n' + lines[k].content;
          }
        }
        const parsedSuite = extractLeadingStringLiteral(descWindow);
        if (parsedSuite) {
          currentSuite = parsedSuite;
        }
      }

      let depthStartIdx = 0;
      const itMatch = itOpenRe.exec(text);
      if (itMatch) {
        const openParenIdx = itMatch.index + itMatch[0].length - 1;
        let headerWindow = text.slice(openParenIdx + 1);
        for (let k = idx + 1; k < lines.length && k <= idx + 4; k++) {
          if (lines[k].type !== 'del') {
            headerWindow += '\n' + lines[k].content;
          }
        }
        const behavior = extractLeadingStringLiteral(headerWindow);
        if (behavior !== null) {
          if (currentCase) finalizeCase(currentCase);
          currentCase = {
            suite: currentSuite || inferSuiteFromPath(filePath),
            behavior,
            line: l.newNumber || l.oldNumber || hunk.newStart || 1,
            assertions: 0,
            mockAssertions: 0,
            tautologyAssertions: 0,
            verifiedTargets: [],
            headerAdded: l.type === 'add',
            hasChanges: l.type === 'add',
            _depthState: {
              parenDepth: 0,
              braceDepth: 0,
              inString: null,
              inBlockComment: false,
              seenCallback: false,
              seenBodyBrace: false,
              closed: false
            }
          };
          depthStartIdx = openParenIdx;
        }
      }

      if (currentCase) {
        if (l.type === 'add') {
          currentCase.hasChanges = true;
        }
        const expectMatches = text.match(/\b(?:expect|assert(?:\.[a-zA-Z]+)?)\s*\(/g);
        if (expectMatches) {
          currentCase.assertions += expectMatches.length;
        }
        if (/\btoHaveBeenCalled|\btoHaveBeenCalledWith/.test(text)) {
          currentCase.mockAssertions = (currentCase.mockAssertions || 0) + 1;
        }
        if (literalTautologyRe.test(text)) {
          currentCase.tautologyAssertions = (currentCase.tautologyAssertions || 0) + 1;
        }
        const targetMatch = /\b(?:expect|assert)\s*\(\s*([a-zA-Z0-9_.]+)\s*\)/.exec(text);
        if (targetMatch && !currentCase.verifiedTargets.includes(targetMatch[1])) {
          currentCase.verifiedTargets.push(targetMatch[1]);
        }

        advanceTestBlockDepth(currentCase._depthState, text, depthStartIdx);
        if (currentCase._depthState.closed) {
          finalizeCase(currentCase);
          currentCase = null;
        }
      }
    }

    if (currentCase) {
      finalizeCase(currentCase);
      currentCase = null;
    }
  }

  return cases.map((c) => {
    const closed = Boolean(c.closed);
    const truncated = !closed;
    const hollow = closed && c.assertions === 0;
    const mockOnly = closed && c.assertions > 0 && c.mockAssertions === c.assertions;
    const tautology = closed && c.assertions > 0 && c.tautologyAssertions === c.assertions;
    const internalMock = closed && internalMocks.length > 0 && (mockOnly || c.mockAssertions > 0);
    return {
      ...c,
      closed,
      truncated,
      hollow,
      mockOnly,
      tautology,
      internalMock,
      internalMockPaths: internalMock ? internalMocks : []
    };
  });
}

function summarizeContractDiff(fileObj) {
  const highlights = [];
  for (const h of fileObj.hunks || []) {
    for (const l of h.lines || []) {
      if (l.type === 'add' || l.type === 'del') {
        const trimmed = String(l.content || '').trim();
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
        const prefix = l.type === 'add' ? '+' : '-';
        highlights.push(`${prefix} ${trimmed}`);
        if (highlights.length >= 2) break;
      }
    }
    if (highlights.length >= 2) break;
  }
  if (highlights.length > 0) {
    return highlights.join(' ; ').slice(0, 180);
  }
  return `+${fileObj.additions || 0} / -${fileObj.deletions || 0} lines changed in ${fileObj.category || 'contract'}.`;
}

function formatHunksAsRawDiff(fileObj) {
  const out = [];
  for (const h of fileObj.hunks || []) {
    if (h.header) out.push(h.header);
    for (const l of h.lines || []) {
      const prefix = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
      out.push(`${prefix}${l.content}`);
    }
  }
  return out.join('\n');
}

/**
 * Computes Human Attention Signals across parsed files:
 * - `removedGuards`: deleted validation/auth/schema/timeout guards in production hunks
 * - `addedSymbols`: newly introduced functions/classes in production hunks
 * - `reuseCandidates`: newly added symbols that duplicate existing repo helpers or appear in multiple diff files
 * - `stealthChanges`: high-blast-radius files (contracts, auth, security, migrations) changed without mention in PR description
 * - `humanFocusPrompts`: concise review prompts for Layer 1
 */
function analyzeAttentionSignals(parsedFiles = [], options = {}) {
  const removedGuards = [];
  const addedSymbols = [];
  const shortcuts = [];
  const symbolToFiles = new Map();

  for (const f of parsedFiles || []) {
    if (Array.isArray(f.removedGuards)) {
      removedGuards.push(...f.removedGuards);
    }
    if (Array.isArray(f.shortcuts)) {
      shortcuts.push(...f.shortcuts);
    }
    if (Array.isArray(f.addedSymbols)) {
      for (const sym of f.addedSymbols) {
        addedSymbols.push(sym);
        if (!symbolToFiles.has(sym.name)) symbolToFiles.set(sym.name, []);
        symbolToFiles.get(sym.name).push(sym);
      }
    }
  }

  const reuseCandidates = Array.isArray(options.reuseCandidates) ? [...options.reuseCandidates] : [];
  const existingReuseNames = new Set(reuseCandidates.map((r) => `${r.name}@${r.addedIn}`));

  for (const [name, locs] of symbolToFiles.entries()) {
    if (locs.length > 1) {
      const key = `${name}@${locs[0].path}:${locs[0].line}`;
      if (!existingReuseNames.has(key)) {
        reuseCandidates.push({
          name,
          addedIn: `${locs[0].path}:${locs[0].line}`,
          existingMatches: locs.slice(1).map((l) => `${l.path}:${l.line}`),
          kind: 'duplicate-in-diff'
        });
      }
    }
  }

  const stealthChanges = [];
  const prMeta = options.prMeta || null;
  const claimText = prMeta
    ? `${prMeta.title || ''}\n${prMeta.body || ''}`.toLowerCase()
    : '';

  if (claimText.trim().length >= 12) {
    for (const f of parsedFiles || []) {
      const isHighBlastRadius =
        f.layer === 'contracts' ||
        /(?:^|\/)(?:auth|security|permissions?|migrations?|rbac|acl|billing|payment|webhook|middleware|firestore\.rules)/i.test(
          f.path
        );
      if (!isHighBlastRadius) continue;
      if ((f.additions || 0) + (f.deletions || 0) === 0) continue;

      const tokens = String(f.path || '')
        .toLowerCase()
        .split(/[/.\\_-]+/)
        .filter((t) => t.length >= 4 && !['index', 'src', 'lib', 'packages', 'services', 'apps', 'test', 'spec', 'json', 'yaml'].includes(t));

      const mentioned = tokens.length === 0 || tokens.some((tok) => claimText.includes(tok));
      if (!mentioned) {
        stealthChanges.push({
          path: f.path,
          layer: f.layer,
          category: f.category,
          additions: f.additions || 0,
          deletions: f.deletions || 0,
          reason: `High-blast-radius ${f.category || f.layer} modified (+${f.additions || 0}/-${f.deletions || 0}) without mention in PR title/description`
        });
      }
    }
  }

  const specAlignment = analyzeSpecAlignment(parsedFiles, prMeta);
  const rotRiskShortcuts = shortcuts.filter((s) => s.rotRisk);
  const uncoveredClauses = (specAlignment.specClauses || []).filter((c) => !c.covered);

  const humanFocusPrompts = [];
  if (specAlignment.negativeSpaceViolations.length > 0) {
    humanFocusPrompts.push(
      `Check ${specAlignment.negativeSpaceViolations.length} Negative-Space violation(s) (${specAlignment.negativeSpaceViolations.map((v) => v.path).slice(0, 3).join(', ')}) touching files marked Out-of-Scope.`
    );
  }
  if (removedGuards.length > 0) {
    humanFocusPrompts.push(
      `Inspect ${removedGuards.length} removed guard(s) (${removedGuards.map((g) => `${g.path}:${g.newLine}`).slice(0, 3).join(', ')}) to confirm defensive checks were not silently dropped.`
    );
  }
  if (stealthChanges.length > 0) {
    humanFocusPrompts.push(
      `Verify ${stealthChanges.length} unmentioned contract/security change(s) (${stealthChanges.map((s) => s.path).slice(0, 3).join(', ')}) not described in the PR summary.`
    );
  }
  if (reuseCandidates.length > 0) {
    humanFocusPrompts.push(
      `Check ${reuseCandidates.length} newly added helper(s) (${reuseCandidates.map((r) => `\`${r.name}\``).slice(0, 3).join(', ')}) that overlap existing symbols.`
    );
  }
  if (rotRiskShortcuts.length > 0) {
    humanFocusPrompts.push(
      `Review ${rotRiskShortcuts.length} unbounded deferral/shortcut comment(s) (${rotRiskShortcuts.map((s) => `${s.path}:${s.line}`).slice(0, 3).join(', ')}) missing a ceiling and upgrade trigger.`
    );
  }
  if (uncoveredClauses.length > 0) {
    humanFocusPrompts.push(
      `Verify ${uncoveredClauses.length} EARS/BDD acceptance clause(s) from the PR description that have no matching test in Layer 4.`
    );
  }

  return {
    removedGuards,
    addedSymbols,
    reuseCandidates,
    stealthChanges,
    shortcuts,
    specAlignment,
    humanFocusPrompts
  };
}

/**
 * Builds the 4-Layer `LAYERS` object (`contracts`, `flows`, `testMatrix`, `config`, `attentionSignals`)
 * from parsed diff files and cross-references findings by file path.
 */
function buildLayersFromParsedDiff(parsedFiles, issues = [], options = {}) {
  const findingsByFile = new Map();
  for (const issue of issues || []) {
    const file = String(issue.loc || '').replace(/:(\d+)(?:-(\d+))?$/, '').trim();
    if (!file) continue;
    if (!findingsByFile.has(file)) findingsByFile.set(file, []);
    findingsByFile.get(file).push(issue.id);
  }

  const findMatchingIds = (filePath) => {
    const direct = findingsByFile.get(filePath) || [];
    if (direct.length) return direct;
    const out = [];
    for (const [k, ids] of findingsByFile.entries()) {
      if (filePath.endsWith(k) || k.endsWith(filePath)) out.push(...ids);
    }
    return [...new Set(out)];
  };

  const codeownersRules =
    options.codeownersRules ||
    (options.codeownersText ? parseCodeowners(options.codeownersText) : []);
  const callerBlastMap = options.callerBlastRadius || options.callerBlastRadiusByPath || {};

  const contracts = [];
  const flowsMap = new Map();
  const testMatrix = [];
  const config = [];

  for (const f of parsedFiles || []) {
    const linkedFindings = findMatchingIds(f.path);
    if (f.layer === 'contracts') {
      const summary = `${f.category} (+${f.additions} / -${f.deletions})`;
      const owners = codeownersRules.length ? matchCodeowners(f.path, codeownersRules) : [];
      contracts.push({
        path: f.path,
        category: f.category,
        additions: f.additions,
        deletions: f.deletions,
        summary,
        diffSummary: summarizeContractDiff(f),
        removedGuards: f.removedGuards || [],
        owners,
        callerBlastRadius: callerBlastMap[f.path] || null,
        findings: linkedFindings,
        linkedFindings
      });
    } else if (f.layer === 'flows') {
      const flowName = f.category || inferFlowName(f.path);
      if (!flowsMap.has(flowName)) {
        flowsMap.set(flowName, {
          id: `flow-${flowsMap.size + 1}`,
          name: flowName,
          title: flowName,
          files: [],
          additions: 0,
          deletions: 0,
          removedGuardsCount: 0,
          findings: [],
          linkedFindings: [],
          summary: '',
          description: ''
        });
      }
      const group = flowsMap.get(flowName);
      group.files.push(f.path);
      group.additions += f.additions;
      group.deletions += f.deletions;
      group.removedGuardsCount += (f.removedGuards || []).length;
      for (const id of linkedFindings) {
        if (!group.findings.includes(id)) {
          group.findings.push(id);
          group.linkedFindings.push(id);
        }
      }
    } else if (f.layer === 'tests') {
      const cases = f.testMatrix || [];
      const internalMocks = f.internalMocks || [];
      const mappedCases = cases.map((c) => {
        const status = c.hollow
          ? 'hollow'
          : c.tautology
            ? 'tautology'
            : c.internalMock
              ? 'internal-mock'
              : c.mockOnly
                ? 'flawed-spec'
                : 'solid';
        const note = c.hollow
          ? 'Zero assertions detected in test body'
          : c.tautology
            ? 'Oracle tautology: asserts literal constant rather than computed behavior'
            : c.internalMock
              ? `Mocks internal relative seam (${(c.internalMockPaths || internalMocks).join(', ')})`
              : c.mockOnly
                ? `Mock-only assertions (${(c.verifiedTargets || []).join(', ') || 'spies'})`
                : c.truncated && c.assertions === 0
                  ? 'Partial diff hunk (assertions outside diff window)'
                  : (c.verifiedTargets || []).length
                    ? `Targets: ${c.verifiedTargets.join(', ')}`
                    : '';
        return {
          behavior: c.behavior,
          line: c.line,
          assertions: c.assertions,
          closed: Boolean(c.closed),
          truncated: Boolean(c.truncated),
          hollow: c.hollow,
          mockOnly: c.mockOnly,
          tautology: Boolean(c.tautology),
          internalMock: Boolean(c.internalMock),
          internalMockPaths: c.internalMockPaths || [],
          targets: c.verifiedTargets,
          status,
          note
        };
      });
      const assertionsCount = mappedCases.reduce((sum, c) => sum + (c.assertions || 0), 0);
      const hasHollow = mappedCases.some((c) => c.hollow || c.tautology);
      const hasMockOnly = mappedCases.some((c) => c.mockOnly || c.internalMock);
      const suiteStatus = hasHollow
        ? 'gap'
        : hasMockOnly || linkedFindings.length > 0
          ? 'warning'
          : 'solid';

      testMatrix.push({
        file: f.path,
        suite: cases[0]?.suite || inferSuiteFromPath(f.path),
        collapsedLines: f.additions + f.deletions,
        totalCases: mappedCases.length,
        assertionsCount,
        internalMocks,
        status: suiteStatus,
        findings: linkedFindings,
        linkedFindings,
        rawDiff: formatHunksAsRawDiff(f),
        cases: mappedCases,
        scenarios: mappedCases
      });
    } else {
      config.push({
        path: f.path,
        additions: f.additions,
        deletions: f.deletions
      });
    }
  }

  const flows = Array.from(flowsMap.values()).map((g) => {
    const desc = `${g.files.length} changed file(s) (+${g.additions} / -${g.deletions})`;
    return {
      ...g,
      summary: desc,
      description: desc
    };
  });

  const attentionSignals = analyzeAttentionSignals(parsedFiles, options);

  return { contracts, flows, testMatrix, config, attentionSignals };
}

function inferSuiteFromPath(filePath) {
  return String(filePath)
    .replace(/^.*\/test\/functions\//, '')
    .replace(/\.test\.[jt]sx?$/, '');
}

/**
 * Extracts a focused inline diff slice around `path:line` for a finding card.
 */
function extractDiffSlice(parsedFiles, loc, radius = 7) {
  if (!loc || !Array.isArray(parsedFiles)) return null;
  const match = /^([^:]+):(\d+)/.exec(String(loc).trim());
  if (!match) return null;
  const targetPath = match[1];
  const targetLine = Number(match[2]);

  const file = parsedFiles.find((f) => f.path === targetPath || f.path.endsWith(targetPath));
  if (!file || !file.hunks?.length) return null;

  for (const hunk of file.hunks) {
    const idx = hunk.lines.findIndex(
      (l) => l.newNumber === targetLine || l.oldNumber === targetLine
    );
    if (idx !== -1) {
      const start = Math.max(0, idx - radius);
      const end = Math.min(hunk.lines.length, idx + radius + 1);
      return {
        path: file.path,
        targetLine,
        hunkHeader: hunk.header,
        lines: hunk.lines.slice(start, end).map((l) => ({
          ...l,
          highlight: l.newNumber === targetLine || l.oldNumber === targetLine
        }))
      };
    }
  }

  // Fallback: return first hunk if exact line isn't in hunk
  const firstHunk = file.hunks[0];
  return {
    path: file.path,
    targetLine,
    hunkHeader: firstHunk.header,
    lines: firstHunk.lines.slice(0, radius * 2).map((l) => ({
      ...l,
      highlight: l.newNumber === targetLine
    }))
  };
}

/**
 * Synthesizes a valid unified git diff string (`diff --git a/... b/...`) from GitHub's
 * `/repos/{owner}/{repo}/pulls/{pr}/files` entries and/or `gh pr view --json files` metadata.
 * Used when `gh pr diff` fails with HTTP 406 (`PullRequest.diff too_large` > 20,000 lines).
 */
function synthesizeUnifiedDiffFromFiles(apiFiles = [], prMetaFiles = []) {
  const seenPaths = new Set();
  const chunks = [];

  for (const f of apiFiles || []) {
    if (!f) continue;
    const newPath = f.filename || f.path;
    if (!newPath) continue;
    seenPaths.add(newPath);
    const oldPath = f.previous_filename || newPath;
    const status = f.status || 'modified';
    const additions = Number(f.additions || 0);
    const deletions = Number(f.deletions || 0);

    const headerLines = [
      `diff --git a/${oldPath} b/${newPath}`,
      `# crv-file-stats: additions=${additions} deletions=${deletions} status=${status}`,
      `--- ${status === 'added' ? '/dev/null' : `a/${oldPath}`}`,
      `+++ ${status === 'removed' ? '/dev/null' : `b/${newPath}`}`
    ];

    if (typeof f.patch === 'string' && f.patch.trim()) {
      headerLines.push(f.patch.replace(/\r?\n$/, ''));
    } else {
      headerLines.push('# patch omitted by GitHub API for large or binary file');
    }
    chunks.push(headerLines.join('\n'));
  }

  for (const mf of prMetaFiles || []) {
    if (!mf) continue;
    const filePath = mf.path || mf.filename;
    if (!filePath || seenPaths.has(filePath)) continue;
    seenPaths.add(filePath);
    const additions = Number(mf.additions || 0);
    const deletions = Number(mf.deletions || 0);
    chunks.push(
      [
        `diff --git a/${filePath} b/${filePath}`,
        `# crv-file-stats: additions=${additions} deletions=${deletions} status=modified`,
        `--- a/${filePath}`,
        `+++ b/${filePath}`,
        '# patch omitted by GitHub API for large or binary file'
      ].join('\n')
    );
  }

  return chunks.length ? chunks.join('\n') + '\n' : '';
}

function hasLocalGitCommit(oid, cwd, spawnSyncFn = defaultSpawnSync) {
  if (!oid) return false;
  const res = spawnSyncFn('git', ['cat-file', '-e', `${oid}^{commit}`], {
    cwd,
    encoding: 'utf8',
    timeout: 5000
  });
  return res && res.status === 0;
}

function findMatchingGitRemote(targetRepo, cwd, spawnSyncFn = defaultSpawnSync) {
  if (!targetRepo) return null;
  const res = spawnSyncFn('git', ['remote', '-v'], {
    cwd,
    encoding: 'utf8',
    timeout: 5000
  });
  if (!res || res.status !== 0 || !res.stdout) return null;
  const normTarget = String(targetRepo).trim().toLowerCase();
  const lines = res.stdout.split(/\r?\n/);
  for (const line of lines) {
    const m = /^(\S+)\s+(\S+)/.exec(line.trim());
    if (!m) continue;
    const remoteName = m[1];
    const slug = parseGitHubRepoSlug(m[2]);
    if (slug && slug.toLowerCase() === normTarget) {
      return remoteName;
    }
  }
  return null;
}

/**
 * Attempts to compute the full unified PR diff locally via `git diff <baseRefOid>...<headRefOid>`,
 * fetching missing PR commits if the current directory is a clone of `repo`.
 * Bypasses GitHub's 20,000-line REST diff limit completely when inside the local repo.
 */
function tryLocalGitDiff({
  repo,
  pr,
  baseRefOid,
  headRefOid,
  baseRefName,
  cwd = process.cwd(),
  spawnSyncFn = defaultSpawnSync
} = {}) {
  if (!baseRefOid || !headRefOid) return null;

  const insideRes = spawnSyncFn('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd,
    encoding: 'utf8',
    timeout: 5000
  });
  if (!insideRes || insideRes.status !== 0) return null;

  let hasBase = hasLocalGitCommit(baseRefOid, cwd, spawnSyncFn);
  let hasHead = hasLocalGitCommit(headRefOid, cwd, spawnSyncFn);

  if (!hasBase || !hasHead) {
    const remote = findMatchingGitRemote(repo, cwd, spawnSyncFn);
    if (remote) {
      if (pr) {
        spawnSyncFn('git', ['fetch', '--no-tags', remote, baseRefOid, `pull/${pr}/head`], {
          cwd,
          encoding: 'utf8',
          timeout: 45000
        });
      }
      hasBase = hasLocalGitCommit(baseRefOid, cwd, spawnSyncFn);
      hasHead = hasLocalGitCommit(headRefOid, cwd, spawnSyncFn);

      if (!hasHead && pr) {
        spawnSyncFn('git', ['fetch', '--no-tags', remote, `pull/${pr}/head`], {
          cwd,
          encoding: 'utf8',
          timeout: 45000
        });
        hasHead = hasLocalGitCommit(headRefOid, cwd, spawnSyncFn);
      }
      if (!hasBase && baseRefName) {
        spawnSyncFn('git', ['fetch', '--no-tags', remote, baseRefName], {
          cwd,
          encoding: 'utf8',
          timeout: 45000
        });
        hasBase = hasLocalGitCommit(baseRefOid, cwd, spawnSyncFn);
      }
    }
  }

  if (!hasBase || !hasHead) return null;

  const maxBuffer = 100 * 1024 * 1024;
  let diffRes = spawnSyncFn(
    'git',
    ['diff', '--no-color', '--no-ext-diff', `${baseRefOid}...${headRefOid}`],
    { cwd, encoding: 'utf8', maxBuffer }
  );
  if (!diffRes || diffRes.status !== 0) {
    diffRes = spawnSyncFn(
      'git',
      ['diff', '--no-color', '--no-ext-diff', baseRefOid, headRefOid],
      { cwd, encoding: 'utf8', maxBuffer }
    );
  }
  if (diffRes && diffRes.status === 0 && typeof diffRes.stdout === 'string') {
    return diffRes.stdout;
  }
  return null;
}

/**
 * Fetches a PR's unified diff with automatic multi-tier fallback when `gh pr diff` fails
 * (e.g. HTTP 406 `PullRequest.diff too_large` when a PR exceeds 20,000 lines):
 * 1. `gh pr diff <pr> [--repo <repo>]`
 * 2. Local git repository `git diff <baseRefOid>...<headRefOid>` (fetching refs if in matching repo)
 * 3. `gh api repos/<repo>/pulls/<pr>/files?per_page=100 --paginate --slurp` + per-file patch synthesis
 * 4. `prMeta.files` file-stats synthesis
 */
function fetchPrDiffWithFallback({
  pr,
  repo,
  repoArgs = [],
  prMeta = null,
  cwd = process.cwd(),
  onFallback = null,
  spawnSyncFn = defaultSpawnSync
} = {}) {
  const maxBuffer = 100 * 1024 * 1024;
  const effectiveRepoArgs =
    repoArgs.length > 0 ? repoArgs : repo && !/^https?:\/\//i.test(String(pr)) ? ['--repo', repo] : [];

  const diffRes = spawnSyncFn('gh', ['pr', 'diff', String(pr), ...effectiveRepoArgs], {
    cwd,
    encoding: 'utf8',
    maxBuffer
  });
  if (diffRes && diffRes.status === 0) {
    return { diffText: diffRes.stdout || '', source: 'gh-pr-diff' };
  }

  const ghDiffErr = ((diffRes && (diffRes.stderr || diffRes.stdout)) || `gh pr diff ${pr} failed`).trim();
  if (typeof onFallback === 'function') {
    onFallback(ghDiffErr);
  }

  const urlMatch = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i.exec(
    (prMeta && prMeta.url) || String(pr || '')
  );
  const resolvedRepo = (urlMatch && urlMatch[1]) || repo || null;
  const resolvedPr = (prMeta && prMeta.number) || (urlMatch && urlMatch[2]) || String(pr).replace(/^#/, '');

  // Fallback 1: Local git repository diff (no line limit)
  const localDiff = tryLocalGitDiff({
    repo: resolvedRepo,
    pr: resolvedPr,
    baseRefOid: prMeta && prMeta.baseRefOid,
    headRefOid: prMeta && prMeta.headRefOid,
    baseRefName: prMeta && prMeta.baseRefName,
    cwd,
    spawnSyncFn
  });
  if (localDiff !== null && localDiff.trim()) {
    return { diffText: localDiff, source: 'local-git-diff' };
  }

  // Fallback 2: GitHub Pull Request Files API (`repos/{owner}/{repo}/pulls/{pr}/files`)
  if (resolvedRepo && resolvedPr) {
    const filesApiRes = spawnSyncFn(
      'gh',
      ['api', `repos/${resolvedRepo}/pulls/${resolvedPr}/files?per_page=100`, '--paginate', '--slurp'],
      { cwd, encoding: 'utf8', maxBuffer }
    );
    if (filesApiRes && filesApiRes.status === 0 && (filesApiRes.stdout || '').trim()) {
      try {
        const apiFiles = parsePaginatedGhJson(filesApiRes.stdout);
        const synthesized = synthesizeUnifiedDiffFromFiles(apiFiles, (prMeta && prMeta.files) || []);
        if (synthesized.trim() || apiFiles.length === 0) {
          return { diffText: synthesized, source: 'gh-pr-files-api' };
        }
      } catch (e) {}
    }
  }

  // Fallback 3: `prMeta.files` from `gh pr view --json files`
  if (prMeta && Array.isArray(prMeta.files) && prMeta.files.length > 0) {
    const synthesized = synthesizeUnifiedDiffFromFiles([], prMeta.files);
    return { diffText: synthesized, source: 'pr-meta-files' };
  }

  throw new Error(ghDiffErr);
}

module.exports = {
  classifyFilePath,
  inferFlowName,
  parseUnifiedDiff,
  extractRemovedGuardsFromHunks,
  extractAddedSymbolsFromHunks,
  extractShortcutsFromHunks,
  parseCodeowners,
  matchCodeowners,
  analyzeSpecAlignment,
  extractInternalMocksFromHunks,
  extractTestCasesFromHunks,
  analyzeAttentionSignals,
  buildLayersFromParsedDiff,
  extractDiffSlice,
  synthesizeUnifiedDiffFromFiles,
  tryLocalGitDiff,
  fetchPrDiffWithFallback
};
