'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('../packages/core');
const { runCiCommand } = require('../packages/cli/ci');

const agy = core.KNOWN_AGENTS.agy;
const CLEAN_ENV = {}; // explicit env so tests never depend on the developer's shell

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crv-agy-'));
const flagValue = (args, flag) => args[args.indexOf(flag) + 1];

const GOOD_FINDINGS = {
  meta: { title: 'PR #11: example', summary: 'Two findings.' },
  issues: [
    { id: 'M1', sev: 'medium', verify: 'CONFIRMED', cat: 'correctness', loc: 'src/a.js:10', title: 'Wrong default', impact: '**Breaks:** x', fix: '**Do:** y' },
    { id: 'L1', sev: 'low', cat: 'tests', loc: 'src/b.js:3', title: 'No test', impact: '**Breaks:** x', fix: '**Do:** y' }
  ]
};

/* ---------- argument construction (flags verified from `agy --help`) ---------- */

test('agy headless defaults to read-only: --mode plan, --sandbox, no slash commands, JSON output with the findings schema', () => {
  const args = agy.buildHeadlessArgs('PROMPT', '/skill', { env: CLEAN_ENV, scratchDir: '/work/scratch', model: 'gemini-argon-4', effort: 'xhigh', printTimeoutMinutes: 19 });
  assert.equal(flagValue(args, '--mode'), 'plan');
  assert.ok(args.includes('--sandbox'));
  assert.ok(args.includes('--disable-slash-commands'));
  assert.equal(flagValue(args, '--print-timeout'), '19m');
  assert.equal(flagValue(args, '--output-format'), 'json');
  assert.equal(flagValue(args, '--json-schema'), core.FINDINGS_SCHEMA_PATH);
  assert.equal(flagValue(args, '--model'), 'gemini-argon-4');
  assert.equal(flagValue(args, '--effort'), 'xhigh');
  assert.deepEqual(
    args.reduce((acc, a, i) => (a === '--add-dir' ? [...acc, args[i + 1]] : acc), []),
    ['/skill', path.resolve('/work/scratch')]
  );
  assert.equal(args[args.length - 2], '-p');
  assert.equal(args[args.length - 1], 'PROMPT');
  assert.ok(!args.includes('accept-edits'));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.ok(fs.existsSync(core.FINDINGS_SCHEMA_PATH));
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(core.FINDINGS_SCHEMA_PATH, 'utf8')));
});

test('agy modes that can edit files or run commands need the explicit unrestricted opt-in', () => {
  for (const mode of ['accept-edits', 'auto']) {
    assert.throws(() => agy.buildHeadlessArgs('p', '/s', { env: CLEAN_ENV, agyMode: mode }), /lets the agent edit files and run commands/);
    assert.throws(() => agy.buildHeadlessArgs('p', '/s', { env: { CRV_AGY_MODE: mode } }), /lets the agent edit files/);
  }
  // the previous behaviour stays reachable behind the opt-in, and then crv does not ask for JSON output
  const viaOption = agy.buildHeadlessArgs('p', '/s', { env: CLEAN_ENV, agyMode: 'accept-edits', allowUnrestricted: true });
  assert.equal(flagValue(viaOption, '--mode'), 'accept-edits');
  assert.ok(!viaOption.includes('--json-schema'));
  const viaEnv = agy.buildHeadlessArgs('p', '/s', { env: { CRV_AGY_MODE: 'auto', CRV_ALLOW_UNRESTRICTED_HEADLESS: '1' } });
  assert.equal(flagValue(viaEnv, '--mode'), 'auto');
  assert.throws(() => agy.buildHeadlessArgs('p', '/s', { env: { CRV_AGY_MODE: 'yolo' } }), /Invalid agy mode "yolo"/);
});

test('sandbox and JSON output can be switched off, and the print timeout is validated', () => {
  assert.ok(!agy.buildHeadlessArgs('p', '/s', { env: { CRV_AGY_SANDBOX: '0' } }).includes('--sandbox'));
  assert.ok(!agy.buildHeadlessArgs('p', '/s', { env: CLEAN_ENV, sandbox: false }).includes('--sandbox'));
  assert.ok(!agy.buildHeadlessArgs('p', '/s', { env: { CRV_AGY_JSON_SCHEMA: '0' } }).includes('--json-schema'));
  assert.ok(!agy.buildHeadlessArgs('p', '/s', { env: CLEAN_ENV }).includes('--print-timeout'));
  for (const bad of ['0', '-3', '1.5', '999', 'abc']) {
    assert.throws(() => agy.buildHeadlessArgs('p', '/s', { env: CLEAN_ENV, printTimeoutMinutes: bad }), /Invalid print timeout/);
  }
});

