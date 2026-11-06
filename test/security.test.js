'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const core = require('../packages/core');
const { sanitizeHtml, sanitizeReport } = require('../packages/ui/sanitize.js');
const {
  loadReportFile,
  buildStandaloneHtml,
  createWorkbenchServer,
  isAllowedHostHeader,
  validateReviewPayload,
  parsePrTargetInput,
  buildCsp
} = require('../packages/cli/server');

const FIXTURE = path.join(__dirname, '../fixtures/pr1230-report.json');

/* ---------- (1) agent runner ---------- */

test('headless claude is restricted to read-only tools + scratch writes (no bare Bash)', () => {
  const args = core.KNOWN_AGENTS.claude.buildHeadlessArgs('p', '/skill', { scratchDir: '/work/.crv-skills/crv-code-review/7' });
  const tools = args[args.indexOf('--allowedTools') + 1].split(',');
  assert.ok(!tools.includes('Bash'), 'bare Bash must not be allowed');
  assert.ok(!tools.includes('Write') && !tools.includes('Edit'), 'unscoped Write/Edit must not be allowed');
  assert.ok(tools.includes('Read') && tools.includes('Grep') && tools.includes('Glob'));
  assert.ok(tools.includes('Write(//work/.crv-skills/crv-code-review/7/**)'));
  assert.ok(tools.includes('Bash(git show:*)'));
});

test('headless mode for agents that cannot restrict tools requires an explicit opt-in', () => {
  const prev = process.env.CRV_ALLOW_UNRESTRICTED_HEADLESS;
  delete process.env.CRV_ALLOW_UNRESTRICTED_HEADLESS;
  try {
    for (const id of ['agy', 'gemini', 'codex']) {
      assert.throws(() => core.KNOWN_AGENTS[id].buildHeadlessArgs('p', '/skill', {}), /cannot be restricted/);
    }
    assert.doesNotThrow(() => core.KNOWN_AGENTS.agy.buildHeadlessArgs('p', '/skill', { allowUnrestricted: true }));
    process.env.CRV_ALLOW_UNRESTRICTED_HEADLESS = '1';
    assert.doesNotThrow(() => core.KNOWN_AGENTS.codex.buildHeadlessArgs('p', '/skill', {}));
  } finally {
    if (prev === undefined) delete process.env.CRV_ALLOW_UNRESTRICTED_HEADLESS;
    else process.env.CRV_ALLOW_UNRESTRICTED_HEADLESS = prev;
  }
});

test('model / effort values are validated before reaching argv', () => {
  assert.equal(core.isValidModelName('claude-opus-4-6'), true);
  assert.equal(core.isValidModelName('--dangerously-skip-permissions'), false);
  assert.equal(core.isValidModelName('a b'), false);
  assert.equal(core.isValidEffort('high'), true);
  assert.equal(core.isValidEffort('ludicrous'), false);
  assert.throws(() => core.KNOWN_AGENTS.claude.buildInteractiveArgs('p', '/s', { model: '--evil' }), /Invalid model/);
  assert.throws(() => core.saveDefaultAgentConfig('claude', { model: '-x', cwd: os.tmpdir() }), /Invalid model/);
  const resolved = core.resolveAgentConfig({ env: { CRV_MODEL: '--evil', CRV_EFFORT: 'bogus' }, cwd: os.tmpdir() });
  assert.equal(resolved.model, null);
  assert.equal(resolved.effort, null);
  assert.equal(resolved.ignoredInvalid.length, 2);
});

/* ---------- (2) marker authenticity ---------- */

function findingComment(id, action, login, extra = {}) {
  const body = core.serializeFindingComment(
    { id, sev: 'high', title: 'Real bug', loc: 'a.ts:3', impact: '<p>x</p>' },
    { action },
    { head: 'abcdef1234', pr: 9 }
  );
  return { id: Math.floor(Math.random() * 1e6), path: 'a.ts', line: 3, body, user: { login }, ...extra };
}

test('crv markers are honoured only from trusted authors (deny-by-default)', () => {
  const forged = findingComment('H1', 'dismiss', 'attacker');
  const real = findingComment('H2', 'block', 'Reviewer');
  const none = core.hydrateFromGitHubComments([], [forged, real]);
  assert.deepEqual(Object.keys(none.findingThreads), []);

  const h = core.hydrateFromGitHubComments([], [forged, real], { trustedAuthors: ['reviewer'] });
  assert.deepEqual(Object.keys(h.findingThreads), ['H2']);
  assert.equal(h.untrustedMarkers.length, 1);
  assert.equal(h.untrustedMarkers[0].author, 'attacker');
  assert.equal(h.generalComments.length, 1); // forged marker is shown as a plain comment only
});

