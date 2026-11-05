#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function syncExtensionWorkbench() {
  const rootDir = path.resolve(__dirname, '..');
  const uiDir = path.join(rootDir, 'packages', 'ui');
  const extWorkbenchDir = path.join(rootDir, 'packages', 'extension', 'workbench');

  fs.mkdirSync(extWorkbenchDir, { recursive: true });

  const indexHtml = fs
    .readFileSync(path.join(uiDir, 'index.html'), 'utf8')
    .replace(/\s*<script src="\.\/vendor\/mermaid\.min\.js"><\/script>/, '');

  fs.writeFileSync(path.join(extWorkbenchDir, 'index.html'), indexHtml, 'utf8');
  fs.copyFileSync(
    path.join(uiDir, 'workbench.css'),
    path.join(extWorkbenchDir, 'workbench.css')
  );
  fs.copyFileSync(
    path.join(uiDir, 'workbench.js'),
    path.join(extWorkbenchDir, 'workbench.js')
  );

  return {
    targetDir: extWorkbenchDir,
    files: ['index.html', 'workbench.css', 'workbench.js']
  };
}

if (require.main === module) {
  const res = syncExtensionWorkbench();
  console.log(`Synced ${res.files.join(', ')} -> ${res.targetDir}`);
}

module.exports = { syncExtensionWorkbench };
