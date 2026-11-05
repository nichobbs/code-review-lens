#!/usr/bin/env node
/**
 * test_report.mjs — drive a built report in jsdom and check the interactive layer.
 *
 *   node scripts/test_report.mjs                 # builds its own fixture, tests that
 *   node scripts/test_report.mjs some-report.html  # tests an existing report instead
 *
 * Covers the comment feature end to end: per-issue notes, localStorage namespacing, the sidebar
 * comment flag and filter, the "Copy comments" export text, the keyboard guard, and revision keying.
 * Needs jsdom somewhere on the machine; exits 0 with a message when it cannot find one, so this
 * never blocks a build.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname);

// ---------------------------------------------------------------- jsdom lookup
// Resolve from this script, then the cwd, then any pnpm store under the cwd. Skipping is a pass:
// the report itself has no build-time dependency on jsdom, only this test does.
async function loadJSDOM() {
  const bases = [HERE, process.cwd()];
  for (const b of bases) {
    try { return (await import(createRequire(path.join(b, "x.js")).resolve("jsdom"))).JSDOM; }
    catch { /* keep looking */ }
  }
  const store = path.join(process.cwd(), "node_modules", ".pnpm");
  if (fs.existsSync(store)) {
    for (const d of fs.readdirSync(store).filter((n) => n.startsWith("jsdom@")).sort().reverse()) {
      const api = path.join(store, d, "node_modules", "jsdom", "lib", "api.js");
      if (fs.existsSync(api)) {
        try { return (await import(pathToFileURL(api).href)).JSDOM; } catch { /* next */ }
      }
    }
  }
  return null;
}

const JSDOM = await loadJSDOM();
if (!JSDOM) {
  console.log("SKIP: jsdom not found (tried this script's node_modules, the cwd, and ./node_modules/.pnpm).");
  console.log("      Run from a project that has jsdom installed, or `npm i jsdom`, to exercise these checks.");
  process.exit(0);
}

// ---------------------------------------------------------------- fixture
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crv-test-"));
let REPORT = process.argv[2];
let STORAGE_KEY = null;
if (!REPORT) {
  const findings = {
    meta: {
      title: "Fixture review", storageKey: "crv-test-done",
      prUrl: "https://github.com/org/repo/pull/7", headCommit: "abc1234",
      summary: "A fixture used by test_report.mjs.",
      review: { repo: "org/repo", pr: 7, base: "base0000", head: "abc1234def", agent: "Claude Code",
        model: "test-model", lenses: ["correctness"] },
    },
    issues: [
      { id: "H1", sev: "high", cat: "correctness", verify: "CONFIRMED", loc: "src/a.ts:10",
        earlier: [{ who: "Copilot", loc: "src/a.ts:10", url: "https://github.com/org/repo/pull/7#discussion_r1" },
          { who: "Copilot", loc: "src/a.ts:14", url: "https://github.com/org/repo/pull/7#discussion_r2" },
          { who: "alice", loc: "", url: "https://github.com/org/repo/pull/7#issuecomment-3" }], title: "Blocker with & and <angles>",
        impact: "**Breaks:** a\n\n**Because:** b `src/a.ts:10`\n\n**Reach:** c",
        fix: "**Do:** d\n\n**Check:** e" },
      { id: "M1", sev: "medium", verify: "PLAUSIBLE", loc: "src/b.ts:20", title: "Should-fix thing",
        impact: "**Breaks:** a\n\n**Because:** b `src/b.ts:20`\n\n**Reach:** c",
        fix: "**Do:** d\n\n**Check:** e" },
      { id: "L1", sev: "low", loc: "src/c.ts:30", title: "Minor thing",
        impact: "**Breaks:** a\n\n**Because:** b `src/c.ts:30`\n\n**Reach:** c",
        fix: "**Do:** d\n\n**Check:** e" },
    ],
  };
  const fj = path.join(tmp, "findings.json");
  fs.writeFileSync(fj, JSON.stringify(findings));
  REPORT = path.join(tmp, "fixture.html");
  execFileSync("python3", [path.join(HERE, "build_report.py"), fj, REPORT, "--no-open"],
    { stdio: ["ignore", "ignore", "inherit"] });
}
{
  const m = fs.readFileSync(REPORT, "utf-8").match(/KEY='([^']*)'/);
  STORAGE_KEY = m ? m[1] : "crv-report-done";
}
const CKEY = STORAGE_KEY + ":comments";