test('forged crv-meta overview from an untrusted author is ignored; newest trusted one wins', () => {
  const report = loadReportFile(FIXTURE);
  const mk = (login, updated, id) => ({
    id,
    body: core.serializeOverviewComment(report, { H1: { action: 'block' } }, ''),
    user: { login },
    updated_at: updated
  });
  const h = core.hydrateFromGitHubComments(
    [mk('trusted', '2026-01-01T00:00:00Z', 1), mk('trusted', '2026-02-01T00:00:00Z', 2), mk('evil', '2026-03-01T00:00:00Z', 3)],
    [],
    { trustedAuthors: ['trusted'] }
  );
  assert.equal(h.overviewMeta.commentId, 2);
  assert.equal(h.untrustedMarkers.length, 1);
});

test('marker metadata is whitelisted: injected HTML fields are dropped, enums validated', () => {
  const body = '<!-- crv-finding: {"id":"H1","sev":"nope","action":"approve","impact":"<img src=x onerror=alert(1)>","title":"t","head":"zz"} -->';
  const parsed = core.parseFindingComment(body);
  assert.equal(parsed.meta.impact, undefined);
  assert.equal(parsed.meta.sev, 'medium');
  assert.equal(parsed.meta.action, 'comment');
  assert.equal(parsed.meta.head, '');
  assert.equal(core.parseFindingComment('<!-- crv-finding: {"id":"../../x"} -->'), null);
});

test('stale markers (recorded against another head) are flagged', () => {
  const c = findingComment('H1', 'comment', 'reviewer');
  const fresh = core.hydrateFromGitHubComments([], [c], { trustedAuthors: ['reviewer'], currentHead: 'abcdef1234ffff' });
  assert.equal(fresh.findingThreads.H1.stale, false);
  const stale = core.hydrateFromGitHubComments([], [c], { trustedAuthors: ['reviewer'], currentHead: '999999999' });
  assert.equal(stale.findingThreads.H1.stale, true);
});

test('trusted author list: gh user + env + bots, never the checkout-local config', () => {
  const t = core.resolveTrustedAuthors({ ghLogin: 'Alice', env: { CRV_TRUSTED_REVIEWERS: 'bob, carol' }, homeDir: os.tmpdir() });
  for (const l of ['alice', 'bob', 'carol', 'github-actions[bot]']) assert.ok(t.logins.includes(l), l);
  assert.ok(!core.resolveTrustedAuthors({ env: { CRV_TRUSTED_REVIEWERS: '$(rm -rf),x y' }, homeDir: os.tmpdir() }).logins.includes('$(rm -rf)'));
});

/* ---------- (3)(4) HTML sinks, no code execution ---------- */

test('sanitizeHtml keeps the compiler subset and neutralises script/handlers/js: URLs', () => {
  assert.equal(sanitizeHtml('<p>a <strong>b</strong> <code>c</code></p>'), '<p>a <strong>b</strong> <code>c</code></p>');
  const evil = sanitizeHtml('<p onclick="x()">hi</p><script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">l</a><a href="&#106;avascript:alert(1)">l2</a><!-- c -->');
  assert.doesNotMatch(evil, /<(script|img)\b|<[^>]*\bon\w+\s*=|href="[^"]*javascript|<!--/i);
  assert.match(evil, /<p>hi<\/p>/);
  assert.equal(sanitizeHtml('<a href="https://example.com/x?a=1&b=2" style="x">ok</a>'), '<a href="https://example.com/x?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">ok</a>');
  assert.equal(sanitizeHtml('<div class="diaslot"><div class="mermaid">flowchart LR\n A--&gt;B</div></div>'), '<div class="diaslot"><div class="mermaid">flowchart LR\n A--&gt;B</div></div>');
  assert.doesNotMatch(sanitizeHtml('<div class="x" id=y style=z>'), /id=|style=/);
});