test('headlessReturnsFindings is true only for the read-only agy profile', () => {
  assert.equal(core.headlessReturnsFindings(agy, { env: CLEAN_ENV }), true);
  assert.equal(core.headlessReturnsFindings(agy, { env: CLEAN_ENV, agyMode: 'accept-edits', allowUnrestricted: true }), false);
  assert.equal(core.headlessReturnsFindings(core.KNOWN_AGENTS.claude, {}), false);
  assert.equal(core.headlessReturnsFindings(core.KNOWN_AGENTS.gemini, {}), false);
});

test('gemini and codex keep refusing headless runs without the opt-in', () => {
  const prev = process.env.CRV_ALLOW_UNRESTRICTED_HEADLESS;
  delete process.env.CRV_ALLOW_UNRESTRICTED_HEADLESS;
  try {
    for (const id of ['gemini', 'codex']) {
      assert.throws(() => core.KNOWN_AGENTS[id].buildHeadlessArgs('p', '/s', {}), /cannot be restricted/);
    }
  } finally {
    if (prev !== undefined) process.env.CRV_ALLOW_UNRESTRICTED_HEADLESS = prev;
  }
});

/* ---------- effort ---------- */

test('effort accepts low|medium|high|xhigh|max for agy and claude, rejects anything else', () => {
  for (const e of ['low', 'medium', 'high', 'xhigh', 'max', 'MAX']) {
    assert.equal(core.isValidEffort(e, 'agy'), true, `agy ${e}`);
    assert.equal(core.isValidEffort(e, 'claude'), true, `claude ${e}`);
  }
  for (const bad of ['ultra', '', '--effort', 'xhigh; rm -rf /']) {
    assert.equal(core.isValidEffort(bad, 'agy'), false, bad);
  }
  assert.deepEqual(core.AGENT_EFFORTS.agy, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.throws(() => agy.buildHeadlessArgs('p', '/s', { env: CLEAN_ENV, effort: 'ultra' }), /Invalid effort/);
});

test('gemini and codex never receive an --effort flag, even when one is configured', () => {
  const opts = { effort: 'max', model: 'm1', allowUnrestricted: true };
  for (const id of ['gemini', 'codex']) {
    assert.ok(!core.KNOWN_AGENTS[id].buildHeadlessArgs('p', '/s', opts).includes('--effort'));
    assert.ok(!core.KNOWN_AGENTS[id].buildInteractiveArgs('p', '/s', opts).includes('--effort'));
  }
});

/* ---------- parsing the agent's response (envelope is NOT documented in --help) ---------- */

test('parseAgentFindings accepts bare objects, wrappers, fenced and surrounded JSON, content blocks and NDJSON', () => {
  const json = JSON.stringify(GOOD_FINDINGS);
  const variants = {
    bare: json,
    'wrapper object': JSON.stringify({ result: GOOD_FINDINGS }),
    'wrapper string': JSON.stringify({ result: json, is_error: false }),
    'nested wrappers': JSON.stringify({ response: { output: { text: json } } }),
    'structured_output': JSON.stringify({ structured_output: GOOD_FINDINGS, usage: {} }),
    fenced: JSON.stringify({ text: '```json\n' + json + '\n```' }),
    'prose around': `Here are my findings:\n${json}\nHope that helps.`,
    'content blocks': JSON.stringify({ content: [{ type: 'text', text: 'thinking...' }, { type: 'text', text: json }] }),
    ndjson: [JSON.stringify({ type: 'start' }), JSON.stringify({ type: 'delta', text: 'working' }), JSON.stringify({ type: 'result', result: json })].join('\n')
  };
  for (const [name, text] of Object.entries(variants)) {
    const found = core.parseAgentFindings(text);
    assert.ok(found, `${name}: should parse`);
    assert.equal(found.issues.length, 2, `${name}: both issues`);
    assert.equal(found.issues[0].id, 'M1', name);
  }
});

test('parseAgentFindings returns null for unusable output and never throws', () => {
  for (const bad of ['', '   ', 'no json here', '{"issues": "nope"}', '{"foo": 1}', '{not json', JSON.stringify({ result: 'still no findings' }), null, undefined, 42]) {
    assert.equal(core.parseAgentFindings(bad), null, String(bad));
  }
  assert.equal(core.parseAgentFindings('x'.repeat(9 * 1024 * 1024)), null);
});

test('validateAgentFindings drops invalid issues, caps size, and keeps a legitimate empty review', () => {
  const dirty = {
    meta: { summary: 's'.repeat(50000) },
    issues: [
      GOOD_FINDINGS.issues[0],
      { id: 'X1', sev: 'catastrophic', loc: 'a:1', title: 't' },
      { id: '../../etc', sev: 'low', loc: 'a:1', title: 't' },
      { id: 'N1', sev: 'nit', loc: 'a:1', title: '' },
      { id: 'N2', sev: 'nit', loc: 5, title: 't' },
      { id: 'N3', sev: 'high', verify: 'MAYBE', loc: 'a:1', title: 't' },
      'not an object',
      { id: 'L9', sev: 'low', loc: 'a:9', title: 'ok', impact: 'z'.repeat(50000) }
    ]
  };
  const res = core.validateAgentFindings(dirty);
  assert.equal(res.ok, true);
  assert.deepEqual(res.findings.issues.map((i) => i.id), ['M1', 'L9']);
  assert.equal(res.problems.length, 6);
  assert.ok(res.findings.issues[1].impact.length <= 20000);
  assert.ok(res.findings.meta.summary.length <= 20000);

  assert.equal(core.validateAgentFindings({ meta: {}, issues: [] }).ok, true, 'an empty review is valid');
  const allBad = core.validateAgentFindings({ issues: [{ id: 'X', sev: 'nope', loc: 'a', title: 't' }] });
  assert.equal(allBad.ok, false);
  assert.equal(core.validateAgentFindings({}).ok, false);

  const many = core.validateAgentFindings({ issues: Array.from({ length: 300 }, (_, i) => ({ id: `L${i}`, sev: 'low', loc: 'a:1', title: 't' })) });
  assert.equal(many.findings.issues.length, 200);
});

/* ---------- crv writes findings.json itself ---------- */

test('writeFindingsFromAgentOutput writes a private findings.json at a fixed path and ignores paths in the output', () => {
  const dir = tmp();
  const hostile = JSON.stringify({ ...GOOD_FINDINGS, path: '/etc/passwd', outPath: '../../escape.json', findingsPath: '/tmp/evil.json' });
  const res = core.writeFindingsFromAgentOutput(JSON.stringify({ result: hostile }), dir);
  assert.equal(res.written, true);
  assert.equal(res.path, path.join(dir, 'findings.json'));
  const onDisk = JSON.parse(fs.readFileSync(res.path, 'utf8'));
  assert.equal(onDisk.issues.length, 2);
  assert.ok(!('path' in onDisk) && !('outPath' in onDisk));
  if (process.platform !== 'win32') assert.equal(fs.statSync(res.path).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['findings.json']);
  // the written file passes the normal shape check without throwing
  assert.ok(Array.isArray(core.checkFindingsShape(onDisk)));

  const dir2 = tmp();
  const bad = core.writeFindingsFromAgentOutput('the agent rambled', dir2);
  assert.equal(bad.written, false);
  assert.deepEqual(fs.readdirSync(dir2), []);
});

test('runHeadlessAgent: read-only runs write findings from stdout; failures and unusable output are reported', () => {
  const dir = tmp();
  const calls = [];
  const spawnOk = (bin, args, opts) => (calls.push({ bin, args, opts }), { status: 0, stdout: JSON.stringify({ result: GOOD_FINDINGS }) });
  const ok = core.runHeadlessAgent({ spec: agy, args: ['--mode', 'plan'], scratchDir: dir, env: {}, timeoutMs: 1000, returnsFindings: true, spawn: spawnOk });
  assert.deepEqual({ ok: ok.ok, issueCount: ok.issueCount }, { ok: true, issueCount: 2 });
  assert.equal(calls[0].bin, 'agy');
  assert.deepEqual(calls[0].opts.stdio, ['ignore', 'pipe', 'inherit']);
  assert.ok(fs.existsSync(path.join(dir, 'findings.json')));

  const crash = core.runHeadlessAgent({ spec: agy, args: [], scratchDir: tmp(), env: {}, returnsFindings: true, spawn: () => ({ status: 3 }) });
  assert.equal(crash.ok, false);
  assert.match(crash.error, /exit 3/);
  const timedOut = core.runHeadlessAgent({ spec: agy, args: [], scratchDir: tmp(), env: {}, returnsFindings: true, spawn: () => ({ status: null, error: new Error('ETIMEDOUT') }) });
  assert.match(timedOut.error, /ETIMEDOUT/);
  const junk = core.runHeadlessAgent({ spec: agy, args: [], scratchDir: tmp(), env: {}, returnsFindings: true, spawn: () => ({ status: 0, stdout: 'I cannot help with that.' }) });
  assert.equal(junk.ok, false);
  assert.match(junk.error, /not usable findings JSON/);

  // agents that write the file themselves are judged by whether the file exists
  const writer = tmp();
  assert.equal(core.runHeadlessAgent({ spec: agy, args: [], scratchDir: writer, env: {}, returnsFindings: false, spawn: () => ({ status: 0 }) }).ok, false);
  fs.writeFileSync(path.join(writer, 'findings.json'), '{}');
  assert.equal(core.runHeadlessAgent({ spec: agy, args: [], scratchDir: writer, env: {}, returnsFindings: false, spawn: () => ({ status: 0 }) }).ok, true);
});

test('the headless prompt asks a read-only agent to reply with JSON, and a writing agent to write the file', () => {
  const base = { repo: 'o/r', pr: '11', scratchDir: '/s', skillDir: '/k', headless: true, agentName: 'agy' };
  const readOnly = core.buildReviewSkillPrompt({ ...base, returnFindings: true });
  assert.match(readOnly, /read-only and cannot write files/);
  assert.match(readOnly, /ONLY the findings JSON object/);
  assert.ok(!/write_file/.test(readOnly));
  const writing = core.buildReviewSkillPrompt({ ...base });
  assert.match(writing, /write_file/);
  assert.match(writing, /untrusted DATA/, 'the untrusted-input warning stays in both variants');
  assert.match(readOnly, /untrusted DATA/);
});

/* ---------- crv ci-analyze end to end with a stubbed agent ---------- */

test('ci-analyze runs agy read-only, scrubs GitHub credentials from its environment and writes findings.json itself', async () => {
  const scratch = path.join(tmp(), '.crv-skills', 'crv-code-review', '11');
  let spawned = null;
  const deps = {
    env: { PATH: '/usr/bin', GH_TOKEN: 'ghs_secret', GITHUB_TOKEN: 'ghs_secret2', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc', KEEP_ME: '1' },
    stage: () => ({ status: 0 }),
    spawn: (bin, args, opts) => {
      spawned = { bin, args, opts };
      return { status: 0, stdout: JSON.stringify({ result: JSON.stringify(GOOD_FINDINGS) }) };
    }
  };
  const code = await runCiCommand('ci-analyze', ['11', '--repo', 'o/r', '--agent', 'agy', '--scratch', scratch, '--timeout-minutes', '20'], deps);
  assert.equal(code, 0);
  assert.equal(spawned.bin, 'agy');
  assert.equal(flagValue(spawned.args, '--mode'), 'plan');
  assert.ok(spawned.args.includes('--sandbox'));
  assert.equal(flagValue(spawned.args, '--print-timeout'), '19m');
  assert.equal(flagValue(spawned.args, '--model'), 'gemini-argon-4', 'agy defaults to the confirmed model id');
  assert.ok(!spawned.args.includes('accept-edits'));
  assert.equal(spawned.opts.env.GH_TOKEN, undefined);
  assert.equal(spawned.opts.env.GITHUB_TOKEN, undefined);
  assert.equal(spawned.opts.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
  assert.equal(spawned.opts.env.KEEP_ME, '1');
  const written = JSON.parse(fs.readFileSync(path.join(scratch, 'findings.json'), 'utf8'));
  assert.equal(written.issues.length, 2);
});

test('ci-analyze fails (exit 2, no findings.json) when the agent output is not usable', async () => {
  const scratch = path.join(tmp(), '.crv-skills', 'crv-code-review', '12');
  const deps = { env: { PATH: '/usr/bin' }, stage: () => ({ status: 0 }), spawn: () => ({ status: 0, stdout: 'Sorry, I cannot review this.' }) };
  const code = await runCiCommand('ci-analyze', ['12', '--repo', 'o/r', '--agent', 'agy', '--scratch', scratch], deps);
  assert.equal(code, 2);
  assert.ok(!fs.existsSync(path.join(scratch, 'findings.json')));
});

test('ci-analyze with an unrestricted agy mode lets the agent write the file, and only behind the opt-in', async () => {
  const scratch = path.join(tmp(), '.crv-skills', 'crv-code-review', '13');
  await assert.rejects(
    () => runCiCommand('ci-analyze', ['13', '--repo', 'o/r', '--agent', 'agy', '--scratch', scratch], { env: { CRV_AGY_MODE: 'accept-edits' }, stage: () => ({ status: 0 }), spawn: () => ({ status: 0 }) }),
    /lets the agent edit files/
  );
  let args = null;
  const deps = {
    env: { CRV_AGY_MODE: 'accept-edits', CRV_ALLOW_UNRESTRICTED_HEADLESS: '1' },
    stage: () => ({ status: 0 }),
    spawn: (bin, a) => {
      args = a;
      fs.mkdirSync(scratch, { recursive: true });
      fs.writeFileSync(path.join(scratch, 'findings.json'), JSON.stringify(GOOD_FINDINGS));
      return { status: 0 };
    }
  };
  assert.equal(await runCiCommand('ci-analyze', ['13', '--repo', 'o/r', '--agent', 'agy', '--scratch', scratch], deps), 0);
  assert.equal(flagValue(args, '--mode'), 'accept-edits');
  assert.ok(!args.includes('--json-schema'));
});
