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

function getGlobalConfig(key) {
  var result = runGit(['config', '--global', '--get', key], {
    allowFailure: true
  });
  if (result.status !== 0) {
    return null;
  }
  return (result.stdout || '').trim() || null;
}

function setGlobalConfig(key, value) {
  return runGit(['config', '--global', key, value]);
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

function getDefaultBranch(cwd) {
  var root = repoRoot(cwd);
  var ref = runGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
    cwd: root,
    allowFailure: true
  });
  if (ref.status === 0 && ref.stdout) {
    var remoteHead = (ref.stdout || '').trim();
    if (remoteHead) {
      return remoteHead.replace(/^origin\//, '');
    }
  }
  if (branchExists('main', root)) {
    return 'main';
  }
  if (branchExists('master', root)) {
    return 'master';
  }
  var cur = currentBranch(root);
  return cur || 'main';
}

function getCleanableBranches(cwd, options) {
  options = options || {};
  var root = repoRoot(cwd);
  var baseBranch = options.baseBranch || getDefaultBranch(root);

  if (options.fetchPrune) {
    runGit(['fetch', '--prune'], { cwd: root, allowFailure: true });
  }

  var cur = currentBranch(root);

  var mergedSet = {};
  var mergedOutput = runGit(['branch', '--merged', baseBranch, '--format=%(refname:short)'], {
    cwd: root,
    allowFailure: true
  });
  if (mergedOutput.status === 0 && mergedOutput.stdout) {
    mergedOutput.stdout.split(/\r?\n/).forEach(function (name) {
      var trimmed = name.trim();
      if (trimmed) {
        mergedSet[trimmed] = true;
      }
    });
  }

  var branchesOutput = runGit([
    'for-each-ref',
    'refs/heads/',
    '--format=%(refname:short)|%(upstream:short)|%(upstream:track)|%(committerdate:relative)|%(objectname:short)|%(subject)'
  ], { cwd: root, allowFailure: true });

  var list = [];
  var mergedCount = 0;
  var goneCount = 0;
  var unmergedCount = 0;
  var protectedCount = 0;
  var cleanableCount = 0;

  if (branchesOutput.status === 0 && branchesOutput.stdout) {
    branchesOutput.stdout.split(/\r?\n/).forEach(function (line) {
      if (!line.trim()) return;
      var parts = line.split('|');
      var name = parts[0] || '';
      var upstream = parts[1] || null;
      var track = parts[2] || '';
      var updated = parts[3] || '';
      var hash = parts[4] || '';
      var subject = parts.slice(5).join('|') || '';

      if (!name) return;

      var isCurrent = (name === cur);
      var isBase = (name === baseBranch);
      var isProtected = isCurrent || isBase || /^(main|master|develop|dev|release(\/.*)?)$/.test(name);
      var isMerged = !!mergedSet[name] && !isBase;
      var isGone = track.indexOf('[gone') >= 0;

      var status = 'unmerged';
      if (isProtected) {
        status = 'protected';
        protectedCount++;
      } else if (isMerged) {
        status = 'merged';
        mergedCount++;
      } else if (isGone) {
        status = 'gone';
        goneCount++;
      } else {
        unmergedCount++;
      }

      var canClean = !isProtected && (isMerged || isGone);
      if (canClean) {
        cleanableCount++;
      }

      list.push({
        name: name,
        upstream: upstream,
        track: track,
        updated: updated,
        hash: hash,
        subject: subject,
        isCurrent: isCurrent,
        isBase: isBase,
        isProtected: isProtected,
        isMerged: isMerged,
        isGone: isGone,
        status: status,
        canClean: canClean
      });
    });
  }

  return {
    baseBranch: baseBranch,
    currentBranch: cur,
    branches: list,
    summary: {
      total: list.length,
      mergedCount: mergedCount,
      goneCount: goneCount,
      unmergedCount: unmergedCount,
      protectedCount: protectedCount,
      cleanableCount: cleanableCount
    }
  };
}

function deleteBranches(cwd, branchNames, options) {
  options = options || {};
  var root = repoRoot(cwd);
  var force = !!options.force;
  var cur = currentBranch(root);
  var defaultBranch = getDefaultBranch(root);

  if (!Array.isArray(branchNames) || !branchNames.length) {
    throw new Error('No branches specified for deletion');
  }

  var deleted = [];
  var failed = [];

  branchNames.forEach(function (name) {
    var branchName = String(name || '').trim();
    if (!branchName) return;

    if (branchName === cur) {
      failed.push({
        name: branchName,
        error: 'Cannot delete current active branch (' + cur + ')',
        success: false
      });
      return;
    }

    if (branchName === defaultBranch || branchName === 'main' || branchName === 'master') {
      failed.push({
        name: branchName,
        error: 'Cannot delete protected default branch (' + branchName + ')',
        success: false
      });
      return;
    }

    var hashRes = runGit(['rev-parse', '--short', 'refs/heads/' + branchName], {
      cwd: root,
      allowFailure: true
    });
    var hash = (hashRes.status === 0 && hashRes.stdout) ? hashRes.stdout.trim() : '';

    var result = runGit(['branch', force ? '-D' : '-d', branchName], {
      cwd: root,
      allowFailure: true
    });

    if (result.status === 0) {
      deleted.push({
        name: branchName,
        hash: hash,
        success: true
      });
    } else {
      var err = (result.stderr || result.stdout || '').trim() || 'git branch delete failed';
      failed.push({
        name: branchName,
        hash: hash,
        error: err,
        success: false
      });
    }
  });

  return {
    deleted: deleted,
    failed: failed,
    totalDeleted: deleted.length,
    totalFailed: failed.length
  };
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
  getGlobalConfig: getGlobalConfig,
  setGlobalConfig: setGlobalConfig,
  branchExists: branchExists,
  ensureBranch: ensureBranch,
  branchName: branchName,
  hasStagedDiff: hasStagedDiff,
  stagedDiff: stagedDiff,
  statusShort: statusShort,
  recentCommitSubjects: recentCommitSubjects,
  writeGitFile: writeGitFile,
  readJsonGitFile: readJsonGitFile,
  getDefaultBranch: getDefaultBranch,
  getCleanableBranches: getCleanableBranches,
  deleteBranches: deleteBranches
};