test('loadReportFile sanitises pre-compiled reports and refuses to execute legacy HTML reports', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crv-t-'));
  const report = loadReportFile(FIXTURE);
  report.DATA[0].impact = '<p>ok</p><img src=x onerror=alert(1)><script>alert(2)</script>';
  fs.writeFileSync(path.join(dir, 'r.json'), JSON.stringify(report));
  const loaded = loadReportFile(path.join(dir, 'r.json'));
  assert.doesNotMatch(loaded.DATA[0].impact, /<(script|img)\b|<[^>]*\bon\w+\s*=/i);

  const marker = path.join(dir, 'pwned');
  const legacy = `const DATA=[1];\nglobalThis.process.mainModule; require('fs').writeFileSync(${JSON.stringify(marker)},'x');\n`;
  fs.writeFileSync(path.join(dir, 'legacy.html'), legacy);
  assert.throws(() => loadReportFile(path.join(dir, 'legacy.html')), /Unsupported report file/);
  assert.equal(fs.existsSync(marker), false);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../packages/cli/server.js'), 'utf8'), /require\('vm'\)|runInNewContext/);
});

test('standalone export round-trips and carries a hash-based CSP with no unsafe-inline scripts', () => {
  const report = loadReportFile(FIXTURE);
  const html = buildStandaloneHtml(report);
  const csp = /Content-Security-Policy" content="([^"]*)"/.exec(html)[1];
  const scriptSrc = /script-src ([^;]*)/.exec(csp)[1];
  assert.match(scriptSrc, /'sha256-[A-Za-z0-9+/=]+'/);
  assert.doesNotMatch(scriptSrc, /unsafe-inline|unsafe-eval/);
  assert.match(csp, /default-src 'none'/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crv-t-'));
  fs.writeFileSync(path.join(dir, 'out.html'), html);
  assert.equal(loadReportFile(path.join(dir, 'out.html')).REVIEW.pr, 1230);
  assert.match(buildCsp(), /script-src 'self'/);
});

test('UI source: mermaid is strict and every HTML field goes through the sanitiser', () => {
  const ui = fs.readFileSync(path.join(__dirname, '../packages/ui/workbench.js'), 'utf8');
  assert.match(ui, /securityLevel: 'strict'/);
  assert.doesNotMatch(ui, /\$\{d\.(impact|fix|reasoning)(\s*\|\|\s*'')?\}/);
  assert.match(fs.readFileSync(path.join(__dirname, '../packages/ui/index.html'), 'utf8'), /Content-Security-Policy/);
});

/* ---------- (5) server hardening ---------- */

function makeInvoker(server) {
  return ({ method = 'GET', url = '/', headers = {}, body = null, host = '127.0.0.1:4320' }) =>
    new Promise((resolve, reject) => {
      const req = new PassThrough();
      Object.assign(req, { method, url, headers: { host, ...headers } });
      const res = new PassThrough();
      res.headers = {};
      res.setHeader = (k, v) => (res.headers[k.toLowerCase()] = v);
      res.writeHead = (code, h = {}) => {
        res.statusCode = code;
        res.headers = { ...res.headers, ...Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v])) };
        return res;
      };
      const chunks = [];
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('finish', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) });
      });
      res.on('error', reject);
      server.emit('request', req, res);
      if (body !== null) req.write(body);
      req.end();
    });
}

