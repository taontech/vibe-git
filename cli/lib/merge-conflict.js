'use strict';

var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');
var agent = require('./agent');
var config = require('./config');
var git = require('./git');
var prompts = require('./prompts');

var DIFF_LIMIT = 120000;

function inMerge(root) {
  var repoRoot = git.repoRoot(root);
  var mergeHead = path.join(git.gitDir(repoRoot), 'MERGE_HEAD');
  return fs.existsSync(mergeHead);
}

function getMergeBranches(root) {
  var repoRoot = git.repoRoot(root);
  var mergeHead = path.join(git.gitDir(repoRoot), 'MERGE_HEAD');
  if (!fs.existsSync(mergeHead)) {
    return null;
  }
  var mergeHeadOid = fs.readFileSync(mergeHead, 'utf8').trim();
  var branch = git.currentBranch(repoRoot);
  var mergeBranch = '';
  var mergeBranchResult = git.runGit(['name-rev', '--name-only', mergeHeadOid], {
    cwd: repoRoot,
    allowFailure: true
  });
  if (mergeBranchResult.status === 0 && mergeBranchResult.stdout) {
    mergeBranch = mergeBranchResult.stdout.trim();
  }
  if (!mergeBranch) {
    mergeBranch = mergeHeadOid.slice(0, 12);
  }
  return {
    branch: branch,
    mergeBranch: mergeBranch,
    mergeHeadOid: mergeHeadOid
  };
}

function listConflictedFiles(root) {
  var repoRoot = git.repoRoot(root);
  var output = git.runGit(['diff', '--name-only', '--diff-filter=U'], {
    cwd: repoRoot,
    allowFailure: true
  });
  if (output.status !== 0 || !output.stdout) {
    return [];
  }
  return output.stdout.trim().split(/\r?\n/).filter(Boolean);
}

function getOurs(root, filePath) {
  return gitShow(root, ':2:' + filePath);
}

function getTheirs(root, filePath) {
  return gitShow(root, ':3:' + filePath);
}

function getBase(root, filePath) {
  return gitShow(root, ':1:' + filePath);
}

function gitShow(root, ref) {
  var result = childProcess.spawnSync('git', ['show', ref], {
    cwd: git.repoRoot(root),
    encoding: 'utf8',
    maxBuffer: DIFF_LIMIT + 1024
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  return result.stdout;
}

function getConflictedContent(root, filePath) {
  var repoRoot = git.repoRoot(root);
  var fullPath = path.resolve(repoRoot, filePath);
  if (!fs.existsSync(fullPath)) {
    return null;
  }
  return fs.readFileSync(fullPath, 'utf8');
}

function getConflictDetail(root, filePath) {
  if (!inMerge(root)) {
    return null;
  }
  var ours = getOurs(root, filePath);
  var theirs = getTheirs(root, filePath);
  var base = getBase(root, filePath);
  var conflicted = getConflictedContent(root, filePath);
  var mergeInfo = getMergeBranches(root);
  return {
    ours: ours,
    theirs: theirs,
    base: base,
    conflicted: conflicted,
    branch: mergeInfo ? mergeInfo.branch : '',
    mergeBranch: mergeInfo ? mergeInfo.mergeBranch : ''
  };
}

function resolveFile(root, filePath) {
  var repoRoot = git.repoRoot(root);
  var detail = getConflictDetail(repoRoot, filePath);
  if (!detail) {
    throw new Error('Not in a merge state or file is not conflicted: ' + filePath);
  }
  var binding = config.readBinding(repoRoot);
  var selectedAgent = binding ? binding.agent : config.currentAgent();
  var prompt = prompts.mergeConflictPrompt({
    filePath: filePath,
    branch: detail.branch,
    mergeBranch: detail.mergeBranch,
    ours: detail.ours || '',
    theirs: detail.theirs || '',
    base: detail.base || '',
    conflicted: detail.conflicted || ''
  });
  var resolvedContent = agent.generateText(prompt, repoRoot, selectedAgent, {
    outputPrefix: 'gmc-merge-resolve',
    description: 'merge conflict resolution'
  });
  var fullPath = path.resolve(repoRoot, filePath);
  fs.writeFileSync(fullPath, resolvedContent, 'utf8');
  git.runGit(['add', '--', filePath], { cwd: repoRoot });
  return resolvedContent;
}

function resolveFileWithContent(root, filePath, content) {
  var repoRoot = git.repoRoot(root);
  var fullPath = path.resolve(repoRoot, filePath);
  fs.writeFileSync(fullPath, content, 'utf8');
  git.runGit(['add', '--', filePath], { cwd: repoRoot });
}

function validateResolution(filePath) {
  if (!fs.existsSync(filePath)) {
    return { valid: false, error: 'File not found: ' + filePath };
  }
  var content = fs.readFileSync(filePath, 'utf8');
  var conflictPattern = /^<{7}|^={7}|^>{7}/m;
  if (conflictPattern.test(content)) {
    return { valid: false, error: 'File still contains conflict markers' };
  }
  return { valid: true };
}

function isFullyResolved(root) {
  var conflicted = listConflictedFiles(root);
  return conflicted.length === 0;
}

module.exports = {
  inMerge: inMerge,
  getMergeBranches: getMergeBranches,
  listConflictedFiles: listConflictedFiles,
  getConflictDetail: getConflictDetail,
  resolveFile: resolveFile,
  resolveFileWithContent: resolveFileWithContent,
  validateResolution: validateResolution,
  isFullyResolved: isFullyResolved
};
