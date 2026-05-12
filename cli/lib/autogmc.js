'use strict';

var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');
var agent = require('./agent');
var config = require('./config');
var git = require('./git');
var prompts = require('./prompts');

var TASK_DIR = 'gmc/tasks';
var LOG_DIR = 'gmc/logs';
var PENDING_FILE = 'gmc/pending.json';
var LOCK_FILE = 'gmc/rewrite.lock';
var DIFF_LIMIT = 120000;
var STALE_GRACE_MS = 30 * 1000;
var LOCK_RETRY_MS = 2 * 1000;
var LOCK_EXTRA_WAIT_MS = 60 * 1000;

function commitMsgHook(messageFile) {
  var root = git.repoRoot(process.cwd());
  var message = cleanupCommitMessage(fs.readFileSync(messageFile, 'utf8'));
  if (message !== 'gmc') {
    return;
  }

  writeGitJson(root, PENDING_FILE, {
    status: 'pending',
    createdAt: new Date().toISOString(),
    messageFile: path.resolve(messageFile)
  });
}

function postCommitHook(scriptPath) {
  var root = git.repoRoot(process.cwd());
  var pending = readGitJson(root, PENDING_FILE);
  if (!pending) {
    return;
  }

  removeGitFile(root, PENDING_FILE);
  var targetOid = git.runGit(['rev-parse', 'HEAD'], { cwd: root });
  startTask(root, scriptPath, targetOid, pending.createdAt || new Date().toISOString());
}

function startTask(root, scriptPath, targetOid, createdAt) {
  writeTask(root, targetOid, {
    status: 'pending',
    targetOid: targetOid,
    createdAt: createdAt || new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    logPath: path.join(LOG_DIR, targetOid + '.log')
  });

  printPostCommitNotice(root, targetOid);

  var child = childProcess.spawn(process.execPath, [scriptPath, 'hook-worker', targetOid], {
    cwd: root,
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
}

function worker(targetOid) {
  var root = git.repoRoot(process.cwd());
  var logFile = gitFile(root, path.join(LOG_DIR, targetOid + '.log'));
  fs.mkdirSync(path.dirname(logFile), { recursive: true });

  return withLog(logFile, function (log) {
    var lockPath = gitFile(root, LOCK_FILE);
    var lockFd = waitForLock(root, lockPath, targetOid, log);
    if (lockFd === null) {
      return skip(root, targetOid, 'timed out waiting for another gmc rewrite task', log);
    }

    try {
      updateTask(root, targetOid, {
        status: 'running',
        startedAt: new Date().toISOString()
      });
      log('started background commit message generation for ' + targetOid);

      if (repositoryHasOperationInProgress(root)) {
        return skip(root, targetOid, 'repository has an operation in progress', log);
      }
      if (!commitExists(root, targetOid)) {
        return skip(root, targetOid, 'target commit no longer exists', log);
      }
      if (currentHead(root) !== targetOid) {
        return skip(root, targetOid, 'target commit is no longer HEAD', log);
      }
      if (commitHasSignature(root, targetOid)) {
        return skip(root, targetOid, 'signed commits are not rewritten automatically', log);
      }

      var binding = config.readBinding(root);
      var prompt = buildPrompt(root, targetOid, binding);
      log('requesting commit message from codex');
      var message = prompts.appendCreatedBy(
        agent.generateCommitMessage(prompt, root),
        binding ? binding.agent : config.currentAgent()
      );
      log('received commit message from codex');
      validateCommitMessage(message, binding);

      if (currentHead(root) !== targetOid) {
        return skip(root, targetOid, 'target commit changed while generating message', log);
      }

      var newOid = rewriteHeadMessage(root, targetOid, message);
      updateTask(root, targetOid, {
        status: 'done',
        completedAt: new Date().toISOString(),
        newOid: newOid,
        message: message
      });
      log('rewrote ' + targetOid + ' as ' + newOid);
    } catch (error) {
      updateTask(root, targetOid, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: error.message
      });
      log('failed: ' + (error.stack || error.message));
    } finally {
      releaseLock(lockFd, lockPath);
    }
  });
}

function buildPrompt(root, targetOid, binding) {
  var diff = git.runGit(['show', '--format=', '--no-ext-diff', '--find-renames', targetOid], { cwd: root });
  if (diff.length > DIFF_LIMIT) {
    diff = diff.slice(0, DIFF_LIMIT) + '\n\n[Diff truncated by gmc]\n';
  }

  return prompts.commitMessagePrompt(
    binding,
    diff,
    git.statusShort(root),
    git.recentCommitSubjects(root, 20),
    {
      changeDescription: 'committed changes',
      diffLabel: 'Committed diff'
    }
  );
}

function printPostCommitNotice(root, targetOid) {
  var shortOid = targetOid.slice(0, 12);
  var logPath = path.relative(root, gitFile(root, path.join(LOG_DIR, targetOid + '.log')));

  process.stderr.write([
    'GMC >>> Background AI summarization started. Generating commit message for this submission...',
    'GMC >>> git commit complete. You can continue working; the commit message will be updated automatically.',
    'GMC >>> If HEAD has moved, GMC will skip the update to avoid overwriting newer commits.',
    'GMC >>> Target commit: ' + shortOid,
    'GMC >>> Task log: ' + logPath,
    'GMC >>> View status: gmc status',
    ''
  ].join('\n'));
}

function rewriteHeadMessage(root, targetOid, message) {
  var info = git.runGit(['show', '-s', '--format=%T%x00%P%x00%an%x00%ae%x00%aI', targetOid], { cwd: root }).split('\x00');
  var tree = info[0];
  var parents = (info[1] || '').trim() ? info[1].trim().split(/\s+/) : [];
  var authorName = info[2] || '';
  var authorEmail = info[3] || '';
  var authorDate = info[4] || '';
  var messageFile = git.writeGitFile(root, 'gmc/generated-message-' + targetOid + '.txt', message);
  var args = ['commit-tree', tree];

  parents.forEach(function (parent) {
    args.push('-p', parent);
  });
  args.push('-F', messageFile);

  var env = Object.assign({}, process.env, {
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_AUTHOR_DATE: authorDate
  });
  var created = childProcess.spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: env
  });
  if (created.error) {
    throw created.error;
  }
  if (created.status !== 0) {
    throw new Error('git ' + args.join(' ') + ' failed: ' + (created.stderr || created.stdout || '').trim());
  }

  var newOid = (created.stdout || '').trim();
  git.runGit(['update-ref', '-m', 'gmc: replace generated commit message', 'HEAD', newOid, targetOid], { cwd: root });
  removeFile(messageFile);
  return newOid;
}

