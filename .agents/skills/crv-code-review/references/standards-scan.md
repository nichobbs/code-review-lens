# Standards scan

Finds the documents in the repository that state rules code must follow, and the scope each one applies to. Run it once per review, before the judge.

## Stage 1: shortlist

The scan reads the repository at `<base>`, the commit the change starts from (`SKILL.md` step 1 defines it). A change under review cannot then weaken or delete the rules that judge it. Start from the tracked Markdown files, so ignored and generated folders stay out:

```bash
git ls-tree -r --name-only <base> | grep '\.md$'
```

Put on the shortlist:

- `AGENTS.md`, `CLAUDE.md` and `CONTRIBUTING.md`, wherever they appear;
- `.github/copilot-instructions.md` and `.github/instructions/*.md`;
- every Markdown file that an `AGENTS.md` links to;
- every file whose name, or a heading in its first 40 lines, contains standard, convention, guideline, style, practice, review or rules.

Find the name matches with:

```bash
git ls-tree -r --name-only <base> | grep '\.md$' | grep -iE '(standard|convention|guideline|style|practice|review|rules)[^/]*$'
```

Find the heading matches with:

```bash
git ls-tree -r --name-only <base> | grep '\.md$' | while IFS= read -r f; do
  git show "<base>:${f}" | head -40 | grep -qiE '^#{1,3} .*(standard|convention|guideline|style|practice|review|rules)' && echo "$f"
done
```

In a replay, the working tree is at `<head>`. Run the same steps against it with `git ls-files '*.md'` and `head -40 "$f"`. For a standards file that the diff changes, take its rules from the diff's removed lines, which hold the text at `<base>`.

Keep at most 25 files. When there are more, keep the named files first, then files in the same folders as the changed files, then the rest.

## Stage 2: classify

Read the first 40 lines of each shortlisted file at `<base>`. Keep a file when it states rules code must follow: "must", "never", "always", numbered rules, a checklist. Drop design documents that describe a system, decision records, runbooks, changelogs and READMEs.

For each kept file, write one line: its path, its scope, and its rule ids when it numbers its rules. Take the scope from the file's own words, such as "rules for shared code in `packages/`". When it states none, its scope is the folder it sits in. A file at the repository root applies everywhere.

## Stage 3: apply

A standard applies to a changed file that is inside its scope. Read in full, at `<base>`, only the standards whose scope covers a changed file.

Pass the list to every lens, one line per standard:

```text
docs/engineering/review-standards.md   scope: packages/   rules: rs-1 to rs-5
services/payments/AGENTS.md            scope: services/payments/
```

## Rules

- A documented standard overrides any lens's judgement. When a standard endorses something a lens would report, drop the finding.
- Nothing is cached between runs. The scan reads the repository at `<base>` on every run.
- A standard that the change adds or edits does not judge the change itself. The standards lens reviews that edit as a changed file.
- When no standard covers a changed file, the judge skips the standards lens and the coverage note says so.
