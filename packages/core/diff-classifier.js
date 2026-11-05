'use strict';

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
  /models\.ts$/i,
  /member-status\.ts$/i,
  /feature-flag/i,
  /firestore\.rules$/i,
  /\.graphql$/i,
  /\.proto$/i,
  /^docs\/design\//i,
  /adr-\d+/i
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

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
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

    const fileEntry = {
      path: filePath,
      ...classification,
      additions,
      deletions,
      hunks
    };

    if (classification.layer === 'tests') {
      fileEntry.testMatrix = extractTestCasesFromHunks(filePath, hunks);
    }

    files.push(fileEntry);
  }

  return files;
}

/**
 * Extracts a Behavioral Test Matrix from test file diff hunks:
 * finds `describe(...)`, `it(...)`, `test(...)` blocks and counts `expect(...)` / `assert` calls
 * so humans can immediately see *what behaviors are tested* and *whether assertions exist*.
 */
function extractTestCasesFromHunks(filePath, hunks) {
  const cases = [];
  let currentSuite = '';
  let currentCase = null;

  for (const hunk of hunks) {
    for (const l of hunk.lines) {
      if (l.type === 'del') continue;
      const text = l.content;

      const descMatch = /\bdescribe\s*\(\s*(['"`])([\s\S]*?)\1/.exec(text);
      if (descMatch) {
        currentSuite = descMatch[2];
      }

      const itMatch = /\b(?:it|test)\s*\(\s*(['"`])([\s\S]*?)\1/.exec(text);
      if (itMatch) {
        if (currentCase) cases.push(currentCase);
        currentCase = {
          suite: currentSuite || inferSuiteFromPath(filePath),
          behavior: itMatch[2],
          line: l.newNumber,
          assertions: 0,
          verifiedTargets: []
        };
      }

      if (currentCase) {
        const expectMatches = text.match(/\b(?:expect|assert)\s*\(/g);
        if (expectMatches) {
          currentCase.assertions += expectMatches.length;
        }
        if (/\btoHaveBeenCalled|\btoHaveBeenCalledWith/.test(text)) {
          currentCase.mockAssertions = (currentCase.mockAssertions || 0) + 1;
        }
        const targetMatch = /\b(?:expect|assert)\s*\(\s*([a-zA-Z0-9_.]+)\s*\)/.exec(text);
        if (targetMatch && !currentCase.verifiedTargets.includes(targetMatch[1])) {
          currentCase.verifiedTargets.push(targetMatch[1]);
        }
      }
    }
  }
  if (currentCase) cases.push(currentCase);
  return cases.map((c) => ({
    ...c,
    hollow: c.assertions === 0,
    mockOnly: c.assertions > 0 && c.mockAssertions === c.assertions
  }));
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
 * Builds the 4-Layer `LAYERS` object (`contracts`, `flows`, `testMatrix`, `config`)
 * from parsed diff files and cross-references findings by file path.
 */
function buildLayersFromParsedDiff(parsedFiles, issues = []) {
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

  const contracts = [];
  const flowsMap = new Map();
  const testMatrix = [];
  const config = [];

  for (const f of parsedFiles || []) {
    const linkedFindings = findMatchingIds(f.path);
    if (f.layer === 'contracts') {
      const summary = `${f.category} (+${f.additions} / -${f.deletions})`;
      contracts.push({
        path: f.path,
        category: f.category,
        additions: f.additions,
        deletions: f.deletions,
        summary,
        diffSummary: summarizeContractDiff(f),
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
      for (const id of linkedFindings) {
        if (!group.findings.includes(id)) {
          group.findings.push(id);
          group.linkedFindings.push(id);
        }
      }
    } else if (f.layer === 'tests') {
      const cases = f.testMatrix || [];
      const mappedCases = cases.map((c) => {
        const status = c.hollow ? 'hollow' : c.mockOnly ? 'flawed-spec' : 'solid';
        const note = c.hollow
          ? 'Zero assertions detected in test body'
          : c.mockOnly
            ? `Mock-only assertions (${(c.verifiedTargets || []).join(', ') || 'spies'})`
            : (c.verifiedTargets || []).length
              ? `Targets: ${c.verifiedTargets.join(', ')}`
              : '';
        return {
          behavior: c.behavior,
          assertions: c.assertions,
          hollow: c.hollow,
          mockOnly: c.mockOnly,
          targets: c.verifiedTargets,
          status,
          note
        };
      });
      const assertionsCount = mappedCases.reduce((sum, c) => sum + (c.assertions || 0), 0);
      const hasHollow = mappedCases.some((c) => c.hollow);
      const hasMockOnly = mappedCases.some((c) => c.mockOnly);
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

  return { contracts, flows, testMatrix, config };
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

module.exports = {
  classifyFilePath,
  inferFlowName,
  parseUnifiedDiff,
  extractTestCasesFromHunks,
  buildLayersFromParsedDiff,
  extractDiffSlice
};