function validateCommitMessage(message, binding) {
  var text = String(message || '').trim();
  var firstLine = text.split(/\r?\n/)[0] || '';
  var forbiddenPatterns = [
    /OpenAI Codex/i,
    /User instructions:/i,
    /Staged diff:/i,
    /Committed diff:/i,
    /stream error:/i,
    /\bERROR:/i,
    /unexpected status \d+/i,
    /^-{8,}$/m,
    /^\[\d{4}-\d{2}-\d{2}T/m
  ];

  if (!text) {
    throw new Error('Codex returned an empty commit message.');
  }
  if (binding && text.indexOf('Issue: ' + binding.issue) < 0) {
    throw new Error('Generated commit message is missing required trailer: Issue: ' + binding.issue);
  }
  if (firstLine.length > 72) {
    throw new Error('Generated commit subject is longer than 72 characters: ' + firstLine);
  }
  forbiddenPatterns.forEach(function (pattern) {
    if (pattern.test(text)) {
      throw new Error('Generated commit message looks like Codex logs instead of a commit message. Aborting.');
    }
  });
}

function cleanupCommitMessage(message) {
  return String(message || '')
    .split(/\r?\n/)
    .filter(function (line) {
      return line.charAt(0) !== '#';
    })
    .join('\n')
    .trim();
}

function repositoryHasOperationInProgress(root) {
  var dir = git.gitDir(root);
  return [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'rebase-apply',
    'rebase-merge'
  ].some(function (relativePath) {
    return fs.existsSync(path.join(dir, relativePath));
  });
}

function commitExists(root, oid) {
  var result = git.runGit(['cat-file', '-e', oid + '^{commit}'], {
    cwd: root,
    allowFailure: true
  });
  return result.status === 0;
}

function currentHead(root) {
  return git.runGit(['rev-parse', 'HEAD'], { cwd: root });
}

function commitHasSignature(root, oid) {
  return /^gpgsig /m.test(git.runGit(['cat-file', '-p', oid], { cwd: root }));
}

function skip(root, targetOid, reason, log) {
  updateTask(root, targetOid, {
    status: 'skipped',
    completedAt: new Date().toISOString(),
    reason: reason
  });
  log('skipped: ' + reason);
}

function taskSummaries(root, limit) {
  limit = limit || 5;
  var dir = gitFile(root, TASK_DIR);
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs.readdirSync(dir)
    .filter(function (fileName) {
      return /\.json$/.test(fileName);
    })
    .map(function (fileName) {
      var oid = fileName.replace(/\.json$/, '');
      var task;
      try {
        task = readGitJson(root, path.join(TASK_DIR, fileName));
      } catch (error) {
        task = {
          status: 'invalid',
          targetOid: oid,
          error: 'Could not read task file: ' + error.message
        };
      }
      return summarizeTask(root, oid, task || {});
    })
    .sort(function (a, b) {
      return timestamp(b.createdAt || b.startedAt || b.completedAt) - timestamp(a.createdAt || a.startedAt || a.completedAt);
    })
    .slice(0, limit);
}

function summarizeTask(root, oid, task) {
  var logPath = task.logPath || path.join(LOG_DIR, oid + '.log');
  var status = task.status || 'unknown';
  var now = Date.now();
  var started = timestamp(task.startedAt);
  var waiting = timestamp(task.waitingAt);
  var timeoutMs = agent.codexTimeoutMs();
  var isStale = status === 'running' && started && now - started > staleAfterMs(timeoutMs);

  return {
    targetOid: task.targetOid || oid,
    shortOid: (task.targetOid || oid).slice(0, 12),
    status: isStale ? 'stale' : status,
    rawStatus: status,
    createdAt: task.createdAt || null,
    startedAt: task.startedAt || null,
    waitingAt: task.waitingAt || null,
    completedAt: task.completedAt || null,
    age: started || waiting ? formatDuration(now - (started || waiting)) : null,
    logPath: path.relative(root, gitFile(root, logPath)),
    message: task.message || null,
    error: task.error || null,
    reason: task.reason || null,
    newOid: task.newOid || null,
    timeoutSeconds: Math.round(timeoutMs / 1000)
  };
}

function timestamp(value) {
  if (!value) {
    return 0;
  }
  var parsed = Date.parse(value);
  return isNaN(parsed) ? 0 : parsed;
}

function formatDuration(ms) {
  if (!isFinite(ms) || ms < 0) {
    return '0s';
  }
  var seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return seconds + 's';
  }
  var minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return minutes + 'm ' + (seconds % 60) + 's';
  }
  var hours = Math.floor(minutes / 60);
  return hours + 'h ' + (minutes % 60) + 'm';
}