// ---------------------------------------------------------------- harness
const fails = [], ok = [];
const check = (n, c, x) => (c ? ok : fails).push(n + (c ? "" : "  <-- got: " + (x ?? "")));

// jsdom refuses localStorage on a file:// origin. Real browsers give file:// pages one, which the
// report's check-offs already rely on, so shim it and keep testing the real file: code path.
function makeStorage(seed) {
  const m = new Map(Object.entries(seed || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; }, _keys: () => [...m.keys()] };
}
function load(file, seed) {
  // The inlined Mermaid bundle is ~3.3 MB and jsdom cannot render SVG. Strip it: the app wraps
  // every mermaid call in try/catch, so removing it also exercises that path.
  const html = fs.readFileSync(file, "utf-8")
    .replace(/<script>\/\*[\s\S]*?\*\/<\/script>/, "<script>/* stripped */</script>");
  const store = makeStorage(seed);
  const dom = new JSDOM(html, {
    runScripts: "dangerously", url: pathToFileURL(file).href, pretendToBeVisual: true,
    beforeParse(w) {
      Object.defineProperty(w, "localStorage", { value: store, configurable: true });
      w.Element.prototype.scrollIntoView = function () {}; // not implemented in jsdom
    },
  });
  return { w: dom.window, d: dom.window.document, store };
}
const type = (w, el, text) => {
  el.value = text; el.dispatchEvent(new w.Event("input", { bubbles: true }));
};
const key = (w, el, k) =>
  el.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const clickEl = (w, el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));

const { w, d, store } = load(REPORT);

// --- the button and filter start off ------------------------------------------------------------
check("copy button rendered", !!d.querySelector("#copyCmt"));
check("copy button disabled with no comments", d.querySelector("#copyCmt").disabled === true);
check("copy button label with no comments",
  d.querySelector("#copyCmt").textContent === "Copy comments", d.querySelector("#copyCmt").textContent);
check("comment filter disabled with no comments", d.querySelector("#fcmt").disabled === true);

// --- the box appears on issues only -------------------------------------------------------------
w.select("__overview__");
check("no comment box on the overview pane", d.querySelector("#cmtbox") === null);
w.select("H1");
check("comment box on an issue pane", !!d.querySelector("#cmtbox"));
check("clear button hidden while the box is empty", d.querySelector("#cmtclr").style.display === "none");

// --- typing saves and updates the chrome --------------------------------------------------------
type(w, d.querySelector("#cmtbox"), "split this into two PRs");
check("comment saved under <storageKey>:comments",
  (JSON.parse(store.getItem(CKEY) || "{}")).H1 === "split this into two PRs", store.getItem(CKEY));
check("the check-off key is untouched by a comment",
  !store.getItem(STORAGE_KEY) || !JSON.parse(store.getItem(STORAGE_KEY)).H1);
check("copy button enabled", d.querySelector("#copyCmt").disabled === false);
check("copy button counts one, singular",
  d.querySelector("#copyCmt").textContent === "Copy 1 comment", d.querySelector("#copyCmt").textContent);
check("comment filter enabled", d.querySelector("#fcmt").disabled === false);
check("sidebar shows the comment flag", !!d.querySelector('.item[data-id="H1"] .cflag'));
check("clear button appears once there is text", d.querySelector("#cmtclr").style.display === "");

