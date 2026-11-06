#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const UI_DIR = path.join(ROOT_DIR, 'packages', 'ui');
const EXT_DIR = path.join(ROOT_DIR, 'packages', 'extension', 'workbench');

/** The extension workbench is a generated copy of packages/ui: name -> expected content. */
function buildExpectedFiles() {
  const read = (name) => fs.readFileSync(path.join(UI_DIR, name), 'utf8');
  return {
    'index.html': read('index.html').replace(/\s*<script src="\.\/vendor\/mermaid\.min\.js"><\/script>/, ''),
    'workbench.css': read('workbench.css'),
    'sanitize.js': read('sanitize.js'),
    'workbench.js': read('workbench.js')
  };
}

/**
 * Regenerates packages/extension/workbench from packages/ui.
 * With `{ check: true }` nothing is written; returns the names of files that differ (CI drift check).
 */
function syncExtensionWorkbench(options = {}) {
  const expected = buildExpectedFiles();
  const drifted = Object.keys(expected).filter((name) => {
    const target = path.join(EXT_DIR, name);
    return !fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== expected[name];
  });
  if (options.check) return { targetDir: EXT_DIR, files: Object.keys(expected), drifted };

  fs.mkdirSync(EXT_DIR, { recursive: true });
  for (const [name, content] of Object.entries(expected)) {
    fs.writeFileSync(path.join(EXT_DIR, name), content, 'utf8');
  }
  return { targetDir: EXT_DIR, files: Object.keys(expected), drifted: [] };
}

if (require.main === module) {
  if (process.argv.includes('--check')) {
    const { drifted } = syncExtensionWorkbench({ check: true });
    if (drifted.length) {
      console.error(`packages/extension/workbench is out of sync with packages/ui: ${drifted.join(', ')}\nRun: npm run sync-extension`);
      process.exit(1);
    }
    console.log('Extension workbench is in sync with packages/ui.');
  } else {
    const res = syncExtensionWorkbench();
    console.log(`Synced ${res.files.join(', ')} -> ${res.targetDir}`);
  }
}

module.exports = { syncExtensionWorkbench, buildExpectedFiles };