test('Host header validation blocks DNS rebinding; token required on every non-health API route', async () => {
  const report = loadReportFile(FIXTURE);
  const { server, sessionToken } = createWorkbenchServer({ report, lastSubmittedPath: path.join(os.tmpdir(), `crv-${Date.now()}.json`) });
  const call = makeInvoker(server);
  assert.equal(isAllowedHostHeader('127.0.0.1:4320', 4320), true);
  assert.equal(isAllowedHostHeader('localhost:4320', 4320), true);
  assert.equal(isAllowedHostHeader('attacker.example.com:4320', 4320), false);
  assert.equal(isAllowedHostHeader('127.0.0.1.attacker.example.com', 4320), false);
  assert.equal(isAllowedHostHeader('127.0.0.1:9999', 4320), false);

  assert.equal((await call({ url: '/api/report', host: 'attacker.example.com:4320', headers: { 'x-crv-token': sessionToken } })).status, 421);
  assert.equal((await call({ url: '/api/health', host: 'attacker.example.com' })).status, 421);
  assert.equal((await call({ url: '/api/health' })).status, 200);
  for (const route of ['/api/report', '/api/events', '/api/github/list-prs', '/api/github/repo-config', '/api/github/agent-config']) {
    assert.equal((await call({ url: route })).status, 401, route);
    assert.equal((await call({ url: route, headers: { 'x-crv-token': 'wrong' } })).status, 401, route);
  }
  const post = await call({ method: 'POST', url: '/api/github/repo-config', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(post.status, 401);
  assert.equal((await call({ url: '/api/report', headers: { 'x-crv-token': sessionToken } })).status, 200);
  assert.equal((await call({ url: `/api/report?token=${sessionToken}` })).status, 200);
});

test('served index.html carries the session token + CSP header; /api/session only for pinned extension ids', async () => {
  const report = loadReportFile(FIXTURE);
  const extId = 'abcdefghijklmnopabcdefghijklmnop';
  const { server, sessionToken } = createWorkbenchServer({ report, extensionIds: [extId] });
  const call = makeInvoker(server);
  const index = await call({ url: '/' });
  assert.match(index.text, new RegExp(`name="crv-session-token" content="${sessionToken}"`));
  assert.match(index.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(index.headers['x-content-type-options'], 'nosniff');

  const ok = await call({ url: '/api/session', headers: { origin: `chrome-extension://${extId}` } });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).token, sessionToken);
  assert.equal((await call({ url: '/api/session', headers: { origin: 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } })).status, 403);
  assert.equal((await call({ url: '/api/session' })).status, 403);
  assert.equal((await call({ url: '/api/session', headers: { origin: 'http://localhost:9999' } })).status, 403);
});

test('submit-review is bound to the active report, whitelists events and sanitises the payload', async () => {
  const report = loadReportFile(FIXTURE);
  const savePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crv-t-')), 's.json');
  const { server, sessionToken } = createWorkbenchServer({ report, lastSubmittedPath: savePath });
  const call = makeInvoker(server);
  const submit = (repo, pr, payload) =>
    call({
      method: 'POST',
      url: '/api/github/submit-review',
      headers: { 'x-crv-token': sessionToken, 'content-type': 'application/json' },
      body: JSON.stringify({ repo, pr, payload })
    });

  assert.equal((await submit('other/repo', 1230, { event: 'COMMENT' })).status, 409);
  assert.equal((await submit('acme/loyalty-platform', 1, { event: 'COMMENT' })).status, 409);
  assert.equal((await submit('acme/loyalty-platform', 1230, { event: 'APPROVE' })).status, 400);
  assert.equal((await submit('acme/loyalty-platform', 1230, { event: 'DISMISS' })).status, 400);
  assert.equal((await submit('acme/loyalty-platform', 1230, { event: 'COMMENT', comments: [{ path: 'a', line: 0, body: 'x' }] })).status, 400);
  const ok = await submit('acme/loyalty-platform', 1230, { event: 'COMMENT', body: 'hi', evil: 'x', comments: [{ path: 'a.ts', line: 2, body: 'c', position: 9 }] });
  assert.equal(ok.status, 200);
  const saved = JSON.parse(fs.readFileSync(savePath, 'utf8'));
  assert.deepEqual(Object.keys(saved.payload).sort(), ['body', 'comments', 'event']);
  assert.deepEqual(Object.keys(saved.payload.comments[0]).sort(), ['body', 'line', 'path', 'side']);

  assert.doesNotThrow(() => validateReviewPayload({ event: 'APPROVE' }, { allowApprove: true }));
});

test('default last-submitted file lives in a private mkdtemp dir with 0600 permissions', async () => {
  const report = loadReportFile(FIXTURE);
  const { server, sessionToken } = createWorkbenchServer({ report });
  const call = makeInvoker(server);
  const res = await call({
    method: 'POST',
    url: '/api/github/submit-review',
    headers: { 'x-crv-token': sessionToken, 'content-type': 'application/json' },
    body: JSON.stringify({ repo: 'acme/loyalty-platform', pr: 1230, payload: { event: 'COMMENT' } })
  });
  const { savedTo } = await res.json();
  assert.notEqual(savedTo, path.join(os.tmpdir(), 'crv-last-submitted-review.json'));
  assert.equal(fs.statSync(savedTo).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(savedTo)).mode & 0o777, 0o700);
});

test('strict owner/repo + PR number validation', () => {
  for (const ok of ['acme/repo', 'a.b/c_d-e']) assert.equal(core.isValidRepoSlug(ok), true, ok);
  for (const bad of ['a/b/c', '../x', 'a/..', 'a b/c', 'a/b;rm', '/x', 'x/', '..//..', 'a/b#1']) assert.equal(core.isValidRepoSlug(bad), false, bad);
  assert.equal(core.parsePrNumber('12'), 12);
  assert.equal(core.parsePrNumber('0'), null);
  assert.equal(core.parsePrNumber('1e3'), null);
  assert.deepEqual(parsePrTargetInput('acme/repo#5'), { repo: 'acme/repo', prNumInt: 5 });
  assert.deepEqual(parsePrTargetInput('https://github.com/acme/repo/pull/7'), { repo: 'acme/repo', prNumInt: 7 });
  assert.throws(() => parsePrTargetInput('evil/../../user/orgs#1', null), /Invalid|No GitHub repository/);
  assert.throws(() => parsePrTargetInput('12abc', 'acme/repo'), /Invalid PR/);
  assert.equal(core.parseGitHubRepoSlug('https://github.com/../x'), null);
});

