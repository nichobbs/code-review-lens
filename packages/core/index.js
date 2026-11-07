'use strict';

const githubComments = require('./github-comments');
const diffClassifier = require('./diff-classifier');
const findingsCompiler = require('./findings-compiler');
const repoConfig = require('./repo-config');
const agentRunner = require('./agent-runner');
const agentOutput = require('./agent-output');
const ci = require('./ci');
const scratch = require('./scratch');

module.exports = {
  ...githubComments,
  ...diffClassifier,
  ...findingsCompiler,
  ...repoConfig,
  ...agentRunner,
  ...agentOutput,
  ...ci,
  ...scratch
};
