# Chrome Web Store Listing — Agentic PR Review Workbench

> Last Updated: 2026-10-30

## Store Listing

**Extension Name** [REQUIRED]
Agentic PR Review Workbench

**Short Description** [REQUIRED]
Triage AI code review findings across 4 human-leverage layers and publish curated review threads directly to GitHub Pull Requests.

**Detailed Description** [REQUIRED]
Agentic PR Review Workbench helps engineering teams review pull requests alongside AI coding agents without losing GitHub's native review history and team collaboration threads.

Key features:
Organizes pull requests into 4 human-leverage layers: Intent and Architecture diagrams, Verified Risk Findings with inline code slices, Public Contracts and Story-Ordered Flows, and a Behavioral Test Matrix that summarizes tested scenarios while collapsing repetitive test boilerplate.
Lets human reviewers triage findings as Blocking, Comment, or Dismissed before publishing a clean GitHub Pull Request Review.
Reads and writes structured review threads directly inside GitHub Pull Request comments so your entire team stays in sync without juggling static file attachments.

How to use:
Open any GitHub Pull Request page and click the Agent Workbench button in the pull request header, or click the extension icon in your browser toolbar to open the side panel.
Triage findings, add reviewer notes, and publish your curated review directly to GitHub.

Privacy and permissions:
All review triage data stays on your device and in your GitHub repository's pull request comments. No data is sent to third-party analytics servers.

**Category** [REQUIRED]
Developer Tools

**Single Purpose** [REQUIRED]
Displays structured code review findings alongside GitHub pull requests and publishes curated review comments to GitHub.

**Primary Language** [REQUIRED]
English

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | `packages/extension/icons/icon-128.png` |
| Screenshot 1 [REQUIRED] | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 2 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Not created | |

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `storage` | permissions | Saves the reviewer's in-progress triage decisions and notes locally across browser restarts. |
| `tabs` | permissions | Identifies the active GitHub pull request URL from the side panel so the matching review findings are displayed. |
| `sidePanel` | permissions | Displays the PR Review Workbench side-by-side with the GitHub pull request page. |
| `https://github.com/*` | host_permissions | Reads pull request review comment threads and injects the Workbench button on GitHub pull request pages. |
| `http://127.0.0.1:4320/*` | host_permissions | Connects to the developer's local CLI workbench server when running locally. |

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** No

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Distribution

**Visibility**: Private / Internal Team
**Regions**: All regions

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 0.1.0 | 2026-10-30 | Initial Manifest V3 side panel, GitHub PR comment scanner, and local CLI bridge | Draft |