/* ---------- (6) review payload ---------- */

test('findings without path:line fall back to the review body; table cells and titles are escaped', () => {
  const report = {
    REVIEW: { repo: 'a/b', pr: 1, head: 'abcdef1234' },
    PR: { label: 'a/b#1' },
    SUMMARY: { html: '<p>s</p>' },
    DATA: [
      { id: 'H1', sev: 'high', title: 'Pipe | in\ntitle --> <b>', loc: 'a.ts:4' },
      { id: 'M1', sev: 'medium', title: 'No location', loc: '' },
      { id: 'M2', sev: 'medium', title: 'Dir only', loc: 'src/' }
    ]
  };
  const triage = { H1: { action: 'block', note: 'n --> x' }, M1: { action: 'comment' }, M2: { action: 'comment' } };
  const payload = core.buildGitHubReviewPayload(report, triage);
  assert.equal(payload.comments.length, 1);
  assert.match(payload.body, /Findings without an inline location/);
  assert.match(payload.body, /No location/);
  assert.match(payload.body, /Dir only/);
  assert.match(payload.body, /Pipe \\\| in title/);
  // marker JSON can never terminate the HTML comment early
  const marker = /<!-- crv-meta: ([\s\S]*?) -->/.exec(payload.body)[1];
  assert.doesNotMatch(marker, /-->/);
  assert.equal(JSON.parse(marker).triage.H1.note, 'n --> x');
  const inlineMarker = /<!-- crv-finding: ([\s\S]*?) -->/.exec(payload.comments[0].body)[1];
  assert.equal(JSON.parse(inlineMarker).title, 'Pipe | in\ntitle --> <b>');
  assert.equal(core.parseFindingComment(payload.comments[0].body).meta.id, 'H1');
});

test('overview comment stays under the GitHub size limit and its marker stays parseable', () => {
  const DATA = [];
  const triage = {};
  for (let i = 0; i < 400; i++) {
    DATA.push({ id: `F${i}`, sev: 'low', title: `Finding ${i} ${'x'.repeat(200)}`, loc: `f${i}.ts:1` });
    triage[`F${i}`] = { action: 'comment', note: 'n'.repeat(1500) };
  }
  const body = core.serializeOverviewComment({ REVIEW: { repo: 'a/b', pr: 2, head: 'abcdef1234' }, PR: {}, SUMMARY: { html: '<p>' + 'y'.repeat(30000) + '</p>' }, DATA }, triage, '');
  assert.ok(body.length <= 65536, `body ${body.length}`);
  assert.equal(core.parseOverviewComment(body).pr, 2);
  assert.ok(core.capComment('z'.repeat(70000)).length <= 60000);
});

test('foldCommentsIntoBody moves inline comments into the body for the 422 fallback', () => {
  const folded = core.foldCommentsIntoBody({ event: 'COMMENT', body: 'b', commit_id: 'abcdef1', comments: [{ path: 'a<b>.ts', line: 3, side: 'RIGHT', body: 'finding' }] });
  assert.deepEqual(folded.comments, []);
  assert.match(folded.body, /finding/);
  assert.match(folded.body, /a&lt;b&gt;\.ts:3/);
  assert.equal(folded.commit_id, 'abcdef1');
});

/* ---------- (7) repo hygiene ---------- */

test('no leftover "13-lens" wording and no .tu-skills lookups in shipped code', () => {
  const root = path.join(__dirname, '..');
  const files = ['README.md', 'packages/cli/server.js', 'packages/cli/bin/crv.js', 'packages/ui/index.html', 'packages/extension/sidepanel/sidepanel.html'];
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    assert.doesNotMatch(text, /13[- ]lens/i, f);
    assert.doesNotMatch(text, /\.tu-skills/, f);
  }
  const lensCount = fs.readdirSync(path.join(root, '.agents/skills/crv-code-review/lenses')).length;
  assert.equal(lensCount, 14);
});