function waitForLock(root, lockPath, targetOid, log) {
  var deadline = Date.now() + lockWaitMs();
  var markedWaiting = false;

  while (true) {
    var lockFd = acquireLock(lockPath, targetOid);
    if (lockFd !== null) {
      return lockFd;
    }

    var lock = readLock(lockPath);
    if (isRecoverableLock(lock)) {
      recoverLock(root, lockPath, lock, targetOid, log);
      continue;
    }

    if (!markedWaiting) {
      updateTask(root, targetOid, {
        status: 'waiting',
        waitingAt: new Date().toISOString(),
        reason: lock && lock.pid ? 'waiting for gmc worker pid ' + lock.pid : 'waiting for gmc rewrite lock'
      });
      log('waiting for another gmc rewrite task to release the lock');
      markedWaiting = true;
    }

    if (Date.now() >= deadline) {
      return null;
    }
    sleep(LOCK_RETRY_MS);
  }
}

function acquireLock(lockPath, targetOid) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    var fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, JSON.stringify({
      version: 1,
      pid: process.pid,
      targetOid: targetOid,
      createdAt: new Date().toISOString(),
      timeoutMs: agent.codexTimeoutMs()
    }, null, 2) + '\n');
    return fd;
  } catch (error) {
    if (error.code === 'EEXIST') {
      return null;
    }
    throw error;
  }
}

function readLock(lockPath) {
  var stat;
  var text;
  try {
    stat = fs.statSync(lockPath);
    text = fs.readFileSync(lockPath, 'utf8').trim();
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    return {
      invalid: true,
      error: error.message,
      createdAt: new Date().toISOString(),
      ageMs: 0
    };
  }

  var lock;
  try {
    lock = JSON.parse(text);
  } catch (error) {
    lock = {
      version: 0,
      pid: Number(text) || null
    };
  }
  if (!lock || typeof lock !== 'object') {
    lock = {
      version: 0,
      pid: Number(text) || null
    };
  }

  var createdAt = lock.createdAt || stat.mtime.toISOString();
  var created = timestamp(createdAt) || stat.mtime.getTime();
  lock.createdAt = createdAt;
  lock.ageMs = Date.now() - created;
  lock.timeoutMs = lock.timeoutMs || agent.codexTimeoutMs();
  lock.alive = lock.pid ? processIsAlive(lock.pid) : false;
  return lock;
}