// --- more comments, entered out of severity order -----------------------------------------------
w.select("L1"); type(w, d.querySelector("#cmtbox"), "low note");
w.select("M1"); type(w, d.querySelector("#cmtbox"), "medium note.\nsecond line.");
check("copy button counts three, plural",
  d.querySelector("#copyCmt").textContent === "Copy 3 comments", d.querySelector("#copyCmt").textContent);

// --- the export -----------------------------------------------------------------------------------
const t = w.buildExport();
check("export names the report path", t.includes("Report:       " + REPORT),
  t.split("\n").find((l) => l.startsWith("Report:")));
check("export names the PR url", t.includes("Pull request: https://github.com/org/repo/pull/7"));
check("export names the head commit", t.includes("Head commit:  abc1234"));
check("export counts comments against the finding total", t.includes("Comments:     3 of 3 findings"));
check("export instructs the tool to open the report", /Open the report file above/.test(t));
check("export carries every commented id", ["H1", "M1", "L1"].every((id) => t.includes("\n" + id + " · ")));
check("export orders by severity, not entry order",
  t.indexOf("\nH1 · ") < t.indexOf("\nM1 · ") && t.indexOf("\nM1 · ") < t.indexOf("\nL1 · "));
check("export carries the location", t.includes("src/a.ts:10"));
check("export indents the comment body", t.includes("  split this into two PRs"));
check("export indents every line of a multi-line comment",
  t.includes("  medium note.\n  second line."));
