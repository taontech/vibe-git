'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var git = require('./git');

var CURRENT_FILE = 'gmc/current.json';
var CONFIG_FILE = path.join(os.homedir(), '.config', 'gmc', 'config.json');
var DEFAULT_AGENT = 'codex';

function normalizeAgent(agent) {
  var value = String(agent || '').toLowerCase();
  if (value === 'codex' || value === 'claude' || value === 'antigravity' || value === 'opencode') {
    return value;
  }
  throw new Error('Unsupported agent: ' + (agent || '(none)') + '. Use codex, claude, antigravity or opencode.');
}

function readConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function writeConfig(metadata) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(metadata, null, 2) + '\n');
  return metadata;
}

function currentAgent() {
  var globalGitAgent = git.getGlobalConfig('gmc.agent');
  if (globalGitAgent) {
    return normalizeAgent(globalGitAgent);
  }
  var metadata = readConfig();
  if (metadata.agent) {
    return normalizeAgent(metadata.agent);
  }
  return DEFAULT_AGENT;
}

function setAgent(agent) {
  var selectedAgent = normalizeAgent(agent);
  git.setGlobalConfig('gmc.agent', selectedAgent);
  try {
    var metadata = readConfig();
    metadata.agent = selectedAgent;
    writeConfig(metadata);
  } catch (error) {
    // Ignore filesystem write errors since git config --global succeeded
  }
  return selectedAgent;
}

function bindIssue(cwd, issue, agent) {
  var root = git.repoRoot(cwd);
  var branch = git.currentBranch(root);
  var metadata = {
    provider: issue.provider,
    issue: issue.ref,
    number: issue.number,
    url: issue.url,
    title: issue.title,
    labels: issue.labels || [],
    owner: issue.owner,
    repo: issue.repo,
    branch: branch
  };

  normalizeAgent(agent || currentAgent());
  git.setConfig('gmc.issue', metadata.issue, root);
  git.setConfig('gmc.issueNumber', String(metadata.number), root);
  git.setConfig('gmc.issueUrl', metadata.url, root);
  git.setConfig('gmc.issueTitle', metadata.title, root);
  git.setConfig('gmc.issueProvider', metadata.provider, root);
  git.writeGitFile(root, CURRENT_FILE, JSON.stringify(metadata, null, 2) + '\n');
  return metadata;
}

function readBinding(cwd) {
  var root = git.repoRoot(cwd);
  var metadata = git.readJsonGitFile(root, CURRENT_FILE);
  if (metadata) {
    metadata.agent = currentAgent();
    return metadata;
  }

  var issue = git.getConfig('gmc.issue', root);
  if (!issue) {
    return null;
  }

  return {
    provider: git.getConfig('gmc.issueProvider', root) || 'github',
    issue: issue,
    number: Number(git.getConfig('gmc.issueNumber', root)),
    url: git.getConfig('gmc.issueUrl', root),
    title: git.getConfig('gmc.issueTitle', root),
    branch: git.currentBranch(root),
    agent: currentAgent()
  };
}

module.exports = {
  bindIssue: bindIssue,
  readBinding: readBinding,
  currentAgent: currentAgent,
  setAgent: setAgent,
  normalizeAgent: normalizeAgent,
  configPath: function() {
    return CONFIG_FILE;
  }
};
