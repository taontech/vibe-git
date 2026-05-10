'use strict';

var childProcess = require('child_process');
var fs = require('fs');
var http = require('http');
var path = require('path');
var url = require('url');
var autogmc = require('./autogmc');
var config = require('./config');
var git = require('./git');

var DEFAULT_PORT = 4277;
var GITWEB_VERSION = 2;

function start(root, options) {
  options = options || {};

  var requestedPort = normalizePort(options.port || process.env.GMC_GITWEB_PORT || DEFAULT_PORT);
  return listen(requestedPort, 0).then(function (serverInfo) {
    var address = 'http://127.0.0.1:' + serverInfo.port + '/?repo=' + encodeURIComponent(root);
    if (!options.noOpen) {
      openBrowser(address);
    }
    return {
      url: address,
      server: serverInfo.server,
      port: serverInfo.port
    };
  });
}

function listen(port, attempt) {
  return new Promise(function (resolve, reject) {
    var server = http.createServer(function (req, res) {
      handleRequest(req, res);
    });
    server.on('error', function (error) {
      if (error.code === 'EADDRINUSE' && attempt < 20) {
        listen(port + 1, attempt + 1).then(resolve, reject);
        return;
      }
      reject(error);
    });
    server.listen(port, '127.0.0.1', function () {
      resolve({
        server: server,
        port: server.address().port
      });
    });
  });
}

function normalizePort(value) {
  var port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid GitWeb port: ' + value);
  }
  return port;
}

function checkRunning(port) {
  return new Promise(function (resolve) {
    var req = http.get('http://127.0.0.1:' + port + '/api/ping', function (res) {
      var body = '';
      res.on('data', function (chunk) { body += chunk; });
      res.on('end', function () {
        try {
          var data = JSON.parse(body);
          resolve(data.service === 'gmc-gitweb' && data.gitwebVersion === GITWEB_VERSION);
        } catch (e) {
          resolve(false);
        }
      });
    });
    req.on('error', function () {
      resolve(false);
    });
    req.setTimeout(500, function () {
      req.destroy();
      resolve(false);
    });
  });
}

function resolveWeblocPort(port) {
  port = normalizePort(port || DEFAULT_PORT);
  return checkRunning(port).then(function (running) {
    if (running) {
      return port;
    }
    return findAvailablePort(port, 0);
  });
}

function findAvailablePort(port, attempt) {
  return new Promise(function (resolve, reject) {
    var server = http.createServer();
    server.on('error', function (error) {
      if (error.code === 'EADDRINUSE' && attempt < 20) {
        findAvailablePort(port + 1, attempt + 1).then(resolve, reject);
        return;
      }
      reject(error);
    });
    server.listen(port, '127.0.0.1', function () {
      var selected = server.address().port;
      server.close(function () {
        resolve(selected);
      });
    });
  });
}

function handleRequest(req, res) {
  try {
    var parsed = url.parse(req.url, true);
    if (req.method === 'POST') {
      if (parsed.pathname === '/api/commit-selected') {
        handleCommitSelected(req, res, parsed.query.repo);
        return;
      }
      if (parsed.pathname === '/api/ignore-selected') {
        handleIgnoreSelected(req, res, parsed.query.repo);
        return;
      }
      if (parsed.pathname === '/api/restore-selected') {
        handleRestoreSelected(req, res, parsed.query.repo);
        return;
      }
      if (parsed.pathname === '/api/push') {
        handlePush(req, res, parsed.query.repo);
        return;
      }
      if (parsed.pathname === '/api/pull') {
        handlePull(req, res, parsed.query.repo);
        return;
      }
      send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
      return;
    }

    if (req.method !== 'GET') {
      send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
      return;
    }

    if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
      send(res, 200, 'text/html; charset=utf-8', webHtml());
      return;
    }

    if (parsed.pathname === '/api/ping') {
      sendJson(res, { status: 'ok', service: 'gmc-gitweb', gitwebVersion: GITWEB_VERSION });
      return;
    }

    var targetRepo = parsed.query.repo;
    if (!targetRepo) {
      if (parsed.pathname.startsWith('/api/')) {
        throwHttpError('Missing repo parameter');
      }
      return;
    }

    if (parsed.pathname === '/api/status') {
      sendJson(res, collectStatus(targetRepo));
      return;
    }

    if (parsed.pathname === '/api/commit') {
      sendJson(res, commitDetails(targetRepo, parsed.query.oid));
      return;
    }

    send(res, 404, 'text/plain; charset=utf-8', 'Not found');
  } catch (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  }
}

function handleCommitSelected(req, res, targetRepo) {
  if (!targetRepo) {
    sendJsonError(res, 400, 'Missing repo parameter');
    return;
  }

  readJsonBody(req).then(function (body) {
    sendJson(res, commitSelectedFiles(targetRepo, body.files));
  }).catch(function (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  });
}

function handleIgnoreSelected(req, res, targetRepo) {
  if (!targetRepo) {
    sendJsonError(res, 400, 'Missing repo parameter');
    return;
  }

  readJsonBody(req).then(function (body) {
    sendJson(res, ignoreSelectedFiles(targetRepo, body.files));
  }).catch(function (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  });
}

function handleRestoreSelected(req, res, targetRepo) {
  if (!targetRepo) return sendJsonError(res, 400, 'Missing repo parameter');
  readJsonBody(req).then(function (body) {
    sendJson(res, restoreSelectedFiles(targetRepo, body.files));
  }).catch(function (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  });
}

