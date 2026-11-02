'use strict';

const githubComments = require('./github-comments');
const diffClassifier = require('./diff-classifier');
const findingsCompiler = require('./findings-compiler');
const repoConfig = require('./repo-config');
const agentRunner = require('./agent-runner');

module.exports = {
  ...githubComments,
  ...diffClassifier,
  ...findingsCompiler,
  ...repoConfig,
  ...agentRunner
};