check("export decodes HTML entities in the title", t.includes("Blocker with & and <angles>"));
check("export has no leftover entities", !/&(amp|lt|gt|#\d+);/.test(t), (t.match(/&\w+;/g) || []).join(","));
check("export marks a finding as not checked off", t.includes("· not checked off"));

// --- check-off state reaches the export ------------------------------------------------------------
w.toggle("H1", true);
check("export marks a checked-off finding", /\nH1 · high · checked off\n/.test(w.buildExport()),
  w.buildExport().split("\n").find((l) => l.startsWith("H1 ·")));
check("checking off leaves the comment intact",
  JSON.parse(store.getItem(CKEY)).H1 === "split this into two PRs");

// --- uncommented findings stay out ------------------------------------------------------------------
w.select("L1"); clickEl(w, d.querySelector("#cmtclr"));
check("clear removes the entry", !("L1" in JSON.parse(store.getItem(CKEY))),
  store.getItem(CKEY));
check("copy count drops after a clear",
  d.querySelector("#copyCmt").textContent === "Copy 2 comments", d.querySelector("#copyCmt").textContent);
check("cleared finding leaves the export", !w.buildExport().includes("\nL1 · "));
w.select("L1"); type(w, d.querySelector("#cmtbox"), "   \n  ");
check("a whitespace-only comment is not stored", !("L1" in JSON.parse(store.getItem(CKEY))));

// --- the filter ---------------------------------------------------------------------------------------
// H1 is checked off, so it sits under Done; the All tab shows both states.
clickEl(w, d.querySelector('[data-t="all"]'));
clickEl(w, d.querySelector("#fcmt"));
const shown = [...d.querySelectorAll(".list .item:not(.ov)")].map((e) => e.dataset.id).sort();
check("commented filter lists exactly the commented findings",
  shown.join(",") === "H1,M1", shown.join(","));
clickEl(w, d.querySelector('[data-f="all"]'));

// --- the keyboard guard --------------------------------------------------------------------------------
w.select("M1");
const box = d.querySelector("#cmtbox"); box.focus();
const doneBefore = store.getItem(STORAGE_KEY);
["j", "k", "x"].forEach((k) => key(w, box, k));
check("j/k in the comment box do not navigate",
  d.querySelector(".item.active").dataset.id === "M1", d.querySelector(".item.active").dataset.id);
check("x in the comment box does not check the finding off",
  store.getItem(STORAGE_KEY) === doneBefore);
key(w, d.body, "j");
check("j still navigates from outside the comment box",
  d.querySelector(".item.active").dataset.id !== "M1", d.querySelector(".item.active").dataset.id);

// --- persistence ------------------------------------------------------------------------------------------
const saved = store.getItem(CKEY);
const again = load(REPORT, { [CKEY]: saved });
check("comments survive a reload",
  again.d.querySelector("#copyCmt").textContent === "Copy 2 comments",
  again.d.querySelector("#copyCmt").textContent);
check("reloaded report shows the comment flag",
  !!again.d.querySelector('.item[data-id="H1"] .cflag'));

// --- ratings ----------------------------------------------------------------------------------------------
const RK = STORAGE_KEY + ":ratings";
const fb = load(REPORT);
const ratingsNow = () => JSON.parse(fb.store.getItem(RK) || "{}");
fb.w.select("H1");
check("rating row on an issue pane", !!fb.d.querySelector("#rate"));
clickEl(fb.w, fb.d.querySelector('#rate [data-rate="useful"]'));
check("useful saved under <storageKey>:ratings", ratingsNow().H1?.rating === "useful", fb.store.getItem(RK));
clickEl(fb.w, fb.d.querySelector('#rate [data-rate="useful"]'));
check("clicking the same rating again clears it", !ratingsNow().H1, fb.store.getItem(RK));
fb.w.select("M1");
clickEl(fb.w, fb.d.querySelector('#rate [data-rate="not-useful"]'));
check("not useful shows the four reasons", fb.d.querySelectorAll("#rate [data-reason]").length === 4);
check("an incomplete rating is not complete", fb.w.isComplete(ratingsNow().M1) === false);
check("the hint asks for a reason", (fb.d.querySelector("#rate .rhint")?.textContent || "").startsWith("Pick a reason"),
  fb.d.querySelector("#rate .rhint")?.textContent);
clickEl(fb.w, fb.d.querySelector('#rate [data-reason="duplicate"]'));
check("a duplicate without its finding asks for the finding",
  fb.d.querySelector("#rate .rhint")?.textContent ===
    "Choose the finding this duplicates to include this rating in the feedback file.",
  fb.d.querySelector("#rate .rhint")?.textContent);
const dup = fb.d.querySelector("#rdup");
check("duplicate asks which finding", !!dup && [...dup.options].some((o) => o.value === "H1"));
dup.value = "H1"; dup.dispatchEvent(new fb.w.Event("change", { bubbles: true }));
check("duplicateOf saved", ratingsNow().M1?.duplicateOf === "H1", fb.store.getItem(RK));
check("a duplicate with its finding is complete", fb.w.isComplete(ratingsNow().M1) === true);
type(fb.w, fb.d.querySelector("#rnote"), "same as H1");
check("rating note saved", ratingsNow().M1?.note === "same as H1");
check("a rating does not tick the finding done",
  !fb.store.getItem(STORAGE_KEY) || !JSON.parse(fb.store.getItem(STORAGE_KEY)).M1);
fb.w.select("__overview__");
check("no rating row on the overview pane", fb.d.querySelector("#rate") === null);

// --- missed items and rater -------------------------------------------------------------------
const MK = STORAGE_KEY + ":missed";
fb.w.select("__overview__");
check("missed form on the overview", !!fb.d.querySelector("#missed"));
check("lens choices come from the skill",
  [...fb.d.querySelector("#mlens").options].some((o) => o.value === "correctness"));
type(fb.w, fb.d.querySelector("#mrater"), "octocat");
check("rater name saved under the global key", fb.store.getItem("crv-code-review:rater") === "octocat");
fb.d.querySelector("#mtext").value = "No check that the retry is idempotent";
fb.d.querySelector("#mloc").value = "src/a.ts:12";
fb.d.querySelector("#mlens").value = "data";
clickEl(fb.w, fb.d.querySelector("#madd"));
check("missed item saved under <storageKey>:missed",
  JSON.parse(fb.store.getItem(MK) || "[]").length === 1, fb.store.getItem(MK));
check("missed item listed", fb.d.querySelectorAll(".mlist li").length === 1);
check("missed item row shows X id, text, location and lens",
  fb.d.querySelector(".mlist .mid")?.textContent === "X1" &&
  fb.d.querySelector(".mlist .mtext")?.textContent === "No check that the retry is idempotent" &&
  fb.d.querySelector(".mlist .mmeta code")?.textContent === "src/a.ts:12" &&
  fb.d.querySelector(".mlist .mmeta .lens")?.textContent === "data");
fb.d.querySelector("#mtext").value = "   ";
clickEl(fb.w, fb.d.querySelector("#madd"));
check("an empty missed item is not added", JSON.parse(fb.store.getItem(MK)).length === 1);

// --- feedback file ----------------------------------------------------------------------------------------
check("download button rendered", !!fb.d.querySelector("#dlFb"));
check("download button enabled once there is feedback", fb.d.querySelector("#dlFb").disabled === false);
const out = fb.w.buildFeedback();
check("feedback file version 1", out.version === 1);
check("feedback file carries meta.review",
  out.review.pr === 7 && out.review.head === "abc1234def" && /^[0-9a-f]{64}$/.test(out.review.lensHash || ""),
  JSON.stringify(out.review));
check("feedback file holds complete ratings only",
  out.ratings.length === 1 && out.ratings[0].id === "M1" && out.ratings[0].reason === "duplicate" &&
  out.ratings[0].duplicateOf === "H1" && out.ratings[0].appliedIn === null, JSON.stringify(out.ratings));
check("the duplicated finding H1 is unrated", !out.ratings.some((r) => r.id === "H1"), JSON.stringify(out.ratings));
check("a duplicate carries the duplicated finding's location, title and lens",
  out.ratings[0].duplicateOfLoc === "src/a.ts:10" && out.ratings[0].duplicateOfTitle === "Blocker with & and <angles>" &&
  out.ratings[0].duplicateOfLens === "correctness", JSON.stringify(out.ratings[0]));
check("missed items get X ids", out.missed[0].id === "X1" && out.missed[0].lens === "data", JSON.stringify(out.missed));
{
  // Contract with the dataset: the downloaded file must pass dataset.load() when evals exist.
  const fbFile = path.join(tmp, "feedback.json");
  fs.writeFileSync(fbFile, JSON.stringify(out, null, 2) + "\n");
  const evalsScripts = path.join(HERE, "..", "..", "..", "evals", "crv-code-review", "scripts");
  if (fs.existsSync(evalsScripts)) {
    let loadErr = "";
    try {
      execFileSync("python3", ["-c", "import sys; sys.path.insert(0, sys.argv[2]); import dataset; dataset.load(sys.argv[1])",
        fbFile, evalsScripts], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      loadErr = String(e.stderr || e.message).trim().split("\n").pop();
    }
    check("the feedback file passes dataset.load()", loadErr === "", loadErr);
  }
}
check("rater in the feedback file", out.rater === "octocat");
check("feedback file name", fb.w.feedbackName() === "pr-7-abc1234.json", fb.w.feedbackName());
let savedName = null;
fb.w.URL.createObjectURL = () => "blob:x"; fb.w.URL.revokeObjectURL = () => {};
fb.w.HTMLAnchorElement.prototype.click = function () { savedName = this.download; };
clickEl(fb.w, fb.d.querySelector("#dlFb"));
check("download saves the named file", savedName === "pr-7-abc1234.json", savedName);
fb.w.select("__overview__");
clickEl(fb.w, fb.d.querySelector("[data-mdel]"));
check("missed item removed", JSON.parse(fb.store.getItem(MK)).length === 0);

// --- revision keying ---------------------------------------------------------------------------------------
if (!process.argv[2]) {
  const fj2 = path.join(tmp, "findings2.json");
  const f2 = JSON.parse(fs.readFileSync(path.join(tmp, "findings.json"), "utf-8"));
  f2.meta.storageKey = "crv-test-done-r2";
  f2.meta.revision = { number: 2, summary: "fixture revision", reviewedCommit: "abc1234" };
  fs.writeFileSync(fj2, JSON.stringify(f2));
  execFileSync("python3", [path.join(HERE, "build_report.py"), fj2, "--revise", REPORT, "--no-open"],
    { stdio: ["ignore", "ignore", "ignore"] });
  const r2path = REPORT.replace(/\.html$/, "-r2.html");
  const r2 = load(r2path);
  r2.w.select("H1"); type(r2.w, r2.d.querySelector("#cmtbox"), "r2 note");
  check("a revision namespaces its comments separately from r1",
    r2.store._keys().includes("crv-test-done-r2:comments") &&
    !r2.store._keys().includes("crv-test-done:comments"), r2.store._keys().join(","));
  r2.w.select("__revision__");
  check("the revision pane has no comment box", r2.d.querySelector("#cmtbox") === null);

  const fj3 = path.join(tmp, "findings3.json");
  const f3 = JSON.parse(fs.readFileSync(path.join(tmp, "findings.json"), "utf-8"));
  delete f3.meta.review; f3.meta.storageKey = "crv-test-nopr";
  fs.writeFileSync(fj3, JSON.stringify(f3));
  const r3path = path.join(tmp, "nopr.html");
  execFileSync("python3", [path.join(HERE, "build_report.py"), fj3, r3path, "--no-open"],
    { stdio: ["ignore", "ignore", "ignore"] });
  check("download button hidden without a PR in meta.review",
    load(r3path).d.querySelector("#dlFb").style.display === "none");
}

// --- the result and the verifier line ------------------------------------------------------------
{
  const nr = load(REPORT);
  check("the header shows the computed result", nr.d.querySelector("#result").textContent === "Blockers found",
    nr.d.querySelector("#result").textContent);
  check("the result says the review never approves",
    (nr.d.querySelector("#result").getAttribute("title") || "").includes("never approves a pull request"));
  nr.w.select("M1");
  check("an unverified finding says so on its pane", nr.d.querySelector("#detail").textContent.includes("Unverified"));
  nr.w.select("H1");
  check("a confirmed finding says so on its pane", nr.d.querySelector("#detail").textContent.includes("Confirmed"));
}

// --- earlier review threads ---------------------------------------------------------------------
{
  const er = load(REPORT);
  const mark = er.d.querySelector('.rack .item[data-id="H1"] .salso');
  check("a repeated finding is marked in the left pane", !!mark && mark.textContent === "Also raised by Copilot, alice",
    mark && mark.textContent);
  check("a finding with no earlier thread has no mark", er.d.querySelector('.rack .item[data-id="M1"] .salso') === null);
  er.w.select("H1");
  const links = [...er.d.querySelectorAll("#detail .alsolist a")];
  check("the pane links each earlier thread", links.length === 3, links.length);
  check("a thread link names the reviewer and the line",
    links[0] && links[0].textContent === "Copilot · a.ts:10" && links[0].getAttribute("href").endsWith("#discussion_r1"),
    links[0] && links[0].textContent);
  check("a PR comment with no line shows the reviewer only", links[2] && links[2].textContent === "alice",
    links[2] && links[2].textContent);
}

// ---------------------------------------------------------------- report
console.log(ok.map((n) => "  ✓ " + n).join("\n"));
if (fails.length) {
  console.log("\nFAIL (" + fails.length + " of " + (ok.length + fails.length) + "):");
  console.log(fails.map((n) => "  ✗ " + n).join("\n"));
  process.exitCode = 1;
} else {
  console.log("\nall " + ok.length + " checks passed  (report: " + REPORT + ")");
}
