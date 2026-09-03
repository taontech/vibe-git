'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var git = require('./git');
var agentAvailability = require('./agent-availability');

var CURRENT_FILE = 'gmc/current.json';
var DEFAULT_AGENT = 'codex';

function configPath() {
  return agentAvailability.configFilePath();
}

function normalizeAgent(agent) {
  var value = String(agent || '').toLowerCase();
  if (value === 'codex' || value === 'claude' || value === 'antigravity' || value === 'opencode') {
    return value;
  }
  throw new Error('Unsupported agent: ' + (agent || '(none)') + '. Use codex, claude, antigravity or opencode.');
}

function readConfig() {
  var file = configPath();
  if (!fs.existsSync(file)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return {};
  }
}

function writeConfig(metadata) {
  var file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(metadata, null, 2) + '\n');
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
  return setAgentSetting(agent, 'gmc.agent', 'agent');
}

function currentCommitAgent() {
  return currentAgentSetting('gmc.commitAgent', 'commitAgent');
}

function setCommitAgent(agent) {
  return setAgentSetting(agent, 'gmc.commitAgent', 'commitAgent');
}

function currentTaskAgent() {
  return currentAgentSetting('gmc.taskAgent', 'taskAgent');
}

function setTaskAgent(agent) {
  return setAgentSetting(agent, 'gmc.taskAgent', 'taskAgent');
}

function currentRepositoryTaskAgent(cwd) {
  var repositoryAgent = git.getConfig('gmc.taskAgent', cwd);
  if (repositoryAgent) {
    return normalizeAgent(repositoryAgent);
  }
  return currentTaskAgent();
}

function setRepositoryTaskAgent(agent, cwd) {
  var selectedAgent = normalizeAgent(agent);
  git.setConfig('gmc.taskAgent', selectedAgent, cwd);
  return selectedAgent;
}

function currentAgentSetting(gitKey, metadataKey) {
  var globalGitAgent = git.getGlobalConfig(gitKey);
  if (globalGitAgent) {
    return normalizeAgent(globalGitAgent);
  }
  var metadata = readConfig();
  if (metadata[metadataKey]) {
    return normalizeAgent(metadata[metadataKey]);
  }
  return currentAgent();
}

function setAgentSetting(agent, gitKey, metadataKey) {
  var selectedAgent = normalizeAgent(agent);
  git.setGlobalConfig(gitKey, selectedAgent);
  try {
    var metadata = readConfig();
    metadata[metadataKey] = selectedAgent;
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
  currentCommitAgent: currentCommitAgent,
  setCommitAgent: setCommitAgent,
  currentTaskAgent: currentTaskAgent,
  setTaskAgent: setTaskAgent,
  currentRepositoryTaskAgent: currentRepositoryTaskAgent,
  setRepositoryTaskAgent: setRepositoryTaskAgent,
  normalizeAgent: normalizeAgent,
  normalizeAgentId: agentAvailability.normalizeAgentId,
  configPath: configPath,
  DEFAULT_AGENTS: agentAvailability.DEFAULT_AGENTS,
  DEFAULT_AGENT_CONFIGS: agentAvailability.DEFAULT_AGENTS,
  SUPPORTED_AGENT_IDS: agentAvailability.SUPPORTED_AGENT_IDS,
  SUPPORTED_AGENT_MAP: agentAvailability.SUPPORTED_AGENT_MAP,
  createAgentConfig: agentAvailability.createAgentConfig,
  validateEnabled: agentAvailability.validateEnabled,
  isSupportedAgent: agentAvailability.isSupportedAgent,
  getDefaultAgentAvailability: agentAvailability.getDefaultAgentAvailability,
  listAgentAvailability: agentAvailability.listAgentAvailability,
  getAgentAvailability: agentAvailability.getAgentAvailability,
  isAgentEnabled: agentAvailability.isAgentEnabled,
  setAgentAvailability: agentAvailability.setAgentAvailability,
  setAllAgentAvailability: agentAvailability.setAllAgentAvailability,
  resetAgentAvailability: agentAvailability.resetAgentAvailability
};
