'use strict';

var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');

function runGit(args, options) {
  options = options || {};
  var result = childProcess.spawnSync('git', args, {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8'
  });

  if (options.allowFailure) {
    return result;
  }

  if (result.status !== 0) {
    var message = (result.stderr || result.stdout || '').trim();
    throw new Error('git ' + args.join(' ') + ' failed' + (message ? ': ' + message : ''));
  }

  return (result.stdout || '').trim();
}

function repoRoot(cwd) {
  return runGit(['rev-parse', '--show-toplevel'], { cwd: cwd });
}

function gitDir(cwd) {
  var root = repoRoot(cwd);
  var dir = runGit(['rev-parse', '--git-dir'], { cwd: root });
  if (path.isAbsolute(dir)) {
    return dir;
  }
  return path.resolve(root, dir);
}

function currentBranch(cwd) {
  return runGit(['branch', '--show-current'], { cwd: repoRoot(cwd) });
}

function originUrl(cwd) {
  return runGit(['remote', 'get-url', 'origin'], { cwd: repoRoot(cwd) });
}

function parseGitHubRemote(remoteUrl) {
  var match = remoteUrl.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (!match) {
    match = remoteUrl.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  }
  if (!match) {
    return null;
  }
  return {
    owner: match[1],
    repo: match[2]
  };
}

function getConfig(key, cwd) {
  var result = runGit(['config', '--local', '--get', key], {
    cwd: repoRoot(cwd),
    allowFailure: true
  });
  if (result.status !== 0) {
    return null;
  }
  return (result.stdout || '').trim() || null;
}

function setConfig(key, value, cwd) {
  return runGit(['config', '--local', key, value], { cwd: repoRoot(cwd) });
}

function branchExists(branch, cwd) {
  var result = runGit(['rev-parse', '--verify', 'refs/heads/' + branch], {
    cwd: repoRoot(cwd),
    allowFailure: true
  });
  return result.status === 0;
}

function ensureBranch(branch, cwd) {
  var root = repoRoot(cwd);
  if (currentBranch(root) === branch) {
    return branch;
  }
  if (branchExists(branch, root)) {
    runGit(['switch', branch], { cwd: root });
  } else {
    runGit(['switch', '-c', branch], { cwd: root });
  }
  return branch;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function branchName(issueRef, title) {
  var slug = slugify(title);
  return 'codex/' + issueRef + (slug ? '-' + slug : '');
}

function hasStagedDiff(cwd) {
  var result = runGit(['diff', '--cached', '--quiet'], {
    cwd: repoRoot(cwd),
    allowFailure: true
  });
  return result.status === 1;
}

function stagedDiff(cwd) {
  return runGit(['diff', '--cached', '--no-ext-diff'], { cwd: repoRoot(cwd) });
}

function statusShort(cwd) {
  return runGit(['status', '--short'], { cwd: repoRoot(cwd) });
}

function recentCommitSubjects(cwd, count) {
  count = count || 20;
  var result = runGit(['log', '-' + count, '--pretty=format:%s'], {
    cwd: repoRoot(cwd),
    allowFailure: true
  });
  if (result.status !== 0) {
    return '';
  }
  return (result.stdout || '').trim();
}

function writeGitFile(cwd, relativePath, content) {
  var dir = gitDir(cwd);
  var filePath = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function readJsonGitFile(cwd, relativePath) {
  var dir = gitDir(cwd);
  var filePath = path.join(dir, relativePath);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

module.exports = {
  runGit: runGit,
  repoRoot: repoRoot,
  gitDir: gitDir,
  currentBranch: currentBranch,
  originUrl: originUrl,
  parseGitHubRemote: parseGitHubRemote,
  getConfig: getConfig,
  setConfig: setConfig,
  branchExists: branchExists,
  ensureBranch: ensureBranch,
  branchName: branchName,
  hasStagedDiff: hasStagedDiff,
  stagedDiff: stagedDiff,
  statusShort: statusShort,
  recentCommitSubjects: recentCommitSubjects,
  writeGitFile: writeGitFile,
  readJsonGitFile: readJsonGitFile
};