function handlePush(req, res, targetRepo) {
  if (!targetRepo) return sendJsonError(res, 400, 'Missing repo parameter');
  var repoRoot = git.repoRoot(targetRepo);
  var result = childProcess.spawnSync('git', ['push'], { cwd: repoRoot, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    var errorMsg = (result.stderr || result.stdout || result.error && result.error.message || 'git push failed').trim();
    return sendJsonError(res, 400, errorMsg);
  }
  sendJson(res, { status: 'ok', output: ((result.stdout || '') + (result.stderr || '')).trim() });
}

function handlePull(req, res, targetRepo) {
  if (!targetRepo) return sendJsonError(res, 400, 'Missing repo parameter');
  var repoRoot = git.repoRoot(targetRepo);
  var result = childProcess.spawnSync('git', ['pull'], { cwd: repoRoot, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    var errorMsg = (result.stderr || result.stdout || result.error && result.error.message || 'git pull failed').trim();
    return sendJsonError(res, 400, errorMsg);
  }
  sendJson(res, { status: 'ok', output: ((result.stdout || '') + (result.stderr || '')).trim() });
}

function readJsonBody(req) {
  return new Promise(function (resolve, reject) {
    var body = '';
    req.on('data', function (chunk) {
      body += chunk;
      if (body.length > 65536) {
        var error = new Error('Request body is too large');
        error.httpStatus = 413;
        reject(error);
        req.destroy();
      }
    });
    req.on('end', function () {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        error.httpStatus = 400;
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, payload) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function sendJsonError(res, status, message) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify({
    error: message
  }));
}

function send(res, status, type, body) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function collectStatus(root) {
  var branch = git.currentBranch(root) || '(detached)';
  var upstream = runGitOptional(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  var status = parseStatusOutput(runGitOptional(root, ['status', '--porcelain=v1', '-b', '-z']));
  var remote = runGitOptional(root, ['remote', 'get-url', 'origin']);
  var aheadBehind = upstream ? parseAheadBehind(runGitOptional(root, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'])) : {
    ahead: 0,
    behind: 0
  };

  return {
    generatedAt: new Date().toISOString(),
    repository: {
      root: root,
      gitDir: git.gitDir(root),
      remote: remote || null
    },
    branch: {
      current: branch,
      upstream: upstream || null,
      ahead: aheadBehind.ahead,
      behind: aheadBehind.behind
    },
    status: status,
    stats: {
      worktree: runGitOptional(root, ['diff', '--stat']),
      staged: runGitOptional(root, ['diff', '--cached', '--stat'])
    },
    branches: branches(root),
    commits: commits(root, 44),
    contributions: contributions(root),
    binding: safeBinding(root),
    tasks: safeTasks(root)
  };
}

function parseStatus(lines) {
  var files = [];
  var staged = 0;
  var unstaged = 0;
  var untracked = 0;
  lines.forEach(function (line) {
    if (line.indexOf('## ') === 0) {
      return;
    }
    var index = line.charAt(0);
    var worktree = line.charAt(1);
    var filePath = line.slice(3);
    if (index !== ' ' && index !== '?') {
      staged++;
    }
    if (worktree !== ' ') {
      unstaged++;
    }
    if (index === '?' && worktree === '?') {
      untracked++;
    }
    var displayPath = filePath;
    var originalPath = null;
    var renameSeparator = filePath.indexOf(' -> ');
    if ((index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') && renameSeparator >= 0) {
      originalPath = filePath.slice(0, renameSeparator);
      filePath = filePath.slice(renameSeparator + 4);
    }
    files.push({
      index: index,
      worktree: worktree,
      code: line.slice(0, 2),
      path: filePath,
      originalPath: originalPath,
      displayPath: displayPath
    });
  });
  return {
    clean: files.length === 0,
    staged: staged,
    unstaged: unstaged,
    untracked: untracked,
    files: files
  };
}

function parseStatusOutput(output) {
  if (!output) {
    return parseStatus([]);
  }

  var entries = String(output).split('\0');
  var files = [];
  var staged = 0;
  var unstaged = 0;
  var untracked = 0;

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (!entry || entry.indexOf('## ') === 0) {
      continue;
    }

    var index = entry.charAt(0);
    var worktree = entry.charAt(1);
    var filePath = entry.slice(3);
    var originalPath = null;
    if (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') {
      originalPath = entries[++i] || null;
    }

    if (index !== ' ' && index !== '?') {
      staged++;
    }
    if (worktree !== ' ') {
      unstaged++;
    }
    if (index === '?' && worktree === '?') {
      untracked++;
    }

    files.push({
      index: index,
      worktree: worktree,
      code: entry.slice(0, 2),
      path: filePath,
      originalPath: originalPath,
      displayPath: originalPath ? (originalPath + ' -> ' + filePath) : filePath
    });
  }

  return {
    clean: files.length === 0,
    staged: staged,
    unstaged: unstaged,
    untracked: untracked,
    files: files
  };
}

function parseAheadBehind(value) {
  var parts = String(value || '').trim().split(/\s+/);
  return {
    ahead: Number(parts[0] || 0),
    behind: Number(parts[1] || 0)
  };
}

function branches(root) {
  var output = runGitOptional(root, [
    'branch',
    '--all',
    '--format=%(HEAD)|%(refname)|%(refname:short)|%(upstream:short)|%(committerdate:relative)|%(objectname)|%(subject)'
  ]);
  if (!output) {
    return [];
  }
  return output.split(/\r?\n/).filter(Boolean).map(function (line) {
    var parts = line.split('|');
    var fullName = parts[1] || '';
    var name = parts[2] || '';
    return {
      current: parts[0] === '*',
      name: name,
      upstream: parts[3] || null,
      updated: parts[4] || '',
      hash: parts[5] || '',
      subject: parts.slice(6).join('|') || '',
      remote: fullName.indexOf('refs/remotes/') === 0
    };
  });
}

function commits(root, count) {
  var output = runGitOptional(root, [
    'log',
    '--all',
    '-200',
    '--date-order',
    '--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%P%x1f%b%x1e'
  ]);
  if (!output) {
    return [];
  }
  return output.split('\x1e').filter(function (entry) {
    return entry.trim();
  }).map(function (entry) {
    var clean = entry.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    var parts = clean.split('\x1f');
    var parents = (parts[5] || '').split(' ').filter(Boolean);
    return {
      hash: parts[0] || '',
      shortHash: parts[1] || '',
      author: parts[2] || '',
      date: parts[3] || '',
      subject: parts[4] || '',
      parents: parents,
      body: parts.slice(6).join('\x1f').trim()
    };
  });
}

function contributions(root) {
  var output = runGitOptional(root, ['log', '--all', '--since=1.year', '--format=%ad', '--date=short']);
  if (!output) return {};
  var counts = {};
  output.split(/\r?\n/).forEach(function (d) {
    if (d) counts[d] = (counts[d] || 0) + 1;
  });
  return counts;
}

function commitDetails(root, oid) {
  var value = String(oid || '');
  if (!/^[0-9a-fA-F]{4,40}$/.test(value)) {
    throwHttpError('Invalid commit id');
  }
  return {
    oid: value,
    message: runGitOptional(root, ['show', '-s', '--format=%B', value]),
    stat: runGitOptional(root, ['show', '--stat', '--format=', value])
  };
}

function commitSelectedFiles(root, selectedFiles) {
  var repoRoot = git.repoRoot(root);
  if (!Array.isArray(selectedFiles) || !selectedFiles.length) {
    throwHttpError('Select at least one changed file to commit.');
  }

  var changedFiles = parseStatusOutput(runGitOptional(repoRoot, ['status', '--porcelain=v1', '-b', '-z'])).files;
  var allowed = {};
  changedFiles.forEach(function (file) {
    allowed[file.path] = file;
  });

  var files = [];
  var gitPaths = [];
  selectedFiles.forEach(function (filePath) {
    var cleanPath = String(filePath || '').trim();
    if (!cleanPath || path.isAbsolute(cleanPath) || cleanPath.indexOf('\0') >= 0 || !allowed[cleanPath]) {
      throwHttpError('Invalid or unchanged file selection: ' + cleanPath);
    }
    if (files.indexOf(cleanPath) < 0) {
      files.push(cleanPath);
      if (allowed[cleanPath].originalPath && gitPaths.indexOf(allowed[cleanPath].originalPath) < 0) {
        gitPaths.push(allowed[cleanPath].originalPath);
      }
      if (gitPaths.indexOf(cleanPath) < 0) {
        gitPaths.push(cleanPath);
      }
    }
  });

  git.runGit(['add', '-A', '--'].concat(gitPaths), { cwd: repoRoot });
  var stagedCheck = git.runGit(['diff', '--cached', '--quiet', '--'].concat(gitPaths), {
    cwd: repoRoot,
    allowFailure: true
  });
  if (stagedCheck.status === 0) {
    throwHttpError('Selected files have no staged changes.');
  }

  var result = childProcess.spawnSync('git', ['commit', '-m', 'gmc', '--'].concat(gitPaths), {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    var message = (result.stderr || result.stdout || '').trim();
    var error = new Error(message || 'git commit failed');
    error.httpStatus = 400;
    throw error;
  }

  return {
    status: 'ok',
    oid: runGitOptional(repoRoot, ['rev-parse', 'HEAD']),
    output: ((result.stdout || '') + (result.stderr || '')).trim(),
    tasks: safeTasks(repoRoot)
  };
}

function ignoreSelectedFiles(root, selectedFiles) {
  var repoRoot = git.repoRoot(root);
  if (!Array.isArray(selectedFiles) || !selectedFiles.length) {
    throwHttpError('Select at least one untracked file to ignore.');
  }

  var changedFiles = parseStatusOutput(runGitOptional(repoRoot, ['status', '--porcelain=v1', '-b', '-z'])).files;
  var allowed = {};
  changedFiles.forEach(function (file) {
    allowed[file.path] = file;
  });

  var ignored = [];
  selectedFiles.forEach(function (filePath) {
    var cleanPath = String(filePath || '').trim();
    var file = allowed[cleanPath];
    if (!cleanPath || path.isAbsolute(cleanPath) || cleanPath.indexOf('\0') >= 0 || !file) {
      throwHttpError('Invalid or unchanged file selection: ' + cleanPath);
    }
    if (file.code !== '??') {
      throwHttpError('Only untracked files can be ignored from GitWeb: ' + cleanPath);
    }
    if (ignored.indexOf(cleanPath) < 0) {
      ignored.push(cleanPath);
    }
  });

  var gitignorePath = path.join(repoRoot, '.gitignore');
  var existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  var existingLines = existing.split(/\r?\n/);
  var additions = ignored.map(gitignorePatternForPath).filter(function (pattern) {
    return existingLines.indexOf(pattern) < 0;
  });

  if (additions.length) {
    var prefix = existing && !/\r?\n$/.test(existing) ? '\n' : '';
    fs.writeFileSync(gitignorePath, existing + prefix + additions.join('\n') + '\n');
  }

  return {
    status: 'ok',
    ignored: ignored,
    added: additions,
    gitignore: gitignorePath
  };
}

function restoreSelectedFiles(root, selectedFiles) {
  var repoRoot = git.repoRoot(root);
  if (!Array.isArray(selectedFiles) || !selectedFiles.length) {
    throwHttpError('Select at least one file to restore.');
  }

  var changedFiles = parseStatusOutput(runGitOptional(repoRoot, ['status', '--porcelain=v1', '-b', '-z'])).files;
  var allowed = {};
  changedFiles.forEach(function (file) { allowed[file.path] = file; });

  var tracked = [];
  var untracked = [];

  selectedFiles.forEach(function (filePath) {
    var cleanPath = String(filePath || '').trim();
    var file = allowed[cleanPath];
    if (!cleanPath || path.isAbsolute(cleanPath) || cleanPath.indexOf('\0') >= 0 || !file) {
      throwHttpError('Invalid or unchanged file selection: ' + cleanPath);
    }
    if (file.code === '??') untracked.push(cleanPath);
    else tracked.push(cleanPath);
  });

  if (tracked.length) {
    var restoreRes = childProcess.spawnSync('git', ['restore', '--staged', '--worktree', '--'].concat(tracked), { cwd: repoRoot, encoding: 'utf8' });
    if (restoreRes.error || restoreRes.status !== 0) {
      throwHttpError('Failed to restore files: ' + ((restoreRes.stderr || restoreRes.stdout || '').trim()));
    }
  }

  if (untracked.length) {
    var cleanRes = childProcess.spawnSync('git', ['clean', '-fd', '--'].concat(untracked), { cwd: repoRoot, encoding: 'utf8' });
    if (cleanRes.error || cleanRes.status !== 0) {
      throwHttpError('Failed to clean untracked files: ' + ((cleanRes.stderr || cleanRes.stdout || '').trim()));
    }
  }

  return { status: 'ok', restored: tracked.concat(untracked) };
}

function gitignorePatternForPath(filePath) {
  return '/' + String(filePath).replace(/\\/g, '/');
}

function safeBinding(root) {
  try {
    return config.readBinding(root);
  } catch (error) {
    return null;
  }
}

function safeTasks(root) {
  try {
    return autogmc.taskSummaries(root, 8);
  } catch (error) {
    return [];
  }
}

function runGitOptional(root, args) {
  var result = git.runGit(args, {
    cwd: root,
    allowFailure: true
  });
  if (result.status !== 0) {
    return '';
  }
  return (result.stdout || '').trim();
}

function throwHttpError(message) {
  var error = new Error(message);
  error.httpStatus = 400;
  throw error;
}

function openBrowser(address) {
  var command;
  var args;
  if (process.platform === 'darwin') {
    command = 'open';
    args = [address];
  } else if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', address];
  } else {
    command = 'xdg-open';
    args = [address];
  }
  var child = childProcess.spawn(command, args, {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
}

function createWebloc(root, options) {
  options = options || {};
  var repoRoot = git.repoRoot(root);
  var port = normalizePort(options.port || process.env.GMC_GITWEB_PORT || DEFAULT_PORT);
  var address = 'http://127.0.0.1:' + port + '/?repo=' + encodeURIComponent(repoRoot);
  var linkPath = path.join(repoRoot, 'git.webloc');
  var content = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"',
    '  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>URL</key>',
    '  <string>' + escapeXml(address) + '</string>',
    '</dict>',
    '</plist>'
  ].join('\n') + '\n';

  fs.writeFileSync(linkPath, content);
  return linkPath;
}

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, function (ch) {
    return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[ch];
  });
}

function webHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GMC GitWeb</title>
<style>
:root {
  color-scheme: light;
  --bg: #f4f6f8;
  --panel: #ffffff;
  --panel-soft: #f8fafc;
  --text: #111827;
  --muted: #6b7280;
  --line: #dbe2ea;
  --line-soft: #edf1f5;
  --accent: #2563eb;
  --accent-soft: #eff6ff;
  --green: #0f9f6e;
  --rose: #dc2626;
  --amber: #b45309;
  --shadow: 0 18px 48px rgba(15, 23, 42, .12);
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text); font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body { background: linear-gradient(180deg, #ffffff 0, var(--bg) 280px); }
.shell { width: min(1480px, calc(100vw - 32px)); margin: 0 auto; padding: 24px 0 32px; }
.topbar { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 18px; }
h1 { margin: 0; font-size: 22px; font-weight: 760; letter-spacing: 0; }
h2 { margin: 0; font-size: 12px; color: #475569; text-transform: uppercase; letter-spacing: .08em; }
.repo { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: min(920px, 64vw); }
.actions { display: flex; gap: 8px; }
.actions button, .commit-button, .ignore-button { border: 1px solid var(--line); background: var(--panel); color: var(--text); border-radius: 7px; min-height: 34px; padding: 7px 12px; cursor: pointer; font-weight: 650; }
.actions button:hover, .commit-button:hover:not(:disabled), .ignore-button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
.commit-button { background: var(--accent); border-color: var(--accent); color: #fff; }
.commit-button:hover:not(:disabled) { color: #fff; background: #1d4ed8; }
.ignore-button { color: var(--rose); }
.ignore-button:hover:not(:disabled) { border-color: var(--rose); color: var(--rose); background: #fef2f2; }
.commit-button:disabled, .ignore-button:disabled { opacity: .45; cursor: not-allowed; }
.grid { display: grid; grid-template-columns: minmax(0, 1fr) 440px; gap: 16px; align-items: start; }
.panel { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 16px; box-shadow: 0 1px 2px rgba(15, 23, 42, .04); }
.summary-panel { display: grid; grid-template-columns: minmax(0, 1fr) 440px; gap: 16px; margin-bottom: 16px; align-items: stretch; }
.branch-name { font-size: 32px; font-weight: 780; margin: 3px 0 2px; letter-spacing: 0; overflow-wrap: anywhere; }
.meters { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; height: 100%; }
.meter { padding: 12px; border-radius: 8px; background: var(--panel-soft); border: 1px solid var(--line-soft); position: relative; }
.meter strong { display: block; font-size: 24px; color: var(--accent); line-height: 1.1; }
.meter span { font-size: 12px; color: var(--muted); }
.meter .action-btn { position: absolute; right: 12px; top: 12px; font-size: 11px; padding: 3px 8px; border-radius: 4px; border: 1px solid var(--line); background: #fff; cursor: pointer; color: var(--text); font-weight: 600; }
.meter .action-btn:hover { border-color: var(--accent); color: var(--accent); }
.panel-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; }
.timeline-container { --graph-width: 30px; display: grid; grid-template-columns: var(--graph-width) minmax(0, 1fr); column-gap: 6px; align-items: flex-start; position: relative; height: min(66vh, 680px); min-height: 430px; overflow: auto; border: 1px solid var(--line-soft); border-radius: 8px; background: linear-gradient(90deg, #fbfdff 0, #fbfdff calc(var(--graph-width) + 10px), #ffffff calc(var(--graph-width) + 10px)); padding: 10px 10px 10px 4px; }
#graph { width: var(--graph-width); min-width: var(--graph-width); pointer-events: auto; overflow: visible; }
.timeline { display: grid; gap: 9px; min-width: 0; padding-right: 2px; }
.commit { display: grid; grid-template-columns: 58px minmax(0, 1fr); gap: 10px; padding: 6px 12px; border: 1px solid var(--line-soft); border-radius: 8px; background: #fff; cursor: default; transition: background .16s, border-color .16s, box-shadow .16s, transform .16s; min-height: 48px; }
.commit:hover { background: var(--accent-soft); border-color: #bfdbfe; box-shadow: 0 8px 22px rgba(37, 99, 235, .10); transform: translateY(-1px); }
.hash { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 700; align-self: center; }
.subject { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { color: var(--muted); font-size: 12px; }
.side { display: grid; gap: 16px; }
.file-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.file-toolbar label { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; font-weight: 650; }
.file-actions { display: flex; gap: 8px; }
.files-list { display: grid; max-height: 310px; overflow: auto; border: 1px solid var(--line-soft); border-radius: 8px; }
.file-row { display: grid; grid-template-columns: 24px 42px minmax(0, 1fr); gap: 8px; align-items: center; min-height: 38px; padding: 7px 10px; border-bottom: 1px solid var(--line-soft); cursor: pointer; }
.file-row:last-child { border-bottom: none; }
.file-row:hover { background: #f8fafc; }
.file-row input { width: 15px; height: 15px; accent-color: var(--accent); }
.code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--amber); font-weight: 750; }
.file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.commit-status { min-height: 17px; margin-top: 9px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.commit-status.error { color: var(--rose); }
.branch-block { display: inline-block; width: 10px; height: 10px; margin-right: 8px; border-radius: 2px; flex-shrink: 0; }
.branch-tree-row { display: flex; align-items: center; padding: 7px 10px; min-width: 0; border-bottom: 1px solid var(--line-soft); }
.branch-tree-row:hover { background: #f8fafc; }
.tree-lines { color: #94a3b8; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre; margin-right: 4px; }
#branches { max-height: 330px; overflow: auto; border: 1px solid var(--line-soft); border-radius: 8px; }
.drawer { position: fixed; left: 20px; top: 88px; width: min(520px, calc(100vw - 40px)); max-height: calc(100vh - 116px); background: #ffffff; border: 1px solid var(--line); box-shadow: var(--shadow); border-radius: 8px; padding: 16px; transform: translateY(8px) scale(.98); opacity: 0; pointer-events: none; transition: opacity .16s, transform .16s; z-index: 10; display: flex; flex-direction: column; }
.drawer.open { transform: translateY(0) scale(1); opacity: 1; pointer-events: auto; }
.drawer pre { overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #334155; background: #f8fafc; border: 1px solid var(--line-soft); padding: 12px; border-radius: 7px; flex: 1 1 auto; max-height: 240px; }
.drawer-head { display: flex; justify-content: space-between; margin-bottom: 12px; }
.copy-button { border: 1px solid var(--line); background: #fff; color: var(--text); border-radius: 7px; height: 30px; padding: 4px 10px; cursor: pointer; font-weight: 650; }
.copy-button:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
#graph path { pointer-events: stroke; stroke-linecap: round; stroke-linejoin: round; transition: stroke-width 0.16s, opacity 0.16s; }
#graph path:hover { stroke-width: 3; opacity: 1 !important; }
#graph circle.node { transition: r 0.16s, stroke-width 0.16s; pointer-events: auto; }
#graph circle.node:hover { r: 4.8; stroke-width: 2.4; }
.calendar-grid { display: flex; gap: 3px; align-items: flex-end; }
.calendar-col { display: flex; flex-direction: column; gap: 3px; }
.calendar-cell { width: 10px; height: 10px; border-radius: 2px; background: #ebedf0; }
.calendar-cell[data-level="1"] { background: #9be9a8; }
.calendar-cell[data-level="2"] { background: #40c463; }
.calendar-cell[data-level="3"] { background: #30a14e; }
.calendar-cell[data-level="4"] { background: #216e39; }
@keyframes spin { 100% { transform: rotate(360deg); } }
@media (max-width: 1080px) { .grid, .summary-panel { grid-template-columns: 1fr; } .repo { max-width: 70vw; } }
@media (max-width: 620px) { .shell { width: min(100vw - 20px, 1480px); } .topbar { align-items: flex-start; flex-direction: column; } .commit { grid-template-columns: 1fr; } .hash { display: none; } .meters { grid-template-columns: 1fr; } .timeline-container { height: 520px; } }
</style>
</head>
<body>
<main class="shell">
  <header class="topbar">
    <div>
      <h1 id="appTitle">GMC GitWeb</h1>
      <div id="repo" class="repo">Loading...</div>
    </div>
    <div class="actions">
      <button id="refresh">Refresh</button>
      <button id="auto">Auto: on</button>
    </div>
  </header>
  
  <section class="summary-panel">
    <div class="panel" style="display:flex; justify-content:space-between;">
      <div>
        <h2>Current Branch</h2>
        <div id="branch" class="branch-name">...</div>
        <div id="upstream" class="meta"></div>
      </div>
      <div id="calendar" class="calendar-grid"></div>
    </div>
    <div class="meters">
      <div class="meter"><strong id="ahead">0</strong><span>ahead</span> <button id="btnPush" class="action-btn" style="display:none">Push</button></div>
      <div class="meter"><strong id="behind">0</strong><span>behind</span> <button id="btnPull" class="action-btn" style="display:none">Pull</button></div>
      <div class="meter"><strong id="dirty">0</strong><span>changed files</span></div>
    </div>
  </section>

  <section class="grid">
    <aside class="side">
      <div class="panel">
        <div class="panel-head">
          <h2>Working Tree</h2>
          <div id="selectedCount" class="meta">0 selected</div>
        </div>
        <div id="files"></div>
      </div>
      <div class="panel">
        <div class="panel-head">
          <h2>Branches Tree</h2>
        </div>
        <div id="branches"></div>
      </div>
    </aside>
    <div class="panel">
      <div class="panel-head">
        <h2>Commit Graph</h2>
        <div class="meta">Recent repository history</div>
      </div>
      <div class="timeline-container">
        <svg id="graph"></svg>
        <div id="commits" class="timeline"></div>
      </div>
    </div>
  </section>
</main>

<aside id="drawer" class="drawer">
  <div class="drawer-head">
    <div>
      <h2 id="drawerTitle" style="margin: 0;">Commit</h2>
      <div id="drawerMeta" class="meta"></div>
    </div>
    <button id="copyDetail" class="copy-button" type="button">Copy</button>
  </div>
  <pre id="message"></pre>
  <pre id="stat"></pre>
</aside>

<script>
var urlParams = new URLSearchParams(window.location.search);
var targetRepo = urlParams.get('repo') || '';
var state = { auto: true, timer: null, commits: [], tasks: [], commitBranch: {}, branchParent: {}, sortedBranches: [], selected: {}, committing: false, ignoring: false, restoring: false, detailToken: 0, hideTimer: null };
var $ = function(id) { return document.getElementById(id); };

function repoDisplayName(repoPath) {
  var parts = String(repoPath || '').replace(/[\\\/]+$/, '').split(/[\\\/]+/);
  return parts[parts.length - 1] || repoPath || '';
}

function setPageTitle(repoPath) {
  var title = repoPath ? ('GMC ' + repoDisplayName(repoPath)) : 'GMC GitWeb';
  document.title = title;
  $('appTitle').textContent = title;
}

setPageTitle(targetRepo);

if (!targetRepo) {
  $('repo').textContent = 'GMC GitWeb is running. Use "gmc web" in a git repository to view its status.';
  $('branch').textContent = 'No repository selected';
} else {
  $('repo').textContent = targetRepo;
  load();
}

$('refresh').addEventListener('click', load);
$('auto').addEventListener('click', function() {
  state.auto = !state.auto;
  $('auto').textContent = 'Auto: ' + (state.auto ? 'on' : 'off');
  schedule();
});
$('drawer').addEventListener('mouseenter', function() {
  clearTimeout(state.hideTimer);
});
$('drawer').addEventListener('mouseleave', function() {
  hideCommit();
});
$('copyDetail').addEventListener('click', copyCommitDetail);
window.addEventListener('resize', function() {
  if (state.commits.length) renderGraph(state.commits);
});

function schedule() {
  clearTimeout(state.timer);
  if (state.auto && targetRepo) state.timer = setTimeout(load, 5000);
}

function load() {
  if (!targetRepo) return;
  fetch('/api/status?repo=' + encodeURIComponent(targetRepo), { cache: 'no-store' })
    .then(function(res) { 
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json(); 
    })
    .then(render)
    .catch(function(error) {
      $('repo').textContent = 'Error loading status: ' + error.message;
    })
    .finally(schedule);
}

function getBranchColor(name) {
  if (!name) return '#94a3b8'; // muted for unassigned
  var colors = ['#0284c7', '#16a34a', '#db2777', '#d97706', '#7c3aed', '#0d9488', '#e11d48', '#2563eb', '#ca8a04', '#4f46e5'];
  var hash = 0;
  for (var i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

function processTopology(data) {
  state.commits = data.commits || [];
  
  // Sort branches: current first, main/master next, then alphabetical
  var sb = (data.branches || []).slice().sort(function(a, b) {
    if (a.current && !b.current) return -1;
    if (!a.current && b.current) return 1;
    var aMain = ['main', 'master'].indexOf(a.name) >= 0;
    var bMain = ['main', 'master'].indexOf(b.name) >= 0;
    if (aMain && !bMain) return -1;
    if (!aMain && bMain) return 1;
    return a.name.localeCompare(b.name);
  });
  state.sortedBranches = sb;

  var commitBranch = {};
  var branchParent = {};
  
  var commitMap = {};
  state.commits.forEach(function(c) { commitMap[c.hash] = c; });

  sb.forEach(function(b) {
    var curr = b.hash;
    while (curr && commitMap[curr]) {
      if (commitBranch[curr]) {
        if (commitBranch[curr] !== b.name) {
          branchParent[b.name] = commitBranch[curr];
        }
        break;
      }
      commitBranch[curr] = b.name;
      curr = (commitMap[curr].parents || [])[0] || null; // trace first parent backwards
    }
  });

  state.commitBranch = commitBranch;
  state.branchParent = branchParent;
}

function render(data) {
  if (data.error) {
    $('repo').textContent = 'Error: ' + data.error;
    return;
  }
  $('branch').textContent = data.branch.current;
  $('upstream').textContent = data.branch.upstream || 'No upstream';
  $('ahead').textContent = data.branch.ahead;
  $('btnPush').style.display = data.branch.ahead > 0 ? 'inline-block' : 'none';
  $('btnPush').onclick = function() { executeAction('/api/push', 'Pushing...'); };
  
  $('behind').textContent = data.branch.behind;
  $('btnPull').style.display = data.branch.behind > 0 ? 'inline-block' : 'none';
  $('btnPull').onclick = function() { executeAction('/api/pull', 'Pulling...'); };
  
  $('dirty').textContent = data.status.files.length;
  
  state.tasks = data.tasks || [];
  
  renderCalendar(data.contributions);
  renderFiles(data.status.files);
  
  processTopology(data);
  renderBranches();
  renderCommits(state.commits);
  
  setTimeout(function() { renderGraph(state.commits); }, 50);
}

function renderCalendar(contributions) {
  var cal = $('calendar');
  if (!cal || !contributions) return;
  var html = '';
  var now = new Date();
  for (var c = 25; c >= 0; c--) {
    html += '<div class="calendar-col">';
    for (var r = 0; r < 7; r++) {
      var d = new Date(now);
      d.setDate(d.getDate() - (c * 7 + (6 - r)));
      if (d > now) {
        html += '<div class="calendar-cell" style="background:transparent"></div>';
        continue;
      }
      var ds = d.toISOString().split('T')[0];
      var count = contributions[ds] || 0;
      var level = count > 10 ? 4 : count > 5 ? 3 : count > 2 ? 2 : count > 0 ? 1 : 0;
      html += '<div class="calendar-cell" data-level="' + level + '" title="' + count + ' commits on ' + ds + '"></div>';
    }
    html += '</div>';
  }
  cal.innerHTML = html;
}

function executeAction(url, loadingMsg) {
  var prevAuto = state.auto;
  state.auto = false;
  clearTimeout(state.timer);
  setCommitStatus(loadingMsg, false);
  fetch(url + '?repo=' + encodeURIComponent(targetRepo), { method: 'POST' })
    .then(function(res) { return res.json().then(function(data) { if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status); return data; }); })
    .then(function(data) { setCommitStatus('Success: ' + firstLine(data.output), false); })
    .catch(function(err) { setCommitStatus('Error: ' + err.message, true); })
    .finally(function() { state.auto = prevAuto; load(); });
}

function renderFiles(files) {
  var nextSelected = {};
  files.forEach(function(f) {
    if (state.selected[f.path]) {
      nextSelected[f.path] = true;
    }
  });
  state.selected = nextSelected;

  if (!files.length) {
    $('files').innerHTML = '<div class="meta">Clean working tree.</div>';
    updateCommitControls();
    return;
  }

  $('files').innerHTML = [
    '<div class="file-toolbar">',
      '<label><input id="selectAllFiles" type="checkbox"> All</label>',
      '<div class="file-actions">',
        '<button id="restoreSelected" class="ignore-button" style="color:var(--amber);border-color:var(--line)" type="button">Restore</button>',
        '<button id="ignoreSelected" class="ignore-button" type="button">Ignore</button>',
        '<button id="commitSelected" class="commit-button" type="button">Commit</button>',
      '</div>',
    '</div>',
    '<div class="files-list">',
      files.map(function(f) {
        var checked = state.selected[f.path] ? ' checked' : '';
        var displayPath = f.displayPath || f.path;
        return '<label class="file-row" title="' + escapeHtml(displayPath) + '">' +
          '<input class="file-check" type="checkbox" value="' + escapeHtml(f.path) + '"' + checked + '>' +
          '<span class="code">' + escapeHtml(f.code) + '</span>' +
          '<span class="file-name">' + escapeHtml(displayPath) + '</span>' +
        '</label>';
      }).join(''),
    '</div>',
    '<div id="commitStatus" class="commit-status"></div>'
  ].join('');
  bindFileControls(files);
}

function bindFileControls(files) {
  var all = $('selectAllFiles');
  var button = $('commitSelected');
  var ignoreButton = $('ignoreSelected');
  var boxes = Array.prototype.slice.call(document.querySelectorAll('.file-check'));

  boxes.forEach(function(box) {
    box.addEventListener('change', function() {
      state.selected[box.value] = box.checked;
      updateCommitControls();
    });
  });

  if (all) {
    all.addEventListener('change', function() {
      boxes.forEach(function(box) {
        box.checked = all.checked;
        state.selected[box.value] = all.checked;
      });
      updateCommitControls();
    });
  }

  if (button) {
    button.addEventListener('click', commitSelectedFiles);
  }
  if (ignoreButton) {
    ignoreButton.addEventListener('click', ignoreSelectedFiles);
  }
  var restoreButton = $('restoreSelected');
  if (restoreButton) {
    restoreButton.addEventListener('click', restoreSelectedFilesAction);
  }

  updateCommitControls();
}

function updateCommitControls() {
  var selected = Object.keys(state.selected).filter(function(filePath) { return state.selected[filePath]; });
  if ($('selectedCount')) {
    $('selectedCount').textContent = selected.length + ' selected';
  }
  var button = $('commitSelected');
  if (button) {
    button.disabled = state.committing || selected.length === 0;
    button.textContent = state.committing ? 'Committing...' : 'Commit';
  }
  var ignoreButton = $('ignoreSelected');
  if (ignoreButton) {
    ignoreButton.disabled = state.ignoring || state.committing || state.restoring || selected.length === 0;
    ignoreButton.textContent = state.ignoring ? 'Ignoring...' : 'Ignore';
  }
  var restoreButton = $('restoreSelected');
  if (restoreButton) {
    restoreButton.disabled = state.ignoring || state.committing || state.restoring || selected.length === 0;
    restoreButton.textContent = state.restoring ? 'Restoring...' : 'Restore';
  }
  var all = $('selectAllFiles');
  var boxes = Array.prototype.slice.call(document.querySelectorAll('.file-check'));
  if (all && boxes.length) {
    all.checked = selected.length === boxes.length;
    all.indeterminate = selected.length > 0 && selected.length < boxes.length;
  }
}

function setCommitStatus(message, isError) {
  var target = $('commitStatus');
  if (!target) return;
  target.textContent = message || '';
  target.className = 'commit-status' + (isError ? ' error' : '');
}

function commitSelectedFiles() {
  var files = Object.keys(state.selected).filter(function(filePath) { return state.selected[filePath]; });
  if (!files.length || state.committing) return;
  state.committing = true;
  setCommitStatus('Committing selected files...', false);
  updateCommitControls();

  fetch('/api/commit-selected?repo=' + encodeURIComponent(targetRepo), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: files })
  })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) {
          throw new Error(data.error || ('HTTP ' + res.status));
        }
        return data;
      });
    })
    .then(function(data) {
      state.selected = {};
      setCommitStatus(firstLine(data.output) || 'Committed selected files.', false);
      load();
    })
    .catch(function(error) {
      setCommitStatus(error.message, true);
    })
    .finally(function() {
      state.committing = false;
      updateCommitControls();
    });
}

function ignoreSelectedFiles() {
  var files = Object.keys(state.selected).filter(function(filePath) { return state.selected[filePath]; });
  if (!files.length || state.ignoring) return;
  state.ignoring = true;
  setCommitStatus('Ignoring selected files...', false);
  updateCommitControls();

  fetch('/api/ignore-selected?repo=' + encodeURIComponent(targetRepo), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: files })
  })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) {
          throw new Error(data.error || ('HTTP ' + res.status));
        }
        return data;
      });
    })
    .then(function(data) {
      state.selected = {};
      setCommitStatus((data.added || []).length + ' ignore rule(s) added to .gitignore.', false);
      load();
    })
    .catch(function(error) {
      setCommitStatus(error.message, true);
    })
    .finally(function() {
      state.ignoring = false;
      updateCommitControls();
    });
}

function restoreSelectedFilesAction() {
  var files = Object.keys(state.selected).filter(function(filePath) { return state.selected[filePath]; });
  if (!files.length || state.restoring) return;
  if (!confirm('Are you sure you want to discard changes in ' + files.length + ' file(s)?')) return;
  state.restoring = true;
  setCommitStatus('Restoring selected files...', false);
  updateCommitControls();

  fetch('/api/restore-selected?repo=' + encodeURIComponent(targetRepo), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: files })
  })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
        return data;
      });
    })
    .then(function(data) {
      state.selected = {};
      setCommitStatus('Restored ' + (data.restored || []).length + ' file(s).', false);
      load();
    })
    .catch(function(error) {
      setCommitStatus(error.message, true);
    })
    .finally(function() {
      state.restoring = false;
      updateCommitControls();
    });
}

function renderBranches() {
  var box = $('branches');
  if (!state.sortedBranches.length) { box.innerHTML = '<div class="meta">No branches.</div>'; return; }

  var childrenMap = {};
  var roots = [];
  
  state.sortedBranches.forEach(function(b) {
    var pName = state.branchParent[b.name];
    var pExists = state.sortedBranches.find(function(sb) { return sb.name === pName; });
    if (pName && pExists) {
      childrenMap[pName] = childrenMap[pName] || [];
      childrenMap[pName].push(b);
    } else {
      roots.push(b);
    }
  });

  var html = [];
  function renderTree(bList, prefix) {
    bList.forEach(function(b, idx) {
      var isLast = idx === bList.length - 1;
      var connector = isLast ? '└─' : '├─';
      var childPrefix = prefix + (isLast ? '  ' : '│ ');
      
      var icon = b.current ? '<span style="color:var(--green);font-size:10px;margin-right:4px;">★</span>' : '';
      var bColor = getBranchColor(b.name);
      var colorBlock = '<span class="branch-block" style="background:' + bColor + ';box-shadow:0 0 6px ' + bColor + '40"></span>';
      
      html.push(
        '<div class="branch-tree-row" title="' + escapeHtml(b.updated) + '">' +
          '<span class="tree-lines">' + escapeHtml(prefix ? (prefix + connector) : '') + '</span>' +
          icon + colorBlock +
          '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">' + escapeHtml(b.name) + '</span>' +
        '</div>'
      );
      
      if (childrenMap[b.name]) {
        renderTree(childrenMap[b.name], prefix ? childPrefix : '  ');
      }
    });
  }
  renderTree(roots, '');
  box.innerHTML = html.join('');
}

function renderCommits(commits) {
  var box = $('commits');
  if (!commits.length) { box.innerHTML = '<div class="meta">No commits yet.</div>'; return; }
  box.innerHTML = commits.map(function(c) {
    var date = c.date ? new Date(c.date).toLocaleString() : '';
    var bName = state.commitBranch[c.hash] || '';
    var cColor = getBranchColor(bName);
    var aiStatus = '';
    var task = (state.tasks || []).find(function(t) { return t.targetOid === c.hash; });
    if (task && (task.status === 'pending' || task.status === 'running' || task.status === 'waiting')) {
      aiStatus = '<span title="Waiting for AI generation" style="display:inline-block;animation:spin 2s linear infinite;font-size:12px;margin-left:6px;">⏳</span>';
    }
    return '<article class="commit" data-oid="' + escapeHtml(c.hash) + '" onmouseenter="showCommit(\\'' + c.hash + '\\', this)" onmouseleave="hideCommit()"><div class="hash" style="color:' + cColor + '">' + escapeHtml(c.shortHash) + '</div><div><div class="subject">' + escapeHtml(c.subject || '(no subject)') + aiStatus + '</div><div class="meta">' + escapeHtml(c.author) + ' &bull; ' + escapeHtml(date) + (bName ? ' &bull; ' + escapeHtml(bName) : '') + '</div></div></article>';
  }).join('');
}

function renderGraph(commits) {
  var graphSvg = $('graph');
  var graphBox = document.querySelector('.timeline-container');
  var commitNodes = document.querySelectorAll('.commit');
  if (!commitNodes.length) {
    graphSvg.innerHTML = '';
    if (graphBox) graphBox.style.setProperty('--graph-width', '30px');
    return;
  }

  var rowY = [];
  for (var i=0; i<commitNodes.length; i++) {
    rowY.push(commitNodes[i].offsetTop + commitNodes[i].offsetHeight / 2);
  }

  var columns = [];
  var nodes = [];
  var paths = [];
  var commitIndex = {};
  commits.forEach(function(commit, i) {
    commitIndex[commit.hash] = i;
  });

  commits.forEach(function(commit, i) {
    var hash = commit.hash;
    var parents = commit.parents || [];
    var commitBName = state.commitBranch[hash] || '';

    var c = columns.indexOf(hash);
    if (c === -1) {
      c = columns.findIndex(function(col) { return !col; });
      if (c === -1) c = columns.length;
    }
    columns[c] = parents[0] || null;

    nodes.push({ x: c, y: rowY[i], color: getBranchColor(commitBName), hash: hash });

    parents.forEach(function(p, pIdx) {
      var pBName = state.commitBranch[p] || commitBName;
      var pathColor = getBranchColor(pIdx === 0 ? commitBName : pBName);

      if (pIdx > 0) {
        var pc = columns.indexOf(p);
        if (pc === -1) {
          pc = columns.findIndex(function(col) { return !col; });
          if (pc === -1) pc = columns.length;
          columns[pc] = p;
        }
      }
      paths.push({ fromX: c, fromY: rowY[i], toHash: p, color: pathColor, merge: pIdx > 0 });
    });
  });

  var maxX = 0;
  paths.forEach(function(path) {
    var targetIdx = commitIndex[path.toHash];
    if (targetIdx !== undefined) {
      path.toY = rowY[targetIdx];
      path.toX = nodes[targetIdx].x;
    } else {
      path.toY = rowY[rowY.length - 1] + 40;
      path.toX = columns.indexOf(path.toHash);
      if (path.toX === -1) path.toX = path.fromX;
    }
    if (path.toX > maxX) maxX = path.toX;
    if (path.fromX > maxX) maxX = path.fromX;
  });
  nodes.forEach(function(node) {
    if (node.x > maxX) maxX = node.x;
  });

  var laneCount = maxX + 1;
  var nodeRadius = 3.9;
  var leftPad = 7;
  var rightPad = 5;
  var maxGraphWidth = 52;
  var laneGap = laneCount > 1
    ? Math.min(8, (maxGraphWidth - leftPad - rightPad - nodeRadius * 2) / (laneCount - 1))
    : 0;
  laneGap = Math.max(2.6, laneGap);
  var graphWidth = Math.ceil(leftPad + rightPad + nodeRadius * 2 + Math.max(0, laneCount - 1) * laneGap);
  graphWidth = Math.max(30, Math.min(maxGraphWidth, graphWidth));
  var graphHeight = $('commits').offsetHeight + 24;
  function getX(col) { return leftPad + nodeRadius + col * laneGap; }
  
  var svgHTML = '';
  paths.forEach(function(path) {
    var x1 = getX(path.fromX), y1 = path.fromY;
    var x2 = getX(path.toX), y2 = path.toY;
    var deltaY = Math.max(18, Math.abs(y2 - y1));
    var bend = Math.min(26, Math.max(12, deltaY * 0.34));
    var d = Math.abs(x1 - x2) < 0.1
      ? 'M' + x1 + ' ' + y1 + ' L' + x2 + ' ' + y2
      : 'M' + x1 + ' ' + y1 + ' C' + x1 + ' ' + (y1 + bend) + ' ' + x2 + ' ' + (y2 - bend) + ' ' + x2 + ' ' + y2;
    svgHTML += '<path d="' + d + '" fill="none" stroke="' + path.color + '" stroke-width="' + (path.merge ? '1.6' : '2') + '" opacity="' + (path.merge ? '0.48' : '0.7') + '" />';
  });

  nodes.forEach(function(node) {
    var cx = getX(node.x), cy = node.y;
    svgHTML += '<circle cx="' + cx + '" cy="' + cy + '" r="' + nodeRadius + '" fill="' + node.color + '" stroke="#ffffff" stroke-width="2" class="node" onmouseenter="showCommit(\\'' + node.hash + '\\', this)" onmouseleave="hideCommit()" />';
  });

  if (graphBox) graphBox.style.setProperty('--graph-width', graphWidth + 'px');
  graphSvg.setAttribute('width', graphWidth);
  graphSvg.setAttribute('height', graphHeight);
  graphSvg.setAttribute('viewBox', '0 0 ' + graphWidth + ' ' + graphHeight);
  graphSvg.style.width = graphWidth + 'px';
  graphSvg.style.height = graphHeight + 'px';
  graphSvg.innerHTML = svgHTML;
}

window.showCommit = function(oid, trigger) {
  if (!targetRepo) return;
  clearTimeout(state.hideTimer);
  var token = ++state.detailToken;
  positionCommitDrawer(trigger);
  fetch('/api/commit?oid=' + encodeURIComponent(oid) + '&repo=' + encodeURIComponent(targetRepo))
    .then(function(res) { return res.json(); })
    .then(function(detail) {
      if (token !== state.detailToken) return;
      $('drawerTitle').textContent = oid.slice(0, 12);
      $('drawerMeta').textContent = 'Commit detail';
      $('message').textContent = detail.message || '';
      $('stat').textContent = detail.stat || '';
      positionCommitDrawer(trigger);
      $('drawer').classList.add('open');
    });
};

window.hideCommit = function() {
  clearTimeout(state.hideTimer);
  state.hideTimer = setTimeout(function() {
    state.detailToken++;
    $('drawer').classList.remove('open');
  }, 1000);
};

function positionCommitDrawer(trigger) {
  var drawer = $('drawer');
  var graphPanel = document.querySelector('.timeline-container').closest('.panel');
  if (!drawer || !graphPanel) return;

  var panelRect = graphPanel.getBoundingClientRect();
  var triggerRect = trigger && trigger.getBoundingClientRect ? trigger.getBoundingClientRect() : panelRect;
  var gap = 14;
  var margin = 16;
  var maxWidth = 520;
  var minWidth = 340;
  var availableLeft = panelRect.left - gap - margin;
  var width = Math.min(maxWidth, Math.max(minWidth, availableLeft));
  var left = panelRect.left - gap - width;

  if (availableLeft < minWidth) {
    width = Math.min(maxWidth, window.innerWidth - margin * 2);
    left = margin;
  }

  drawer.style.width = width + 'px';
  drawer.style.left = Math.max(margin, left) + 'px';
  drawer.style.right = 'auto';

  var height = drawer.offsetHeight || 360;
  var top = triggerRect.top;
  var maxTop = window.innerHeight - height - margin;
  drawer.style.top = Math.max(margin, Math.min(top, maxTop)) + 'px';
}

function copyCommitDetail() {
  clearTimeout(state.hideTimer);
  var text = [$('message').textContent, $('stat').textContent].filter(Boolean).join('\\n\\n');
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function() {
      $('drawerMeta').textContent = 'Copied';
    }).catch(function() {
      $('drawerMeta').textContent = 'Select text and copy';
    });
    return;
  }
  $('drawerMeta').textContent = 'Select text and copy';
}

function firstLine(value) {
  return String(value || '').trim().split(/\\r?\\n/)[0] || '';
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function(ch) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
  });
}
</script>
</body>
</html>`;
}

module.exports = {
  start: start,
  collectStatus: collectStatus,
  checkRunning: checkRunning,
  resolveWeblocPort: resolveWeblocPort,
  createWebloc: createWebloc,
  openBrowser: openBrowser,
  DEFAULT_PORT: DEFAULT_PORT
};