function isRecoverableLock(lock) {
  if (!lock) {
    return false;
  }
  if (lock.invalid || !lock.pid || !lock.alive) {
    return true;
  }
  if (lock.ageMs <= staleAfterMs(lock.timeoutMs)) {
    return false;
  }
  if (lock.version >= 1) {
    return true;
  }
  return processLooksLikeGmcWorker(lock.pid);
}

function recoverLock(root, lockPath, lock, targetOid, log) {
  var reason = lock && lock.pid
    ? 'stale gmc rewrite lock held by pid ' + lock.pid + ' for ' + formatDuration(lock.ageMs)
    : 'stale gmc rewrite lock without a live owner';

  if (lock && lock.pid && lock.alive && lock.pid !== process.pid) {
    terminateProcessGroup(lock.pid, log);
  }

  removeFile(lockPath);
  if (lock && lock.targetOid) {
    failTaskIfRunning(root, lock.targetOid, reason + '; recovered by ' + targetOid);
  } else {
    failExpiredRunningTasks(root, reason + '; recovered by ' + targetOid);
  }
  log('recovered ' + reason);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function processLooksLikeGmcWorker(pid) {
  var result = childProcess.spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    return false;
  }
  var command = result.stdout || '';
  return /hook-worker/.test(command) && /gmc/.test(command);
}

function terminateProcessGroup(pid, log) {
  try {
    process.kill(-pid, 'SIGTERM');
    sleep(1000);
    if (processIsAlive(pid)) {
      process.kill(-pid, 'SIGKILL');
    }
    log('terminated stale gmc worker process group ' + pid);
  } catch (error) {
    try {
      process.kill(pid, 'SIGTERM');
      log('terminated stale gmc worker process ' + pid);
    } catch (innerError) {
      log('could not terminate stale gmc worker pid ' + pid + ': ' + innerError.message);
    }
  }
}

function failTaskIfRunning(root, oid, reason) {
  var task = readGitJson(root, path.join(TASK_DIR, oid + '.json'));
  if (!task || (task.status !== 'running' && task.status !== 'waiting')) {
    return;
  }
  updateTask(root, oid, {
    status: 'failed',
    completedAt: new Date().toISOString(),
    error: reason
  });
}

function failExpiredRunningTasks(root, reason) {
  var dir = gitFile(root, TASK_DIR);
  if (!fs.existsSync(dir)) {
    return;
  }
  fs.readdirSync(dir).forEach(function (fileName) {
    if (!/\.json$/.test(fileName)) {
      return;
    }
    var oid = fileName.replace(/\.json$/, '');
    var task;
    try {
      task = readGitJson(root, path.join(TASK_DIR, fileName));
    } catch (error) {
      return;
    }
    if (!task || task.status !== 'running') {
      return;
    }
    var started = timestamp(task.startedAt);
    if (started && Date.now() - started > staleAfterMs(agent.codexTimeoutMs())) {
      updateTask(root, oid, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: reason
      });
    }
  });
}

function staleAfterMs(timeoutMs) {
  return timeoutMs + STALE_GRACE_MS;
}

function lockWaitMs() {
  return staleAfterMs(agent.codexTimeoutMs()) + LOCK_EXTRA_WAIT_MS;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function releaseLock(fd, lockPath) {
  if (fd === null) {
    return;
  }
  try {
    fs.closeSync(fd);
  } finally {
    removeFile(lockPath);
  }
}

function withLog(logFile, callback) {
  var stream = fs.createWriteStream(logFile, { flags: 'a' });
  function log(message) {
    stream.write('[' + new Date().toISOString() + '] ' + message + '\n');
  }
  try {
    return callback(log);
  } finally {
    stream.end();
  }
}

function writeTask(root, oid, task) {
  writeGitJson(root, path.join(TASK_DIR, oid + '.json'), task);
}

function updateTask(root, oid, updates) {
  var relativePath = path.join(TASK_DIR, oid + '.json');
  var task = readGitJson(root, relativePath) || {
    targetOid: oid
  };
  Object.keys(updates).forEach(function (key) {
    task[key] = updates[key];
  });
  writeGitJson(root, relativePath, task);
}

function readGitJson(root, relativePath) {
  var filePath = gitFile(root, relativePath);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeGitJson(root, relativePath, value) {
  var filePath = gitFile(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function removeGitFile(root, relativePath) {
  removeFile(gitFile(root, relativePath));
}

function removeFile(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function gitFile(root, relativePath) {
  return path.join(git.gitDir(root), relativePath);
}

module.exports = {
  commitMsgHook: commitMsgHook,
  postCommitHook: postCommitHook,
  startTask: startTask,
  worker: worker,
  taskSummaries: taskSummaries
};
