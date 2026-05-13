'use strict';

var childProcess = require('child_process');
var crypto = require('crypto');
var fs = require('fs');
var http = require('http');
var os = require('os');
var path = require('path');
var url = require('url');
var autogmc = require('./autogmc');
var agent = require('./agent');
var config = require('./config');
var git = require('./git');
var prompts = require('./prompts');

var DEFAULT_PORT = 4277;
var GITWEB_VERSION = 2;
var DIFF_LIMIT = 120000;
var RELOAD_TOKEN = process.env.GMC_GITWEB_RELOAD_TOKEN || String(Date.now());
var RECENT_REPOS_FILE = path.join(os.homedir(), '.config', 'gmc', 'recent-repos.json');
var AUTH_TOKEN_FILE = path.join(os.homedir(), '.config', 'gmc', 'gitweb-token');
var SECURITY_SETTINGS_FILE = path.join(os.homedir(), '.config', 'gmc', 'gitweb-security.json');
var AUTH_QUERY_PARAM = 'gmc_auth';
var AUTH_COOKIE = 'gmc_gitweb_auth';
var RECENT_REPOS_LIMIT = 20;
var RECENT_REPOS_VISIT_INTERVAL_MS = 10 * 60 * 1000;
var recentRepoVisitTimes = {};

function start(root, options) {
  options = options || {};
  recordRepositoryVisitIfValid(root);

  var requestedPort = normalizePort(options.port || process.env.GMC_GITWEB_PORT || DEFAULT_PORT);
  return listen(requestedPort, 0).then(function (serverInfo) {
    var address = authenticatedUrl(root, { port: serverInfo.port });
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
    server.listen(port, '0.0.0.0', function () {
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

function authenticatedUrl(root, options) {
  options = options || {};
  var port = normalizePort(options.port || DEFAULT_PORT);
  var host = options.host || '127.0.0.1';
  var displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  var query = { repo: root };
  query[AUTH_QUERY_PARAM] = getAuthToken();
  return 'http://' + formatUrlHost(displayHost) + ':' + port + '/?' + new URLSearchParams(query).toString();
}

function formatUrlHost(host) {
  host = String(host || '127.0.0.1');
  if (host.indexOf(':') >= 0 && host.charAt(0) !== '[') {
    return '[' + host + ']';
  }
  return host;
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
    if (isExternalAccessBlocked(req)) {
      sendUnauthorized(req, res, parsed, 'External GitWeb access is disabled. Open this page from 127.0.0.1 to enable it.');
      return;
    }
    if (handleAuthQuery(req, res, parsed)) {
      return;
    }
    if (requiresAuth(req, parsed) && !isAuthorizedRequest(req)) {
      sendUnauthorized(req, res, parsed);
      return;
    }

    if (req.method === 'POST') {
      if (parsed.pathname === '/api/quit') {
        sendJson(res, { status: 'ok' });
        setTimeout(function () {
          process.exit(0);
        }, 100);
        return;
      }
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
      if (parsed.pathname === '/api/install') {
        handleInstall(req, res, parsed.query.repo);
        return;
      }
      if (parsed.pathname === '/api/open-repository') {
        handleOpenRepository(req, res, parsed.query.repo);
        return;
      }
      if (parsed.pathname === '/api/repositories/remove') {
        handleRemoveRepository(req, res);
        return;
      }
      if (parsed.pathname === '/api/security/external-access') {
        handleExternalAccessSetting(req, res);
        return;
      }
      if (parsed.pathname === '/api/security/rotate-token') {
        handleRotateToken(req, res);
        return;
      }
      if (parsed.pathname === '/api/security/qr-code') {
        handleQrCode(req, res);
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
      if (parsed.query.name && !parsed.query.repo) {
        redirectRepositoryName(res, parsed.query.name);
        return;
      }
      send(res, 200, 'text/html; charset=utf-8', webHtml(getAuthToken(), req));
      return;
    }

    if (parsed.pathname === '/readme' || parsed.pathname === '/readme.html') {
      send(res, 200, 'text/html; charset=utf-8', readmeHtml(getAuthToken()));
      return;
    }

    if (parsed.pathname === '/api/ping') {
      sendJson(res, { status: 'ok', service: 'gmc-gitweb', gitwebVersion: GITWEB_VERSION, reloadToken: RELOAD_TOKEN });
      return;
    }

    if (parsed.pathname === '/api/repositories') {
      sendJson(res, { repositories: readRecentRepositories() });
      return;
    }

    if (parsed.pathname === '/api/repositories/resolve') {
      sendJson(res, { repository: findRecentRepositoryByName(parsed.query.name) });
      return;
    }

    if (parsed.pathname === '/api/security') {
      sendJson(res, publicSecuritySettings(null, req));
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

    if (parsed.pathname === '/api/readme') {
      sendJson(res, readmeContent(targetRepo));
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

function handleInstall(req, res, targetRepo) {
  if (!targetRepo) return sendJsonError(res, 400, 'Missing repo parameter');
  try {
    var repoRoot = git.repoRoot(targetRepo);
    installHooksAndWeb(repoRoot);
    sendJson(res, { status: 'ok', install: checkInstallStatus(repoRoot) });
  } catch (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  }
}

function handleOpenRepository(req, res, targetRepo) {
  if (!targetRepo) return sendJsonError(res, 400, 'Missing repo parameter');
  if (!isLoopbackRequest(req)) {
    return sendJsonError(res, 403, 'Opening repositories in Finder is only available from 127.0.0.1.');
  }
  try {
    sendJson(res, openRepositoryInFinder(targetRepo));
  } catch (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  }
}

function isLoopbackRequest(req) {
  var address = normalizeSocketAddress(req && req.socket && req.socket.remoteAddress);
  return address === '127.0.0.1' ||
    address === '::1';
}

function normalizeSocketAddress(address) {
  address = String(address || '').trim();
  if (address.indexOf('::ffff:') === 0) return address.slice(7);
  if (address.charAt(0) === '[' && address.charAt(address.length - 1) === ']') {
    return address.slice(1, -1);
  }
  return address;
}

function requestAccessAddress(req) {
  var localAddress = normalizeSocketAddress(req && req.socket && req.socket.localAddress);
  if (localAddress && localAddress !== '::' && localAddress !== '0.0.0.0') return localAddress;
  var host = String(req && req.headers && req.headers.host || '').trim();
  if (!host) return '';
  if (host.charAt(0) === '[') {
    var end = host.indexOf(']');
    return end >= 0 ? host.slice(1, end) : host;
  }
  return host.split(':')[0];
}

function preferredLanAddress() {
  var interfaces = os.networkInterfaces();
  var fallback = '';
  Object.keys(interfaces).forEach(function (name) {
    (interfaces[name] || []).forEach(function (item) {
      if (!item || item.internal) return;
      if (item.family === 'IPv4') {
        if (!fallback || /^en|^eth|^wlan|^wi-fi/i.test(name)) fallback = item.address;
      }
    });
  });
  return fallback;
}

function handleRemoveRepository(req, res) {
  readJsonBody(req).then(function (body) {
    sendJson(res, { repositories: removeRecentRepository(body.repo || body.path) });
  }).catch(function (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  });
}

function handleExternalAccessSetting(req, res) {
  if (!isLoopbackRequest(req)) {
    return sendJsonError(res, 403, 'External Access settings can only be changed from the host machine.');
  }
  readJsonBody(req).then(function (body) {
    var enabled = body.enabled === true;
    var settings = writeSecuritySettings({ allowExternalAccess: enabled });
    sendJson(res, publicSecuritySettings(settings, req));
  }).catch(function (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  });
}

function handleRotateToken(req, res) {
  if (!isLoopbackRequest(req)) {
    return sendJsonError(res, 403, 'Token refresh can only be run from the host machine.');
  }
  try {
    var token = rotateAuthToken();
    sendJson(res, {
      status: 'ok',
      token: token
    }, {
      'Set-Cookie': authCookieHeader(token)
    });
  } catch (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  }
}

function handleQrCode(req, res) {
  readJsonBody(req).then(function (body) {
    var QRCode = require('qrcode');
    var value = String(body.url || '').trim();
    if (!value || value.length > 4096) {
      var error = new Error('Invalid QR URL');
      error.httpStatus = 400;
      throw error;
    }
    return QRCode.toString(value, {
      type: 'svg',
      width: 224,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#111827',
        light: '#ffffff'
      }
    });
  }).then(function (svg) {
    sendJson(res, { svg: svg });
  }).catch(function (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  });
}

function redirectRepositoryName(res, name) {
  var repository = findRecentRepositoryByName(name);
  if (!repository) {
    send(res, 404, 'text/plain; charset=utf-8', 'No recent repository named "' + String(name || '') + '".');
    return;
  }
  res.writeHead(302, {
    Location: '/?repo=' + encodeURIComponent(repository.path),
    'Cache-Control': 'no-store'
  });
  res.end();
}

function checkInstallStatus(root) {
  var repoRoot = git.repoRoot(root);
  var gitDirPath = git.gitDir(root);
  var hooks = { commitMsg: false, postCommit: false };
  try {
    var cmPath = path.join(gitDirPath, 'hooks', 'commit-msg');
    if (fs.existsSync(cmPath)) {
      var content = fs.readFileSync(cmPath, 'utf8');
      hooks.commitMsg = content.indexOf('# GMHOOK') >= 0;
    }
  } catch (e) { /* ignore */ }
  try {
    var pcPath = path.join(gitDirPath, 'hooks', 'post-commit');
    if (fs.existsSync(pcPath)) {
      var content = fs.readFileSync(pcPath, 'utf8');
      hooks.postCommit = content.indexOf('# GMHOOK') >= 0;
    }
  } catch (e) { /* ignore */ }
  var weblocPath = path.join(repoRoot, 'git.webloc');
  return {
    hooks: hooks.commitMsg && hooks.postCommit,
    webloc: fs.existsSync(weblocPath)
  };
}

function installHooksAndWeb(repoRoot) {
  var gitDirPath = git.gitDir(repoRoot);
  var hooksDir = path.join(gitDirPath, 'hooks');
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }
  ['commit-msg', 'post-commit'].forEach(function (hookName) {
    var hookPath = path.join(hooksDir, hookName);
    var existing = fs.existsSync(hookPath) ? fs.readFileSync(hookPath, 'utf8') : null;
    if (existing && existing.indexOf('# GMHOOK') < 0) {
      throw new Error(hookPath + ' already exists and is not managed by gmc.');
    }
    var gmcBin = path.resolve(__dirname, '..', 'bin', 'gmc.js');
    var script = hookScript(hookName, gmcBin);
    fs.writeFileSync(hookPath, script);
    fs.chmodSync(hookPath, 0o755);
  });
  // create webloc
  var port = normalizePort(process.env.GMC_GITWEB_PORT || DEFAULT_PORT);
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
}

function hookScript(hookName, gmcBin) {
  var base = '#!/bin/sh\n# GMHOOK\n\n';
  var node = shellQuote(process.execPath);
  var gmc = shellQuote(gmcBin);
  if (hookName === 'commit-msg') {
    return base + 'exec ' + node + ' ' + gmc + ' hook commit-msg "$1"\n';
  }
  if (hookName === 'post-commit') {
    return base + 'exec ' + node + ' ' + gmc + ' hook post-commit\n';
  }
  throw new Error('Unknown hook: ' + hookName);
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function openRepositoryInFinder(root) {
  var repoRoot = git.repoRoot(root);
  if (process.platform !== 'darwin') {
    throwHttpError('Opening repositories in Finder is only supported on macOS.');
  }
  if (!fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) {
    throwHttpError('Repository path does not exist: ' + repoRoot);
  }

  var result = childProcess.spawnSync('open', [repoRoot], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    var message = (result.stderr || result.stdout || result.error && result.error.message || 'open failed').trim();
    throwHttpError(message || 'Failed to open repository in Finder.');
  }
  return {
    status: 'ok',
    path: repoRoot
  };
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

function sendJson(res, payload, headers) {
  res.writeHead(200, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, headers || {}));
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

function handleAuthQuery(req, res, parsed) {
  var supplied = parsed.query && parsed.query[AUTH_QUERY_PARAM];
  if (!supplied) return false;

  if (!isValidAuthToken(String(supplied))) {
    sendUnauthorized(req, res, parsed);
    return true;
  }

  var cleanQuery = Object.assign({}, parsed.query);
  delete cleanQuery[AUTH_QUERY_PARAM];
  var location = url.format({
    pathname: parsed.pathname || '/',
    query: cleanQuery
  });
  res.writeHead(302, {
    Location: location,
    'Set-Cookie': authCookieHeader(),
    'Cache-Control': 'no-store'
  });
  res.end();
  return true;
}

function requiresAuth(req, parsed) {
  if (parsed.pathname === '/api/ping') return !isLoopbackRequest(req);
  if (req.method === 'POST') return true;
  return !isLoopbackRequest(req);
}

function isExternalAccessBlocked(req) {
  return !isLoopbackRequest(req) && !readSecuritySettings().allowExternalAccess;
}

function isAuthorizedRequest(req) {
  return isValidAuthToken(requestAuthToken(req));
}

function requestAuthToken(req) {
  var headerToken = req.headers['x-gmc-auth'];
  if (headerToken) return String(headerToken);

  var authorization = req.headers.authorization || '';
  var match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (match) return match[1];

  return readCookie(req, AUTH_COOKIE);
}

function readCookie(req, name) {
  var cookieHeader = req.headers.cookie || '';
  var parts = cookieHeader.split(';');
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim();
    var eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq) === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1));
      } catch (e) {
        return '';
      }
    }
  }
  return '';
}

function isValidAuthToken(value) {
  var expected = getAuthToken();
  var provided = String(value || '');
  if (!provided || provided.length !== expected.length) return false;
  var providedBuffer = Buffer.from(provided);
  var expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

function authCookieHeader(token) {
  return AUTH_COOKIE + '=' + encodeURIComponent(token || getAuthToken()) + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000';
}

function getAuthToken() {
  try {
    var existing = fs.readFileSync(AUTH_TOKEN_FILE, 'utf8').trim();
    if (/^[a-f0-9]{64}$/i.test(existing)) {
      return existing;
    }
  } catch (e) { /* create below */ }

  ensureConfigDir();
  var token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(AUTH_TOKEN_FILE, token + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(AUTH_TOKEN_FILE, 0o600);
  } catch (e) { /* best effort */ }
  return token;
}

function rotateAuthToken() {
  ensureConfigDir();
  var token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(AUTH_TOKEN_FILE, token + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(AUTH_TOKEN_FILE, 0o600);
  } catch (e) { /* best effort */ }
  return token;
}

function ensureConfigDir() {
  var dir = path.dirname(AUTH_TOKEN_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function readSecuritySettings() {
  try {
    var raw = JSON.parse(fs.readFileSync(SECURITY_SETTINGS_FILE, 'utf8'));
    return {
      allowExternalAccess: raw.allowExternalAccess === true
    };
  } catch (e) {
    return { allowExternalAccess: false };
  }
}

function writeSecuritySettings(patch) {
  ensureConfigDir();
  var settings = Object.assign(readSecuritySettings(), patch || {});
  settings.allowExternalAccess = settings.allowExternalAccess === true;
  fs.writeFileSync(SECURITY_SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(SECURITY_SETTINGS_FILE, 0o600);
  } catch (e) { /* best effort */ }
  return settings;
}

function publicSecuritySettings(settings, req) {
  settings = settings || readSecuritySettings();
  return {
    allowExternalAccess: settings.allowExternalAccess === true,
    localAccess: req ? isLoopbackRequest(req) : true,
    accessAddress: req ? requestAccessAddress(req) : '',
    lanAddress: preferredLanAddress()
  };
}

function sendUnauthorized(req, res, parsed, customMessage) {
  var message = customMessage || 'GitWeb access denied. Open GMC Web from the host user account, or use the authenticated URL printed by gmc web.';
  if (parsed.pathname && parsed.pathname.indexOf('/api/') === 0) {
    sendJsonError(res, 403, message);
    return;
  }
  send(res, 403, 'text/html; charset=utf-8', unauthorizedHtml(message));
}

function unauthorizedHtml(message) {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>GMC GitWeb Access Denied</title>' +
    faviconLink() +
    '<style>body{font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f4f6f8;color:#111827;margin:0;display:grid;min-height:100vh;place-items:center}main{max-width:520px;padding:28px;background:#fff;border:1px solid #dbe2ea;border-radius:8px;box-shadow:0 18px 45px rgba(15,23,42,.12)}h1{font-size:20px;margin:0 0 10px}p{color:#4b5563;line-height:1.55;margin:0}</style>' +
    '</head><body><main><h1>Access denied</h1><p>' + escapeHtmlText(message) + '</p></main></body></html>';
}

function faviconLink() {
  return '<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2064%2064%27%3E%3Crect%20width=%2764%27%20height=%2764%27%20rx=%2712%27%20fill=%27%23068d6d%27/%3E%3Cpath%20d=%27M48%2017c-4-5-10-8-17-8C18%209%208%2019%208%2032s10%2023%2023%2023c8%200%2015-4%2019-10V33H32%27%20fill=%27none%27%20stroke=%27white%27%20stroke-width=%277%27%20stroke-linecap=%27round%27%20stroke-linejoin=%27round%27/%3E%3C/svg%3E">';
}

function escapeHtmlText(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
  });
}

function readRecentRepositories() {
  var raw;
  try {
    if (!fs.existsSync(RECENT_REPOS_FILE)) {
      return [];
    }
    raw = JSON.parse(fs.readFileSync(RECENT_REPOS_FILE, 'utf8'));
  } catch (e) {
    return [];
  }

  var repositories = Array.isArray(raw) ? raw : raw.repositories;
  if (!Array.isArray(repositories)) {
    return [];
  }

  return repositories
    .filter(function (item) { return item && item.path; })
    .map(function (item) {
      var repoPath = String(item.path);
      return {
        name: String(item.name || repoName(repoPath)),
        path: repoPath,
        lastVisited: Number(item.lastVisited) || 0
      };
    })
    .sort(function (a, b) { return b.lastVisited - a.lastVisited; })
    .slice(0, RECENT_REPOS_LIMIT);
}

function writeRecentRepositories(repositories) {
  var recent = repositories.slice(0, RECENT_REPOS_LIMIT);
  fs.mkdirSync(path.dirname(RECENT_REPOS_FILE), { recursive: true });
  fs.writeFileSync(RECENT_REPOS_FILE, JSON.stringify({
    repositories: recent
  }, null, 2) + '\n');
  return recent;
}

function recordRepositoryVisit(root) {
  var repoRoot = git.repoRoot(root);
  var repositories = readRecentRepositories().filter(function (item) {
    return item.path !== repoRoot;
  });
  recentRepoVisitTimes[repoRoot] = Date.now();
  repositories.unshift({
    name: repoName(repoRoot),
    path: repoRoot,
    lastVisited: recentRepoVisitTimes[repoRoot]
  });
  return writeRecentRepositories(repositories);
}

function recordRepositoryVisitIfStale(root) {
  var repoRoot = git.repoRoot(root);
  var lastVisit = recentRepoVisitTimes[repoRoot] || 0;
  if (Date.now() - lastVisit < RECENT_REPOS_VISIT_INTERVAL_MS) {
    return readRecentRepositories();
  }
  return recordRepositoryVisit(repoRoot);
}

function recordRepositoryVisitIfValid(root) {
  try {
    return recordRepositoryVisit(root);
  } catch (e) {
    return readRecentRepositories();
  }
}

function removeRecentRepository(repoPath) {
  if (!repoPath) {
    return readRecentRepositories();
  }
  return writeRecentRepositories(readRecentRepositories().filter(function (item) {
    return item.path !== repoPath;
  }));
}

function findRecentRepositoryByName(name) {
  var key = normalizeRepoName(name);
  if (!key) return null;
  var repositories = readRecentRepositories();
  for (var i = 0; i < repositories.length; i++) {
    var item = repositories[i];
    if (normalizeRepoName(item.name) === key || normalizeRepoName(repoName(item.path)) === key) {
      return item;
    }
  }
  return null;
}

function repoName(repoPath) {
  var parts = String(repoPath || '').replace(/[\\\/]+$/, '').split(/[\\\/]+/);
  return parts[parts.length - 1] || repoPath || '';
}

function normalizeRepoName(name) {
  return String(name || '').trim().toLowerCase();
}

function collectStatus(root) {
  root = git.repoRoot(root);
  recordRepositoryVisitIfStale(root);
  var branch = git.currentBranch(root) || '(detached)';
  var upstream = runGitOptional(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  var status = parseStatusOutput(runGitOptional(root, ['status', '--porcelain=v1', '-b', '-z']));
  var remote = runGitOptional(root, ['remote', 'get-url', 'origin']);
  var aheadBehind = upstream ? parseAheadBehind(runGitOptional(root, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'])) : {
    ahead: 0,
    behind: 0
  };

  var installStatus = checkInstallStatus(root);

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
    tasks: safeTasks(root),
    install: installStatus
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

  var installed = checkInstallStatus(repoRoot);
  var result;

  if (installed.hooks) {
    // Hooks installed: git commit -m gmc triggers the commit-msg hook which generates AI message
    result = childProcess.spawnSync('git', ['commit', '-m', 'gmc', '--'].concat(gitPaths), {
      cwd: repoRoot,
      encoding: 'utf8'
    });
  } else {
    // No hooks: generate AI commit message directly
    var binding = safeBinding(repoRoot);
    var diff = git.stagedDiff(repoRoot);
    if (diff.length > DIFF_LIMIT) {
      diff = diff.slice(0, DIFF_LIMIT) + '\n\n[Diff truncated by gmc]\n';
    }
    var prompt = prompts.commitMessagePrompt(
      binding,
      diff,
      git.statusShort(repoRoot),
      git.recentCommitSubjects(repoRoot, 20)
    );
    var aiMessage;
    try {
      aiMessage = prompts.appendCreatedBy(
        agent.generateCommitMessage(prompt, repoRoot),
        binding ? binding.agent : config.currentAgent()
      );
    } catch (aiError) {
      var err = new Error('AI commit message generation failed: ' + aiError.message);
      err.httpStatus = 500;
      throw err;
    }
    var messageFile = git.writeGitFile(repoRoot, 'GMC_WEB_COMMIT_EDITMSG', aiMessage);
    result = childProcess.spawnSync('git', ['commit', '-F', messageFile, '--'].concat(gitPaths), {
      cwd: repoRoot,
      encoding: 'utf8'
    });
  }

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

function readmeContent(root) {
  var repoRoot = git.repoRoot(root);
  var names = ['README.md', 'readme.md', 'Readme.md', 'README.MD'];
  for (var i = 0; i < names.length; i++) {
    var readmePath = path.join(repoRoot, names[i]);
    if (fs.existsSync(readmePath)) {
      try {
        return { type: 'readme', content: fs.readFileSync(readmePath, 'utf8') };
      } catch (e) {
        break;
      }
    }
  }
  return { type: 'help', content: gmcHelpText() };
}

function gmcHelpText() {
  return [
    'gmc - bind GitHub issues to AI coding sessions and commits',
    'git commit -m gmc - generate commit message with gmc hooks',
    '',
    'Usage:',
    '  gmc <issue> [--agent codex|claude] [--exec] [--no-branch]',
    '  gmc agent [codex|claude]',
    '  gmc bind <issue> [--agent codex|claude]',
    '  gmc status',
    '  gmc message [--print-prompt]',
    '  gmc commit [--no-edit]',
    '  gmc retry [commit]',
    '  gmc install --all [--port 4277]',
    '  gmc install-hooks',
    '  gmc web [--port 4277] [--no-open]',
    '  git commit -m gmc',
    '',
    'Environment:',
    '  GITHUB_TOKEN or GH_TOKEN is used for GitHub API authentication.',
    '  GMC_CODEX_MODEL overrides the model used for commit message generation.',
    '  GMC_CODEX_TIMEOUT_MS overrides the Codex generation timeout.',
    '  GMC_GITWEB_PORT overrides the default local GitWeb port.',
    '  GMC Web prints an authenticated URL. Remote browsers must use that URL',
    '    before GitWeb APIs can read or modify repositories.',
    '  gmc install --all installs hooks and writes a repository-specific git.webloc.',
    '  gmc install-hooks sets up Git hooks to automatically create background tasks',
    '    for new commits and commit messages.',
    '  gmc web serves the Git Web UI. If a server is already running, it will just',
    '    open the current repository in the browser.',
    '',
    'Examples:',
    '  git commit -m gmc',
    '  gmc agent claude',
    '  gmc GH-234 --agent codex',
    '  git add . && gmc message',
    '  git add . && gmc commit',
    '  gmc retry HEAD',
    '  gmc install --all',
    '  gmc install-hooks && git commit -m gmc',
    '  gmc web'
  ].join('\n');
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

function webHtml(clientAuthToken, req) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GMC GitWeb</title>
${faviconLink()}
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
  --accent: #068d6dff;
  --accent-soft: #eff6ff;
  --green: #0f9f6e;
  --rose: #dc2626;
  --amber: #b45309;
  --shadow: 0 18px 45px rgba(15, 23, 42, .12);
  --sidebar-w: 260px;
  --sidebar-bg: #f1f5f9;
  --sidebar-border: #e2e8f0;
  --z-sidebar: 1000;
  --z-navbar: 900;
  --z-drawer: 1100;
  --z-modal: 1200;
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text); font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; overflow-x: hidden; }
body { background: linear-gradient(180deg, #ffffff 0, var(--bg) 280px); }
.app-container { min-width: 0; min-height: 100vh; }
.sidebar {
  width: var(--sidebar-w);
  background:
    linear-gradient(180deg, rgba(255,255,255,.72), rgba(241,245,249,.92)),
    var(--sidebar-bg);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  border-right: 1px solid var(--sidebar-border);
  display: flex;
  flex-direction: column;
  transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
  position: fixed;
  left: 0;
  top: 0;
  height: 100vh;
  z-index: var(--z-sidebar);
  overflow: hidden;
}
.sidebar.collapsed {
  transform: translateX(-100%);
}
.sidebar-header {
  padding: 18px 18px 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: 62px;
}
.sidebar-header h2 { font-size: 11px; font-weight: 800; color: #64748b; text-transform: uppercase; letter-spacing: 0.1em; margin: 0; }
.repo-list { flex: 1; overflow-y: auto; padding: 8px 12px 18px; }
.repo-empty {
  border: 1px dashed #cbd5e1;
  border-radius: 8px;
  color: #64748b;
  font-size: 12px;
  line-height: 1.45;
  padding: 14px;
  background: rgba(255,255,255,.48);
}
.repo-item {
  position: relative;
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
  width: 100%;
  min-width: 0;
  padding: 11px 12px;
  border-radius: 8px;
  cursor: pointer;
  margin-bottom: 8px;
  transition: background .18s, border-color .18s, box-shadow .18s, transform .18s;
  color: inherit;
  background: rgba(255,255,255,.72);
  border: 1px solid rgba(226,232,240,.72);
  box-shadow: 0 1px 2px rgba(15,23,42,.035);
  outline: none;
}
.repo-item:hover, .repo-item:focus-visible {
  border-color: #c7d2fe;
  background: rgba(255,255,255,.95);
  transform: translateY(-1px);
  box-shadow: 0 12px 26px rgba(37,99,235,.10);
}
.repo-item.active {
  border-color: #039c67ff;
  background: linear-gradient(135deg, #ffffff 0%, #eff6ff 100%);
  box-shadow: inset 3px 0 0 var(--accent), 0 10px 24px rgba(37,99,235,.10);
}
.repo-item-icon {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  color: #2563eb;
  background: #e0edff;
  border: 1px solid #bfdbfe;
  font-weight: 800;
  font-size: 13px;
}
.repo-item-body { min-width: 0; padding-right: 22px; }
.repo-item-name { font-weight: 750; font-size: 13.5px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.repo-item-path { font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; opacity: 0.86; }
.repo-item-time { font-size: 10.5px; color: #94a3b8; margin-top: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.repo-item.active .repo-item-name { color: var(--accent); }
.repo-item.active .repo-item-path { color: var(--muted); opacity: 0.7; }
.repo-remove {
  position: absolute;
  top: 8px;
  right: 8px;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 999px;
  color: #64748b;
  background: rgba(255,255,255,.92);
  opacity: 0;
  transform: scale(.92);
  cursor: pointer;
  transition: opacity .14s, transform .14s, color .14s, background .14s, border-color .14s;
}
.repo-item:hover .repo-remove,
.repo-item:focus-within .repo-remove,
.repo-remove:focus-visible {
  opacity: 1;
  transform: scale(1);
}
.repo-remove:hover {
  color: var(--rose);
  background: #fff1f2;
  border-color: #fecdd3;
}
.repo-remove svg { width: 14px; height: 14px; pointer-events: none; }

.shell { min-width: 0; min-height: 100vh; margin-left: var(--sidebar-w); padding: 82px 32px 32px; transition: margin-left 0.4s cubic-bezier(0.16, 1, 0.3, 1); }
.sidebar.collapsed + .shell { margin-left: 0; }
.shell-inner { width: min(1480px, 100%); margin: 0 auto; }
.topbar { position: fixed; left: var(--sidebar-w); right: 0; top: 0; z-index: var(--z-navbar); padding: 0 32px; background: rgba(255,255,255,.92); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); border-bottom: 1px solid rgba(219,226,234,.82); box-shadow: 0 1px 2px rgba(15, 23, 42, .04); transition: left 0.4s cubic-bezier(0.16, 1, 0.3, 1); }
.sidebar.collapsed + .shell .topbar { left: 0; }
.topbar-inner { width: min(1480px, 100%); min-height: 64px; margin: 0 auto; display: flex; justify-content: space-between; align-items: center; gap: 16px; }
h1 { margin: 0; font-size: 22px; font-weight: 760; letter-spacing: 0; line-height: 1.1; }
h2 { margin: 0; font-size: 12px; color: #475569; text-transform: uppercase; letter-spacing: .08em; }
.repo { display: block; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: min(920px, 64vw); text-decoration: none; }
.repo[href]:hover { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
.actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.local-security-controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.local-security-controls[hidden] { display: none; }
.actions button, .commit-button, .ignore-button { border: 1px solid var(--line); background: var(--panel); color: var(--text); border-radius: 7px; min-height: 34px; padding: 7px 12px; cursor: pointer; font-weight: 650; }
.actions button:hover, .commit-button:hover:not(:disabled), .ignore-button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
.settings-button { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }
.settings-button svg { width: 16px; height: 16px; pointer-events: none; }
.lan-access { display: none; align-items: center; gap: 8px; min-height: 34px; max-width: min(420px, 46vw); padding: 6px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); color: var(--text); font-size: 13px; font-weight: 650; }
.lan-access.visible { display: inline-flex; }
.lan-access svg { width: 17px; height: 17px; color: var(--accent); flex: 0 0 auto; }
.lan-access span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.toggle-control { display: inline-flex; align-items: center; gap: 8px; min-height: 34px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); color: var(--text); font-size: 13px; font-weight: 650; cursor: pointer; user-select: none; }
.toggle-control:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
.toggle-control input { position: absolute; opacity: 0; pointer-events: none; }
.toggle-track { width: 34px; height: 20px; border-radius: 999px; background: #cbd5e1; position: relative; transition: background .15s; flex: 0 0 auto; }
.toggle-track::after { content: ""; position: absolute; width: 16px; height: 16px; left: 2px; top: 2px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(15,23,42,.24); transition: transform .15s; }
.toggle-control input:checked + .toggle-track { background: var(--accent); }
.toggle-control input:checked + .toggle-track::after { transform: translateX(14px); }
.toggle-control input:focus-visible + .toggle-track { outline: 2px solid #93c5fd; outline-offset: 2px; }
#rotateToken { opacity: 0; transform: translateY(-4px) scale(.98); pointer-events: none; max-width: 0; padding-left: 0; padding-right: 0; border-width: 0; overflow: hidden; transition: opacity .16s, transform .16s, max-width .2s, padding .2s, border-width .2s; white-space: nowrap; }
#rotateToken.visible { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; max-width: 120px; padding-left: 12px; padding-right: 12px; border-width: 1px; }
.settings-page #rotateToken { opacity: 1; transform: none; pointer-events: auto; max-width: none; padding-left: 12px; padding-right: 12px; border-width: 1px; }
.settings-page { display: grid; gap: 16px; }
.settings-page[hidden] { display: none; }
.settings-hero { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 2px; }
.settings-hero h2 { margin: 0; color: var(--text); font-size: 22px; line-height: 1.15; letter-spacing: 0; text-transform: none; }
.settings-hero p { margin: 6px 0 0; color: var(--muted); max-width: 720px; line-height: 1.6; }
.settings-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 380px); gap: 16px; align-items: start; }
.settings-card { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 18px; box-shadow: 0 1px 2px rgba(15, 23, 42, .04); }
.settings-card h3 { margin: 0; color: var(--text); font-size: 15px; line-height: 1.25; }
.settings-card p { margin: 7px 0 0; color: var(--muted); line-height: 1.55; font-size: 13px; }
.settings-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 14px 0; border-bottom: 1px solid var(--line-soft); }
.settings-row:last-child { border-bottom: none; padding-bottom: 0; }
.settings-row-main { min-width: 0; }
.settings-row-main strong { display: block; font-size: 14px; }
.settings-row-main span { display: block; margin-top: 3px; color: var(--muted); font-size: 12px; line-height: 1.45; }
.access-address { display: inline-flex; max-width: 100%; margin-top: 10px; padding: 7px 9px; border-radius: 7px; background: #f8fafc; border: 1px solid var(--line-soft); color: #334155; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qr-shell { display: grid; gap: 12px; justify-items: center; }
.qr-box { display: grid; place-items: center; width: 244px; height: 244px; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
.qr-box svg { display: block; width: 224px; height: 224px; }
.qr-placeholder { display: grid; place-items: center; width: 100%; height: 100%; border-radius: 7px; background: #f8fafc; color: var(--muted); text-align: center; font-size: 13px; line-height: 1.5; padding: 20px; }
.access-url { width: 100%; min-height: 62px; padding: 10px; resize: none; border: 1px solid var(--line); border-radius: 7px; background: #f8fafc; color: #334155; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.45; }
.settings-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; width: 100%; }
.settings-warning { display: none; margin-top: 12px; padding: 10px 12px; border: 1px solid #fed7aa; border-radius: 7px; background: #fff7ed; color: #9a3412; font-size: 12px; line-height: 1.5; }
.settings-warning.visible { display: block; }
.commit-button { background: var(--accent); border-color: var(--accent); color: #fff; }
.commit-button:hover:not(:disabled) { color: #fff; background: #1d4ed8; }
.ignore-button { color: var(--rose); }
.ignore-button:hover:not(:disabled) { border-color: var(--rose); color: var(--rose); background: #fef2f2; }
.commit-button:disabled, .ignore-button:disabled { opacity: .45; cursor: not-allowed; }
.install-banner { display: none; background: #dc2626; color: #fff; padding: 10px 20px; border-radius: 8px; margin-bottom: 16px; font-size: 13px; font-weight: 600; align-items: center; justify-content: space-between; gap: 12px; }
.install-banner.visible { display: flex; }
.install-banner .install-text { flex: 1; }
.install-banner button { background: #fff; color: #dc2626; border: none; border-radius: 6px; padding: 6px 16px; font-weight: 700; cursor: pointer; white-space: nowrap; font-size: 13px; }
.install-banner button:hover { background: #fef2f2; }
.install-banner button:disabled { opacity: .6; cursor: not-allowed; }
.grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 440px); gap: 16px; align-items: start; min-width: 0; }
.grid > *, .summary-panel > *, .side, .panel { min-width: 0; }
.panel { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 16px; box-shadow: 0 1px 2px rgba(15, 23, 42, .04); }
.summary-panel { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 440px); gap: 16px; margin-bottom: 16px; align-items: stretch; min-width: 0; }
.branch-summary-panel { display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; overflow: hidden; }
.branch-summary-text { min-width: 0; flex: 1 1 auto; }
.branch-name { font-size: 32px; font-weight: 780; margin: 3px 0 2px; letter-spacing: 0; overflow-wrap: anywhere; }
.meters { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; height: 100%; }
.meter { padding: 12px; border-radius: 8px; background: var(--panel-soft); border: 1px solid var(--line-soft); position: relative; }
.meter strong { display: block; font-size: 24px; color: var(--accent); line-height: 1.1; }
.meter span { font-size: 12px; color: var(--muted); }
.meter .action-btn { position: absolute; right: 12px; top: 12px; font-size: 11px; padding: 3px 8px; border-radius: 4px; border: 1px solid var(--line); background: #fff; cursor: pointer; color: var(--text); font-weight: 600; }
.meter .action-btn:hover { border-color: var(--accent); color: var(--accent); }
.meter .action-btn:disabled { opacity: .62; cursor: progress; color: var(--muted); background: #f8fafc; }
.panel-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; }
.timeline-container { --graph-width: 30px; display: grid; grid-template-columns: var(--graph-width) minmax(0, 1fr); column-gap: 6px; align-items: flex-start; position: relative; height: min(66vh, 680px); min-height: 430px; overflow: auto; border: 1px solid var(--line-soft); border-radius: 8px; background: linear-gradient(90deg, #fbfdff 0, #fbfdff calc(var(--graph-width) + 10px), #ffffff calc(var(--graph-width) + 10px)); padding: 10px 10px 10px 4px; }
#graph { width: var(--graph-width); min-width: var(--graph-width); pointer-events: auto; overflow: visible; }
.timeline { display: grid; gap: 9px; min-width: 0; padding-right: 2px; }
.commit { display: grid; grid-template-columns: minmax(0, 1fr); padding: 8px 12px; border: 1px solid var(--line-soft); border-radius: 8px; background: #fff; cursor: pointer; touch-action: manipulation; transition: background .16s, border-color .16s, box-shadow .16s, transform .16s; }
.commit:hover { background: var(--accent-soft); border-color: #bfdbfe; box-shadow: 0 8px 22px rgba(37, 99, 235, .10); transform: translateY(-1px); }
.hash { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 700; }
.subject { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { color: var(--muted); font-size: 12px; }
.ai-status { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 16px; margin-left: 7px; vertical-align: -3px; color: var(--accent); position: relative; }
.ai-status svg { display: block; }
.ai-status-loader { width: 15px; height: 15px; animation: spin 1.05s linear infinite; opacity: .9; }
.ai-status-loader circle { opacity: .22; }
.ai-status-sparkles { position: absolute; right: -1px; top: -3px; width: 11px; height: 11px; color: #0f9f6e; animation: aiPulse 1.35s ease-in-out infinite; filter: drop-shadow(0 1px 2px rgba(15, 159, 110, .18)); }
.side { display: grid; gap: 16px; }
.file-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.file-toolbar label { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; font-weight: 650; }
.file-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; min-width: 0; }
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
.readme-panel { margin-top: 0; }
.readme-panel .readme-body { padding: 4px 0 0; font-size: 14px; line-height: 1.65; overflow-wrap: break-word; word-break: break-word; }
.readme-body h1, .readme-body h2, .readme-body h3, .readme-body h4 { margin: 1.2em 0 .6em; font-weight: 700; }
.readme-body h1 { font-size: 22px; border-bottom: 1px solid var(--line-soft); padding-bottom: 6px; }
.readme-body h2 { font-size: 18px; border-bottom: 1px solid var(--line-soft); padding-bottom: 4px; }
.readme-body h3 { font-size: 15px; }
.readme-body p { margin: .6em 0; }
.readme-body ul, .readme-body ol { padding-left: 24px; margin: .5em 0; }
.readme-body li { margin: .3em 0; }
.readme-body pre { background: #f1f5f9; border: 1px solid var(--line-soft); border-radius: 6px; padding: 12px; overflow-x: auto; font-size: 13px; line-height: 1.5; }
.readme-body code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; background: #f1f5f9; padding: 2px 5px; border-radius: 4px; }
.readme-body pre code { background: none; padding: 0; font-size: inherit; }
.readme-body blockquote { margin: .6em 0; padding: 4px 14px; border-left: 3px solid var(--accent); background: var(--accent-soft); border-radius: 0 6px 6px 0; color: #334155; }
.readme-body table { border-collapse: collapse; margin: .8em 0; width: 100%; }
.readme-body th, .readme-body td { border: 1px solid var(--line-soft); padding: 6px 10px; text-align: left; }
.readme-body th { background: #f8fafc; font-weight: 700; }
.readme-body img { max-width: 100%; border-radius: 6px; }
.readme-body a { color: var(--accent); text-decoration: none; }
.readme-body a:hover { text-decoration: underline; }
.readme-body .mermaid { margin: .8em 0; overflow-x: auto; }
.readme-help pre { white-space: pre-wrap; background: #f8fafc; border: 1px solid var(--line-soft); padding: 14px; border-radius: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; line-height: 1.6; color: #334155; }
.readme-link { display: inline-flex; align-items: center; min-height: 34px; padding: 7px 12px; border: 1px solid var(--line); border-radius: 7px; color: var(--accent); background: #fff; text-decoration: none; font-weight: 650; }
.readme-link:hover { border-color: var(--accent); background: var(--accent-soft); }
.drawer { position: fixed; left: 20px; top: 88px; width: min(520px, calc(100vw - 40px)); max-height: calc(100vh - 116px); background: #ffffff; border: 1px solid var(--line); box-shadow: var(--shadow); border-radius: 8px; padding: 16px; transform: translateY(8px) scale(.98); opacity: 0; pointer-events: none; transition: opacity .16s, transform .16s; z-index: var(--z-drawer); display: flex; flex-direction: column; }
.drawer.open { transform: translateY(0) scale(1); opacity: 1; pointer-events: auto; }
.drawer pre { overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #334155; background: #f8fafc; border: 1px solid var(--line-soft); padding: 12px; border-radius: 7px; flex: 1 1 auto; max-height: 240px; }
.drawer-head { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.drawer-actions { display: flex; gap: 8px; flex: 0 0 auto; }
.copy-button { border: 1px solid var(--line); background: #fff; color: var(--text); border-radius: 7px; height: 30px; padding: 4px 10px; cursor: pointer; font-weight: 650; }
.copy-button:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
.close-button:hover { border-color: var(--rose); color: var(--rose); background: #fef2f2; }
#graph path { pointer-events: stroke; stroke-linecap: round; stroke-linejoin: round; transition: stroke-width 0.16s, opacity 0.16s; }
#graph path:hover { stroke-width: 3; opacity: 1 !important; }
#graph circle.node { transition: r 0.16s, stroke-width 0.16s; pointer-events: auto; }
#graph circle.node:hover { r: 4.8; stroke-width: 2.4; }
.calendar-grid { --calendar-cell: 10px; --calendar-gap: 3px; --calendar-label-width: 24px; display: grid; grid-template-columns: var(--calendar-label-width) minmax(0, 1fr); grid-template-rows: 13px auto; column-gap: 6px; row-gap: 4px; flex: 0 1 min(674px, 78%); width: min(674px, 78%); justify-content: flex-end; align-items: start; max-width: 100%; min-width: 0; overflow: hidden; }
.calendar-months { grid-column: 2; grid-row: 1; display: flex; gap: var(--calendar-gap); overflow: hidden; min-width: 0; }
.calendar-month { flex: 0 0 var(--calendar-cell); height: 13px; color: var(--muted); font-size: 10px; line-height: 12px; white-space: nowrap; overflow: visible; }
.calendar-weekdays { grid-column: 1; grid-row: 2; display: flex; flex-direction: column; gap: var(--calendar-gap); }
.calendar-weekday { height: var(--calendar-cell); color: var(--muted); font-size: 10px; line-height: var(--calendar-cell); text-align: right; white-space: nowrap; }
.calendar-weeks { grid-column: 2; grid-row: 2; display: flex; gap: var(--calendar-gap); align-items: flex-start; overflow: hidden; min-width: 0; }
.calendar-col { display: flex; flex-direction: column; gap: var(--calendar-gap); flex: 0 0 var(--calendar-cell); }
.calendar-cell { flex: 0 0 var(--calendar-cell); width: var(--calendar-cell); height: var(--calendar-cell); border-radius: 2px; background: #ebedf0; }
.calendar-cell.empty { background: transparent; }
.calendar-cell[data-level="1"] { background: #9be9a8; }
.calendar-cell[data-level="2"] { background: #40c463; }
.calendar-cell[data-level="3"] { background: #30a14e; }
.calendar-cell[data-level="4"] { background: #216e39; }
@keyframes spin { 100% { transform: rotate(360deg); } }
@keyframes aiPulse { 0%, 100% { opacity: .52; transform: scale(.86); } 50% { opacity: 1; transform: scale(1.08); } }
@media (prefers-reduced-motion: reduce) {
  .ai-status-loader, .ai-status-sparkles { animation: none; }
}
@media (max-width: 1280px) { 
  .grid, .summary-panel { grid-template-columns: 1fr; } 
  .repo { max-width: 70vw; } 
  .shell { padding: 82px 16px 24px; }
  .topbar { padding-left: 16px; padding-right: 16px; }
}
@media (max-width: 920px) {
  .settings-grid { grid-template-columns: 1fr; }
}
@media (max-width: 1024px) {
  .sidebar {
    box-shadow: 25px 0 60px rgba(15, 23, 42, 0.15);
  }
  .shell,
  .sidebar.collapsed + .shell { margin-left: 0; }
  .topbar,
  .sidebar.collapsed + .shell .topbar { left: 0; }
  .sidebar-toggle#sidebarClose { display: flex !important; }
}
@media (max-width: 620px) { 
  .shell { padding-top: 132px; }
  .topbar-inner { align-items: flex-start; flex-direction: column; min-height: auto; padding: 14px 0; } 
  .commit { grid-template-columns: 1fr; } 
  .hash { display: none; } 
  .meters { grid-template-columns: 1fr; } 
  .timeline-container { height: 520px; } 
  .branch-summary-panel { flex-direction: column; align-items: stretch; gap: 12px; }
  .branch-summary-text { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .branch-summary-text h2 { flex: 0 0 auto; }
  .branch-name { font-size: 20px; margin: 0; min-width: 0; flex: 0 1 auto; }
  .branch-summary-text .meta { flex: 0 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .calendar-grid { --calendar-cell: 9px; --calendar-gap: 2px; --calendar-label-width: 24px; flex: 0 0 auto; width: 100%; justify-content: flex-start; }
  .settings-hero { flex-direction: column; }
  .settings-row { align-items: flex-start; flex-direction: column; }
  .settings-actions { justify-content: flex-start; }
  .qr-box { width: min(244px, 100%); height: auto; aspect-ratio: 1; }
}
.sidebar-toggle {
  background: none;
  border: none;
  padding: 8px;
  cursor: pointer;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #64748b;
  transition: all 0.2s;
}
.sidebar-toggle:hover { background: rgba(0,0,0,0.05); color: var(--text); }
.sidebar-toggle svg { width: 20px; height: 20px; }
#sidebarToggle { margin-left: -12px; margin-right: 8px; }
#sidebarClose { margin-right: -8px; display: none; }
</style>
</head>
<body>
<div class="app-container">
  <aside id="sidebar" class="sidebar">
    <div class="sidebar-header">
      <h2>Recent Repos</h2>
      <button id="sidebarClose" class="sidebar-toggle" title="Close Sidebar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    </div>
    <div id="repoList" class="repo-list"></div>
  </aside>

  <main class="shell">
    <header class="topbar">
      <div class="topbar-inner">
        <div style="display: flex; align-items: center; gap: 12px;">
          <button id="sidebarToggle" class="sidebar-toggle" title="Toggle Sidebar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg>
          </button>
          <div>
            <h1 id="appTitle">GMC GitWeb</h1>
            <a id="repo" class="repo">Loading...</a>
          </div>
        </div>
        <div class="actions">
          <button id="openAccessSettings" class="settings-button" type="button" title="打开访问设置">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.08a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.08a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.08a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.18.63.77 1 1.43 1H21a2 2 0 1 1 0 4h-.08a1.7 1.7 0 0 0-1.52 1Z"></path></svg>
            <span>访问设置</span>
          </button>
        </div>
      </div>
    </header>
    <div class="shell-inner">
      <div id="installBanner" class="install-banner">
        <span class="install-text"> ⚠️ GMC Hooks is not installed - Installing git hooks can automatically generate commit messages. Git commit is available anywhere.</span>
        <button id="btnInstall" type="button">Install Hooks and Webloc</button>
      </div>
      <div id="dashboardPage">
  <section class="summary-panel">
    <div class="panel branch-summary-panel">
      <div class="branch-summary-text">
        <h2>Current Branch</h2>
        <div id="branch" class="branch-name">...</div>
        <div id="upstream" class="meta"></div>
      </div>
      <div id="calendar" class="calendar-grid"></div>
    </div>
    <div class="meters">
      <div class="meter"><strong id="ahead">0</strong><span>ahead</span> <button id="btnPush" class="action-btn" style="display:none">Push</button></div>
      <div class="meter"><strong id="behind">0</strong><span>behind</span> <button id="btnPull" class="action-btn">Pull</button></div>
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
      <div class="panel readme-panel">
        <div class="panel-head">
          <h2>README</h2>
        </div>
        <a id="readmeLink" class="readme-link" href="#">Open README</a>
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
      </div>
      <section id="accessSettingsPage" class="settings-page" hidden>
        <div class="settings-hero">
          <div>
            <h2>访问设置</h2>
            <p>管理局域网访问、刷新访问 token，并生成当前页面的扫码入口。移动设备扫码后会自动带上访问凭证，不需要手动输入长 token。</p>
          </div>
          <button id="closeAccessSettings" class="copy-button" type="button">Back</button>
        </div>
        <div class="settings-grid">
          <div class="settings-card">
            <div class="settings-row">
              <div class="settings-row-main">
                <strong>允许外部访问</strong>
                <span>开启后，局域网内已认证设备可以访问当前 GitWeb 服务。这个开关只能在运行 GMC 的主机上修改。</span>
              </div>
              <label class="toggle-control" title="Allow authenticated devices on the local network to access GitWeb">
                <input id="allowExternalAccess" type="checkbox">
                <span class="toggle-track" aria-hidden="true"></span>
                <span>External Access</span>
              </label>
            </div>
            <div class="settings-row">
              <div class="settings-row-main">
                <strong>刷新 token</strong>
                <span>刷新后旧 token 会立即失效，已经接入的设备需要重新扫码或使用新链接访问。</span>
              </div>
              <button id="rotateToken" class="copy-button" type="button">Refresh Token</button>
            </div>
            <div id="settingsHostOnlyWarning" class="settings-warning">当前页面不是从主机本机打开的，访问设置只能查看，不能修改。</div>
            <div id="settingAccessAddress" class="access-address"></div>
          </div>
          <div class="settings-card">
            <h3>扫码访问当前页面</h3>
            <p>二维码内容是当前页面 URL，并自动附带访问 token。建议只给可信设备扫码。</p>
            <div class="qr-shell">
              <div id="accessQrCode" class="qr-box"><div class="qr-placeholder">开启外部访问后生成二维码</div></div>
              <textarea id="accessUrlValue" class="access-url" readonly></textarea>
              <div class="settings-actions">
                <button id="copyAccessUrl" class="copy-button" type="button">Copy URL</button>
              </div>
              <div id="qrStatus" class="meta"></div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </main>
</div>

<aside id="drawer" class="drawer">
  <div class="drawer-head">
    <div>
      <h2 id="drawerTitle" style="margin: 0;">Commit</h2>
      <div id="drawerMeta" class="meta"></div>
    </div>
    <div class="drawer-actions">
      <button id="copyDetail" class="copy-button" type="button">Copy</button>
      <button id="closeDetail" class="copy-button close-button" type="button">Close</button>
    </div>
  </div>
  <pre id="message"></pre>
  <pre id="stat"></pre>
</aside>

<script>
var GMC_AUTH_TOKEN = ${JSON.stringify(clientAuthToken || '')};
var REQUEST_CONTEXT = ${JSON.stringify(publicSecuritySettings(null, req))};
var AUTH_QUERY_PARAM = ${JSON.stringify(AUTH_QUERY_PARAM)};
(function() {
  var nativeFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    init = init || {};
    var headers = new Headers(init.headers || {});
    var fetchUrl = new URL(typeof input === 'string' ? input : input.url, window.location.href);
    if (GMC_AUTH_TOKEN && fetchUrl.origin === window.location.origin) headers.set('X-GMC-Auth', GMC_AUTH_TOKEN);
    init.headers = headers;
    return nativeFetch(input, init);
  };
})();
var urlParams = new URLSearchParams(window.location.search);
var targetRepo = urlParams.get('repo') || '';
var initialReloadToken = ${JSON.stringify(RELOAD_TOKEN)};
var AUTO_STATUS_INTERVAL_MS = 10000;
var HIDDEN_STATUS_INTERVAL_MS = 60000;
var state = { auto: true, timer: null, loading: false, pendingForceLoad: false, graphTimer: null, statusSignature: null, commits: [], tasks: [], commitBranch: {}, branchParent: {}, sortedBranches: [], selected: {}, committing: false, ignoring: false, restoring: false, detailToken: 0, detailPinned: false, touchCommit: null, lastTouchCommitAt: 0, hideTimer: null, readmeLoaded: false, install: { hooks: true, webloc: true }, sidebarCollapsed: false, repoHistory: [], repoHistoryNeedsRefresh: true, contributions: null, settingsOpen: false, qrUrl: '', qrLoading: false, security: { allowExternalAccess: REQUEST_CONTEXT.allowExternalAccess === true, localAccess: REQUEST_CONTEXT.localAccess !== false, accessAddress: REQUEST_CONTEXT.accessAddress || '', lanAddress: REQUEST_CONTEXT.lanAddress || '' } };
var $ = function(id) { return document.getElementById(id); };

function updateReadmeLink() {
  var link = $('readmeLink');
  if (!link) return;
  if (!targetRepo) {
    link.removeAttribute('href');
    link.textContent = 'Select a repository first';
    return;
  }
  link.href = '/readme?repo=' + encodeURIComponent(targetRepo);
  link.textContent = 'Open README';
}

function updateRepoLink(text, repoPath) {
  var link = $('repo');
  if (!link) return;
  link.textContent = text;
  if (repoPath && canOpenRepositoryLocally()) {
    link.href = '#';
    link.title = 'Open in Finder: ' + repoPath;
  } else {
    link.removeAttribute('href');
    if (repoPath) {
      link.title = 'Finder opening is available only from 127.0.0.1.';
    } else {
      link.removeAttribute('title');
    }
  }
}

function openCurrentRepository(event) {
  if (event) event.preventDefault();
  if (!targetRepo) return;
  if (!canOpenRepositoryLocally()) return;
  fetch('/api/open-repository?repo=' + encodeURIComponent(targetRepo), { method: 'POST' })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
        return data;
      });
    })
    .catch(function(error) {
      alert('Open in Finder failed: ' + error.message);
    });
}

function canOpenRepositoryLocally() {
  return window.location.hostname === '127.0.0.1' ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '::1' ||
    window.location.hostname === '[::1]';
}

function loadRepoHistory() {
  return fetch('/api/repositories', { cache: 'no-store' })
    .then(function(res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function(data) {
      state.repoHistory = data.repositories || [];
      renderSidebar();
      return state.repoHistory;
    })
    .catch(function() {
      state.repoHistory = [];
      renderSidebar();
      return state.repoHistory;
    });
}

function renderSidebar() {
  var list = $('repoList');
  if (!list) return;
  var history = state.repoHistory || [];

  if (!history.length) {
    list.innerHTML = '<div class="repo-empty">No recent repositories yet.</div>';
    return;
  }

  list.innerHTML = history.map(function(item) {
    var name = item.name || repoDisplayName(item.path);
    var active = item.path === targetRepo ? ' active' : '';
    return '<div class="repo-item' + active + '" role="link" tabindex="0" data-repo="' + escapeHtml(item.path) + '">' +
      '<div class="repo-item-icon" aria-hidden="true">' + escapeHtml(repoInitial(name)) + '</div>' +
      '<div class="repo-item-body">' +
        '<div class="repo-item-name" title="' + escapeHtml(name) + '">' + escapeHtml(name) + '</div>' +
        '<div class="repo-item-path" title="' + escapeHtml(item.path) + '">' + escapeHtml(item.path) + '</div>' +
        '<div class="repo-item-time">' + escapeHtml(formatRepoVisit(item.lastVisited)) + '</div>' +
      '</div>' +
      '<button class="repo-remove" type="button" title="Remove from recent" aria-label="Remove ' + escapeHtml(name) + ' from recent repositories" data-repo="' + escapeHtml(item.path) + '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
      '</button>' +
    '</div>';
  }).join('');
}

function bindSidebarEvents() {
  var list = $('repoList');
  if (!list || list.dataset.bound === 'true') return;
  list.dataset.bound = 'true';

  list.addEventListener('click', function(event) {
    var removeButton = event.target.closest('.repo-remove');
    if (removeButton) {
      event.preventDefault();
      event.stopPropagation();
      removeRepoHistory(removeButton.getAttribute('data-repo'));
      return;
    }

    var item = event.target.closest('.repo-item');
    if (item) {
      openRepoFromHistory(item.getAttribute('data-repo'));
    }
  });

  list.addEventListener('keydown', function(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    var removeButton = event.target.closest('.repo-remove');
    if (removeButton) {
      event.preventDefault();
      removeRepoHistory(removeButton.getAttribute('data-repo'));
      return;
    }
    var item = event.target.closest('.repo-item');
    if (item) {
      event.preventDefault();
      openRepoFromHistory(item.getAttribute('data-repo'));
    }
  });
}

function openRepoFromHistory(repoPath) {
  if (!repoPath) return;
  window.location.href = '?repo=' + encodeURIComponent(repoPath);
}

function removeRepoHistory(repoPath) {
  if (!repoPath) return;
  fetch('/api/repositories/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: repoPath })
  })
    .then(function(res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function(data) {
      state.repoHistory = data.repositories || [];
      renderSidebar();
    })
    .catch(loadRepoHistory);
}

function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  localStorage.setItem('gmc_sidebar_collapsed', state.sidebarCollapsed);
  applySidebarState();
  refreshLayoutSoon();
}

function applySidebarState() {
  var sidebar = $('sidebar');
  var toggle = $('sidebarToggle');
  if (state.sidebarCollapsed) {
    sidebar.classList.add('collapsed');
  } else {
    sidebar.classList.remove('collapsed');
  }
  if (toggle) toggle.setAttribute('aria-expanded', state.sidebarCollapsed ? 'false' : 'true');
}

function refreshLayoutSoon() {
  refreshResponsiveContent();
  window.setTimeout(refreshResponsiveContent, 430);
}

function refreshResponsiveContent() {
  if (state.commits.length) renderGraph(state.commits);
  if (state.contributions) renderCalendar(state.contributions);
}

function initSidebar() {
  var saved = localStorage.getItem('gmc_sidebar_collapsed');
  if (saved !== null) {
    state.sidebarCollapsed = saved === 'true';
  } else {
    // Default: collapse on small screens, expand on large
    state.sidebarCollapsed = window.innerWidth < 1024;
  }
  applySidebarState();
  bindSidebarEvents();
  loadRepoHistory();
}

function initSecurityControls() {
  var external = $('allowExternalAccess');
  var rotate = $('rotateToken');
  if (!external || !rotate) return;
  renderSecurityControls();

  external.addEventListener('change', function() {
    if (!external.checked) {
      if (!confirm('Are you sure you want to disable External Access?\\n\\nOnce disabled, this setting can only be re-enabled from the machine where the GitWeb service is running.')) {
        external.checked = true;
        return;
      }
    }
    updateExternalAccess(external.checked);
  });
  rotate.addEventListener('click', rotateToken);
  $('openAccessSettings').addEventListener('click', openAccessSettings);
  $('closeAccessSettings').addEventListener('click', closeAccessSettings);
  $('copyAccessUrl').addEventListener('click', copyAccessUrl);
  loadSecuritySettings();
}

function openAccessSettings() {
  state.settingsOpen = true;
  $('dashboardPage').hidden = true;
  $('accessSettingsPage').hidden = false;
  renderSecurityControls();
  renderAccessQr();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function closeAccessSettings() {
  state.settingsOpen = false;
  $('accessSettingsPage').hidden = true;
  $('dashboardPage').hidden = false;
  refreshLayoutSoon();
}

function loadSecuritySettings() {
  return fetch('/api/security', { cache: 'no-store' })
    .then(function(res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function(settings) {
      state.security.allowExternalAccess = settings.allowExternalAccess === true;
      state.security.localAccess = settings.localAccess !== false;
      state.security.accessAddress = settings.accessAddress || state.security.accessAddress || '';
      state.security.lanAddress = settings.lanAddress || state.security.lanAddress || '';
      renderSecurityControls();
    })
    .catch(function() {
      renderSecurityControls();
    });
}

function renderSecurityControls() {
  var external = $('allowExternalAccess');
  var rotate = $('rotateToken');
  var lanAccess = $('lanAccess');
  var lanAddress = $('lanAccessAddress');
  var address = $('settingAccessAddress');
  var hostWarning = $('settingsHostOnlyWarning');
  var copyButton = $('copyAccessUrl');
  if (!external) return;
  var isLocal = state.security.localAccess !== false;

  if (lanAccess) {
    lanAccess.hidden = isLocal;
    lanAccess.classList.toggle('visible', !isLocal);
  }
  if (lanAddress) {
    lanAddress.textContent = state.security.accessAddress || window.location.hostname || 'LAN';
  }
  if (hostWarning) hostWarning.classList.toggle('visible', !isLocal);
  if (address) {
    var displayAddress = state.security.lanAddress || state.security.accessAddress || window.location.hostname || 'LAN';
    address.textContent = 'LAN address: ' + displayAddress;
    address.title = displayAddress;
  }

  external.checked = state.security.allowExternalAccess === true;
  if (copyButton) copyButton.disabled = state.security.allowExternalAccess !== true;
  renderAccessQr();
  if (!rotate) return;
  if (!isLocal) {
    rotate.setAttribute('aria-hidden', 'true');
    rotate.disabled = true;
    rotate.tabIndex = -1;
    external.disabled = true;
    return;
  }

  external.disabled = false;
  rotate.classList.add('visible');
  rotate.setAttribute('aria-hidden', state.security.allowExternalAccess === true ? 'false' : 'true');
  rotate.disabled = state.security.allowExternalAccess !== true;
  rotate.tabIndex = state.security.allowExternalAccess === true ? 0 : -1;
}

function updateExternalAccess(enabled) {
  var external = $('allowExternalAccess');
  if (external) external.disabled = true;
  fetch('/api/security/external-access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: enabled === true })
  })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
        return data;
      });
    })
    .then(function(settings) {
      state.security.allowExternalAccess = settings.allowExternalAccess === true;
      state.security.localAccess = settings.localAccess !== false;
      state.security.accessAddress = settings.accessAddress || state.security.accessAddress || '';
      state.security.lanAddress = settings.lanAddress || state.security.lanAddress || '';
      state.qrUrl = '';
      renderSecurityControls();
    })
    .catch(function(error) {
      state.security.allowExternalAccess = !enabled;
      renderSecurityControls();
      alert('Failed to update External Access settings: ' + error.message);
    })
    .finally(function() {
      if (external && state.security.localAccess !== false) external.disabled = false;
    });
}

function currentAccessUrl() {
  var accessUrl = new URL(window.location.href);
  accessUrl.hash = '';
  if (isLoopbackHost(accessUrl.hostname) && state.security.lanAddress) {
    accessUrl.hostname = state.security.lanAddress;
  }
  if (GMC_AUTH_TOKEN) accessUrl.searchParams.set(AUTH_QUERY_PARAM, GMC_AUTH_TOKEN);
  return accessUrl.toString();
}

function isLoopbackHost(hostname) {
  var host = String(hostname || '').replace(/^\\[|\\]$/g, '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function renderAccessQr() {
  var box = $('accessQrCode');
  var field = $('accessUrlValue');
  var status = $('qrStatus');
  if (!box || !field) return;
  if (!state.settingsOpen) return;
  if (state.security.allowExternalAccess !== true) {
    state.qrUrl = '';
    field.value = '';
    box.innerHTML = '<div class="qr-placeholder">开启外部访问后生成二维码</div>';
    if (status) status.textContent = '移动设备访问前，需要先允许外部访问。';
    return;
  }

  var accessUrl = currentAccessUrl();
  field.value = accessUrl;
  if (state.qrUrl === accessUrl || state.qrLoading) return;

  state.qrLoading = true;
  box.innerHTML = '<div class="qr-placeholder">正在生成二维码...</div>';
  if (status) status.textContent = '二维码包含当前页面 URL 和一次访问所需 token。';
  fetch('/api/security/qr-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: accessUrl })
  })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
        return data;
      });
    })
    .then(function(data) {
      state.qrUrl = accessUrl;
      box.innerHTML = data.svg || '<div class="qr-placeholder">二维码生成失败</div>';
    })
    .catch(function(error) {
      state.qrUrl = '';
      box.innerHTML = '<div class="qr-placeholder">二维码生成失败<br>' + escapeHtml(error.message) + '</div>';
      if (status) status.textContent = '请复制下方链接发送到移动设备。';
    })
    .finally(function() {
      state.qrLoading = false;
    });
}

function copyAccessUrl() {
  var field = $('accessUrlValue');
  if (!field || !field.value) return;
  copyText(field.value).then(function() {
    var status = $('qrStatus');
    if (status) status.textContent = '访问链接已复制。';
  }).catch(function() {
    field.focus();
    field.select();
  });
}

function rotateToken() {
  if (!state.security.allowExternalAccess || state.security.localAccess === false) return;
  var button = $('rotateToken');
  var status = $('qrStatus');
  if (button) {
    button.disabled = true;
    button.textContent = 'Updating...';
  }
  if (status) status.textContent = '正在刷新访问 token...';
  fetch('/api/security/rotate-token', { method: 'POST' })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
        return data;
      });
    })
    .then(function(data) {
      GMC_AUTH_TOKEN = data.token || '';
      state.qrUrl = '';
      renderAccessQr();
      if (status) status.textContent = '旧 token 已失效。使用新 token 需设备扫描新二维码，或复制下方新链接打开。';
    })
    .catch(function(error) {
      if (status) status.textContent = 'token 刷新失败：' + error.message;
      else alert('token update failed: ' + error.message);
    })
    .finally(function() {
      if (button) {
        button.disabled = false;
        button.textContent = 'Refresh Token';
      }
    });
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(function() {
      return copyTextWithSelection(text);
    });
  }
  return copyTextWithSelection(text);
}

function copyTextWithSelection(text) {
  return new Promise(function(resolve, reject) {
    var input = document.createElement('textarea');
    input.value = text;
    input.setAttribute('readonly', 'readonly');
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    try {
      if (document.execCommand('copy')) {
        resolve();
      } else {
        reject(new Error('Clipboard is unavailable'));
      }
    } catch (error) {
      reject(error);
    } finally {
      document.body.removeChild(input);
    }
  });
}

function repoDisplayName(repoPath) {
  var parts = String(repoPath || '').replace(/[\\\/]+$/, '').split(/[\\\/]+/);
  return parts[parts.length - 1] || repoPath || '';
}

function repoInitial(name) {
  var trimmed = String(name || '').trim();
  return (trimmed.charAt(0) || 'G').toUpperCase();
}

function formatRepoVisit(timestamp) {
  var time = Number(timestamp);
  if (!time) return 'Recently visited';
  var diff = Date.now() - time;
  var minute = 60 * 1000;
  var hour = 60 * minute;
  var day = 24 * hour;
  if (diff < minute) return 'Just now';
  if (diff < hour) return Math.floor(diff / minute) + 'm ago';
  if (diff < day) return Math.floor(diff / hour) + 'h ago';
  if (diff < day * 7) return Math.floor(diff / day) + 'd ago';
  return new Date(time).toLocaleDateString();
}

function setPageTitle(repoPath) {
  var title = repoPath ? ('GMC ' + repoDisplayName(repoPath)) : 'GMC GitWeb';
  document.title = title;
  $('appTitle').textContent = title;
}

setPageTitle(targetRepo);
updateReadmeLink();
initSecurityControls();

if (!targetRepo) {
  updateRepoLink('GMC GitWeb is running. Use "gmc web" in a git repository to view its status.', null);
  $('branch').textContent = 'No repository selected';
  initSidebar();
} else {
  updateRepoLink(targetRepo, targetRepo);
  initSidebar();
  load();
}

$('repo').addEventListener('click', openCurrentRepository);
$('sidebarToggle').addEventListener('click', toggleSidebar);
$('sidebarClose').addEventListener('click', toggleSidebar);

$('drawer').addEventListener('mouseenter', function() {
  clearTimeout(state.hideTimer);
});
$('drawer').addEventListener('mouseleave', function() {
  hideCommit();
});
$('copyDetail').addEventListener('click', copyCommitDetail);
$('closeDetail').addEventListener('click', closeCommitDetail);
$('btnInstall').addEventListener('click', installGmc);
bindCommitDetailEvents();
window.addEventListener('resize', function() {
  if (state.commits.length) renderGraph(state.commits);
  if (state.contributions) renderCalendar(state.contributions);
});
document.addEventListener('visibilitychange', function() {
  if (!document.hidden && state.auto && targetRepo) {
    load({ force: true });
  } else {
    schedule();
  }
});

if (${process.env.GMC_GITWEB_LIVE_RELOAD ? 'true' : 'false'}) {
  setInterval(function() {
    fetch('/api/ping', { cache: 'no-store' })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.reloadToken && data.reloadToken !== initialReloadToken) {
          window.location.reload();
        }
      })
      .catch(function() {});
  }, 1000);
}

function schedule() {
  clearTimeout(state.timer);
  if (!state.auto || !targetRepo) return;
  state.timer = setTimeout(load, document.hidden ? HIDDEN_STATUS_INTERVAL_MS : AUTO_STATUS_INTERVAL_MS);
}

function load(options) {
  options = options || {};
  if (!targetRepo) return Promise.resolve(false);
  if (state.loading) {
    if (options.force) state.pendingForceLoad = true;
    return Promise.resolve(false);
  }
  state.loading = true;
  return fetch('/api/status?repo=' + encodeURIComponent(targetRepo), { cache: 'no-store' })
    .then(function(res) { 
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json(); 
    })
    .then(function(data) {
      var signature = statusSignature(data);
      if (!options.force && signature === state.statusSignature) {
        return false;
      }
      state.statusSignature = signature;
      render(data);
      return true;
    })
    .then(function(didRender) {
      if (didRender && state.repoHistoryNeedsRefresh) {
        state.repoHistoryNeedsRefresh = false;
        return loadRepoHistory();
      }
    })
    .catch(function(error) {
      updateRepoLink('Error loading status: ' + error.message, null);
    })
    .finally(function() {
      state.loading = false;
      if (state.pendingForceLoad) {
        state.pendingForceLoad = false;
        return load({ force: true });
      }
      schedule();
    });
}

function statusSignature(data) {
  if (!data || data.error) return JSON.stringify(data || {});
  return JSON.stringify({
    repository: data.repository,
    branch: data.branch,
    status: data.status,
    stats: data.stats,
    branches: data.branches,
    commits: data.commits,
    contributions: data.contributions,
    binding: data.binding,
    tasks: data.tasks,
    install: data.install
  });
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
    updateRepoLink('Error: ' + data.error, null);
    return;
  }
  updateRepoLink(data.repository && data.repository.root ? data.repository.root : targetRepo, targetRepo);
  $('branch').textContent = data.branch.current;
  $('upstream').textContent = data.branch.upstream || 'No upstream';
  $('ahead').textContent = data.branch.ahead;
  $('btnPush').style.display = data.branch.ahead > 0 ? 'inline-block' : 'none';
  $('btnPush').onclick = function(event) { executeAction('/api/push', 'Pushing...', event.currentTarget); };
  
  $('behind').textContent = data.branch.behind;
  $('btnPull').onclick = function(event) { executeAction('/api/pull', 'Pulling...', event.currentTarget); };
  
  $('dirty').textContent = data.status.files.length;
  
  state.tasks = data.tasks || [];
  state.install = data.install || { hooks: true, webloc: true };
  renderInstallBanner();
  
  state.contributions = data.contributions || {};
  renderCalendar(state.contributions);
  renderFiles(data.status.files);
  
  processTopology(data);
  renderBranches();
  renderCommits(state.commits);
  
  clearTimeout(state.graphTimer);
  state.graphTimer = setTimeout(function() { renderGraph(state.commits); }, 50);
}

function renderInstallBanner() {
  var banner = $('installBanner');
  if (!banner) return;
  var needsInstall = !state.install.hooks || !state.install.webloc;
  if (needsInstall) {
    banner.classList.add('visible');
  } else {
    banner.classList.remove('visible');
  }
}

function installGmc() {
  var btn = $('btnInstall');
  if (btn) { btn.disabled = true; btn.textContent = 'Installing...'; }
  fetch('/api/install?repo=' + encodeURIComponent(targetRepo), { method: 'POST' })
    .then(function(res) { return res.json().then(function(data) { if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status); return data; }); })
    .then(function(data) {
      state.install = data.install || { hooks: true, webloc: true };
      renderInstallBanner();
      if (btn) { btn.textContent = 'Installed'; }
    })
    .catch(function(err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Install Failed'; }
      alert('Install failed: ' + err.message);
    });
}

function addCalendarDays(date, days) {
  var d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + days);
  return d;
}

function calendarDateKey(date) {
  var y = date.getFullYear();
  var m = date.getMonth() + 1;
  var d = date.getDate();
  return y + '-' + (m < 10 ? '0' + m : m) + '-' + (d < 10 ? '0' + d : d);
}

function renderCalendar(contributions) {
  var cal = $('calendar');
  if (!cal || !contributions) return;
  var styles = window.getComputedStyle(cal);
  var cellSize = parseFloat(styles.getPropertyValue('--calendar-cell')) || 10;
  var gapSize = parseFloat(styles.getPropertyValue('--calendar-gap')) || 3;
  var labelWidth = parseFloat(styles.getPropertyValue('--calendar-label-width')) || 24;
  var availableWidth = cal.clientWidth || cal.parentElement && cal.parentElement.clientWidth || 0;
  var maxColumns = Math.floor((availableWidth - labelWidth - 6 + gapSize) / (cellSize + gapSize));
  var columns = Math.max(8, Math.min(54, maxColumns || 54));
  var monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var weekdays = ['Sun', '', '', 'Wed', '', '', 'Sat'];
  var now = new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var currentWeekStart = addCalendarDays(today, -today.getDay());
  var start = addCalendarDays(currentWeekStart, -(columns - 1) * 7);
  var monthHtml = '';
  var weekdayHtml = '';
  var weeksHtml = '';

  weekdays.forEach(function (day) {
    weekdayHtml += '<div class="calendar-weekday">' + day + '</div>';
  });

  for (var c = 0; c < columns; c++) {
    var weekStart = addCalendarDays(start, c * 7);
    var monthLabel = '';
    for (var mr = 0; mr < 7; mr++) {
      var md = addCalendarDays(weekStart, mr);
      if ((c === 0 && mr === 0) || md.getDate() === 1) {
        monthLabel = monthNames[md.getMonth()];
        break;
      }
    }
    monthHtml += '<div class="calendar-month">' + monthLabel + '</div>';
    weeksHtml += '<div class="calendar-col">';
    for (var r = 0; r < 7; r++) {
      var d = addCalendarDays(weekStart, r);
      if (d > now) {
        weeksHtml += '<div class="calendar-cell empty"></div>';
        continue;
      }
      var ds = calendarDateKey(d);
      var count = contributions[ds] || 0;
      var level = count > 10 ? 4 : count > 5 ? 3 : count > 2 ? 2 : count > 0 ? 1 : 0;
      weeksHtml += '<div class="calendar-cell" data-level="' + level + '" title="' + count + ' commits on ' + ds + '"></div>';
    }
    weeksHtml += '</div>';
  }
  cal.innerHTML = '<div class="calendar-months">' + monthHtml + '</div>' +
    '<div class="calendar-weekdays">' + weekdayHtml + '</div>' +
    '<div class="calendar-weeks">' + weeksHtml + '</div>';
}

function setActionButtonWorking(button) {
  if (!button) return null;
  var previous = {
    disabled: button.disabled,
    text: button.textContent
  };
  button.disabled = true;
  button.textContent = 'Working...';
  return previous;
}

function restoreActionButton(button, previous) {
  if (!button || !previous) return;
  button.disabled = previous.disabled;
  button.textContent = previous.text;
}

function executeAction(url, loadingMsg, button) {
  if (button && button.disabled) return;
  var buttonState = setActionButtonWorking(button);
  var prevAuto = state.auto;
  state.auto = false;
  clearTimeout(state.timer);
  setCommitStatus(loadingMsg, false);
  fetch(url + '?repo=' + encodeURIComponent(targetRepo), { method: 'POST' })
    .then(function(res) { return res.json().then(function(data) { if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status); return data; }); })
    .then(function(data) { setCommitStatus('Success: ' + firstLine(data.output), false); })
    .catch(function(err) { setCommitStatus('Error: ' + err.message, true); })
    .finally(function() {
      state.auto = prevAuto;
      return load({ force: true });
    })
    .finally(function() {
      restoreActionButton(button, buttonState);
    });
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

  if (!state.install.hooks) {
    var choice = confirm(
      'GMC Git Hooks is not installed!\\n\\n' +
      'After installing hooks, each git commit -m gmc will automatically trigger AI-assisted commit message generation.\\n\\n' +
      'Click "ok" to install hooks and commit\\n' +
      'Click "cancel" to use AI to generate commit message directly this time (slower)'
    );
    if (choice) {
      // Install hooks first, then commit
      var btn = $('btnInstall');
      if (btn) { btn.disabled = true; btn.textContent = 'Installing...'; }
      setCommitStatus('Installing hooks...', false);
      fetch('/api/install?repo=' + encodeURIComponent(targetRepo), { method: 'POST' })
        .then(function(res) { return res.json().then(function(data) { if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status); return data; }); })
        .then(function(data) {
          state.install = data.install || { hooks: true, webloc: true };
          renderInstallBanner();
          if (btn) { btn.textContent = 'Installed'; }
          doCommit(files);
        })
        .catch(function(err) {
          if (btn) { btn.disabled = false; btn.textContent = 'Install Failed'; }
          setCommitStatus('Hook install failed: ' + err.message, true);
        });
      return;
    }
    // User declined install, proceed with direct AI commit
  }

  doCommit(files);
}

function doCommit(files) {
  state.committing = true;
  var statusMsg = state.install.hooks ? 'Committing selected files...' : 'Generating AI commit message and committing...';
  setCommitStatus(statusMsg, false);
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
      load({ force: true });
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
      load({ force: true });
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
      load({ force: true });
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
      aiStatus = '<span class="ai-status" title="AI is generating a commit message" aria-label="AI is generating a commit message">' +
        '<svg class="ai-status-loader" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M21 12a9 9 0 0 0-9-9"></path></svg>' +
        '<svg class="ai-status-sparkles" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l1.8 5.1 5.1 1.8-5.1 1.8-1.8 5.1-1.8-5.1-5.1-1.8 5.1-1.8L12 2.5z"></path><path d="M5.4 14.2l.9 2.5 2.5.9-2.5.9-.9 2.5-.9-2.5-2.5-.9 2.5-.9.9-2.5z"></path></svg>' +
      '</span>';
    }
    return '<article class="commit" role="button" tabindex="0" data-oid="' + escapeHtml(c.hash) + '" onmouseenter="showCommit(\\'' + c.hash + '\\', this)" onmouseleave="hideCommit()"><div><div class="subject">' + escapeHtml(c.subject || '(no subject)') + aiStatus + '</div><div class="meta"><span class="hash" style="color:' + cColor + '">' + escapeHtml(c.shortHash) + '</span> &bull; ' + escapeHtml(c.author) + ' &bull; ' + escapeHtml(date) + (bName ? ' &bull; ' + escapeHtml(bName) : '') + '</div></div></article>';
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
    svgHTML += '<circle cx="' + cx + '" cy="' + cy + '" r="' + nodeRadius + '" fill="' + node.color + '" stroke="#ffffff" stroke-width="2" class="node" data-oid="' + escapeHtml(node.hash) + '" onmouseenter="showCommit(\\'' + node.hash + '\\', this)" onmouseleave="hideCommit()" />';
  });

  if (graphBox) graphBox.style.setProperty('--graph-width', graphWidth + 'px');
  graphSvg.setAttribute('width', graphWidth);
  graphSvg.setAttribute('height', graphHeight);
  graphSvg.setAttribute('viewBox', '0 0 ' + graphWidth + ' ' + graphHeight);
  graphSvg.style.width = graphWidth + 'px';
  graphSvg.style.height = graphHeight + 'px';
  graphSvg.innerHTML = svgHTML;
}

function bindCommitDetailEvents() {
  var timeline = document.querySelector('.timeline-container');
  if (!timeline || timeline.dataset.commitDetailBound === 'true') return;
  timeline.dataset.commitDetailBound = 'true';

  timeline.addEventListener('click', function(event) {
    var target = commitDetailTarget(event);
    if (!target) return;
    if (Date.now() - state.lastTouchCommitAt < 500) return;
    event.preventDefault();
    showCommit(target.getAttribute('data-oid'), target, true);
  });

  timeline.addEventListener('keydown', function(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    var target = commitDetailTarget(event);
    if (!target) return;
    event.preventDefault();
    showCommit(target.getAttribute('data-oid'), target, true);
  });

  timeline.addEventListener('touchstart', function(event) {
    var target = commitDetailTarget(event);
    if (!target || !event.touches || !event.touches.length) return;
    var touch = event.touches[0];
    state.touchCommit = {
      target: target,
      oid: target.getAttribute('data-oid'),
      x: touch.clientX,
      y: touch.clientY,
      moved: false
    };
  }, { passive: true });

  timeline.addEventListener('touchmove', function(event) {
    if (!state.touchCommit || !event.touches || !event.touches.length) return;
    var touch = event.touches[0];
    if (Math.abs(touch.clientX - state.touchCommit.x) > 10 || Math.abs(touch.clientY - state.touchCommit.y) > 10) {
      state.touchCommit.moved = true;
    }
  }, { passive: true });

  timeline.addEventListener('touchend', function() {
    if (!state.touchCommit) return;
    var touchCommit = state.touchCommit;
    state.touchCommit = null;
    if (touchCommit.moved) return;
    state.lastTouchCommitAt = Date.now();
    showCommit(touchCommit.oid, touchCommit.target, true);
  }, { passive: true });
}

function commitDetailTarget(event) {
  var target = event.target && event.target.closest ? event.target.closest('[data-oid]') : null;
  if (!target) return null;
  var timeline = document.querySelector('.timeline-container');
  if (!timeline || !timeline.contains(target)) return null;
  return target;
}

window.showCommit = function(oid, trigger, pinned) {
  if (!targetRepo) return;
  if (!pinned && Date.now() - state.lastTouchCommitAt < 800) return;
  state.detailPinned = !!pinned;
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
  if (state.detailPinned) return;
  clearTimeout(state.hideTimer);
  state.hideTimer = setTimeout(function() {
    state.detailToken++;
    $('drawer').classList.remove('open');
  }, 1000);
};

function closeCommitDetail() {
  clearTimeout(state.hideTimer);
  state.detailPinned = false;
  state.detailToken++;
  $('drawer').classList.remove('open');
}

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

function readmeHtml(clientAuthToken) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GMC README</title>
${faviconLink()}
<style>
:root { color-scheme: light; --bg: #f4f6f8; --panel: #ffffff; --text: #111827; --muted: #6b7280; --line: #dbe2ea; --line-soft: #edf1f5; --accent: #068d6dff; --accent-soft: #eff6ff; }
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text); font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body { background: linear-gradient(180deg, #ffffff 0, var(--bg) 280px); }
.shell { width: min(980px, calc(100% - 32px)); margin: 0 auto; padding: 24px 0 40px; }
.topbar { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 18px; }
h1 { margin: 0; font-size: 24px; font-weight: 760; letter-spacing: 0; line-height: 1.12; }
.repo { display: block; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; margin-top: 4px; overflow-wrap: anywhere; text-decoration: none; }
.repo[href]:hover { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
.button { display: inline-flex; align-items: center; min-height: 34px; padding: 7px 12px; border: 1px solid var(--line); border-radius: 7px; color: var(--accent); background: #fff; text-decoration: none; font-weight: 650; white-space: nowrap; }
.button:hover { border-color: var(--accent); background: var(--accent-soft); }
.panel { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 18px; box-shadow: 0 1px 2px rgba(15, 23, 42, .04); }
.readme-body { font-size: 14px; line-height: 1.65; overflow-wrap: break-word; word-break: break-word; }
.readme-body h1, .readme-body h2, .readme-body h3, .readme-body h4 { margin: 1.2em 0 .6em; font-weight: 700; }
.readme-body h1 { font-size: 24px; border-bottom: 1px solid var(--line-soft); padding-bottom: 6px; }
.readme-body h2 { font-size: 19px; border-bottom: 1px solid var(--line-soft); padding-bottom: 4px; }
.readme-body h3 { font-size: 16px; }
.readme-body p { margin: .6em 0; }
.readme-body ul, .readme-body ol { padding-left: 24px; margin: .5em 0; }
.readme-body li { margin: .3em 0; }
.readme-body pre { background: #f1f5f9; border: 1px solid var(--line-soft); border-radius: 6px; padding: 12px; overflow-x: auto; font-size: 13px; line-height: 1.5; }
.readme-body code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; background: #f1f5f9; padding: 2px 5px; border-radius: 4px; }
.readme-body pre code { background: none; padding: 0; font-size: inherit; }
.readme-body blockquote { margin: .6em 0; padding: 4px 14px; border-left: 3px solid var(--accent); background: var(--accent-soft); border-radius: 0 6px 6px 0; color: #334155; }
.readme-body table { border-collapse: collapse; margin: .8em 0; width: 100%; }
.readme-body th, .readme-body td { border: 1px solid var(--line-soft); padding: 6px 10px; text-align: left; }
.readme-body th { background: #f8fafc; font-weight: 700; }
.readme-body img { max-width: 100%; border-radius: 6px; }
.readme-body a { color: var(--accent); text-decoration: none; }
.readme-body a:hover { text-decoration: underline; }
.readme-body .mermaid { margin: .8em 0; overflow-x: auto; }
.readme-help pre { white-space: pre-wrap; }
.meta { color: var(--muted); font-size: 12px; }
@media (max-width: 620px) { .topbar { flex-direction: column; } .shell { width: min(100% - 24px, 980px); padding-top: 16px; } }
</style>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
</head>
<body>
<main class="shell">
  <header class="topbar">
    <div>
      <h1 id="title">README</h1>
      <a id="repo" class="repo"></a>
    </div>
    <a id="backLink" class="button" href="/">Back to GitWeb</a>
  </header>
  <section class="panel">
    <div id="readmeBody" class="readme-body"><div class="meta">Loading README...</div></div>
  </section>
</main>
<script>
mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'loose' });
var GMC_AUTH_TOKEN = ${JSON.stringify(clientAuthToken || '')};
(function() {
  var nativeFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    init = init || {};
    var headers = new Headers(init.headers || {});
    var fetchUrl = new URL(typeof input === 'string' ? input : input.url, window.location.href);
    if (GMC_AUTH_TOKEN && fetchUrl.origin === window.location.origin) headers.set('X-GMC-Auth', GMC_AUTH_TOKEN);
    init.headers = headers;
    return nativeFetch(input, init);
  };
})();
var urlParams = new URLSearchParams(window.location.search);
var targetRepo = urlParams.get('repo') || '';
var bodyEl = document.getElementById('readmeBody');
updateRepoLink(targetRepo || 'No repository selected', targetRepo);
document.getElementById('backLink').href = targetRepo ? '/?repo=' + encodeURIComponent(targetRepo) : '/';
document.getElementById('repo').addEventListener('click', openCurrentRepository);

if (!targetRepo) {
  bodyEl.innerHTML = '<div class="meta">No repository selected.</div>';
} else {
  fetch('/api/readme?repo=' + encodeURIComponent(targetRepo), { cache: 'no-store' })
    .then(function(res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(renderReadme)
    .catch(function(err) {
      bodyEl.innerHTML = '<div class="meta">Failed to load README: ' + escapeHtml(err.message) + '</div>';
    });
}

function renderReadme(data) {
  if (data.type === 'help') {
    document.getElementById('title').textContent = 'GMC HELP';
    bodyEl.className = 'readme-body readme-help';
    bodyEl.innerHTML = '<pre>' + escapeHtml(data.content) + '</pre>';
    return;
  }

  document.getElementById('title').textContent = 'README';
  bodyEl.className = 'readme-body';
  bodyEl.innerHTML = marked.parse(data.content || '', { gfm: true, breaks: false });

  var codeBlocks = bodyEl.querySelectorAll('pre code.language-mermaid');
  codeBlocks.forEach(function(codeEl) {
    var pre = codeEl.parentElement;
    var mermaidDiv = document.createElement('div');
    mermaidDiv.className = 'mermaid';
    mermaidDiv.textContent = codeEl.textContent;
    pre.parentNode.replaceChild(mermaidDiv, pre);
  });

  try {
    mermaid.run({ nodes: bodyEl.querySelectorAll('.mermaid') });
  } catch (e) {
    console.warn('Mermaid rendering error:', e);
  }
}

function updateRepoLink(text, repoPath) {
  var link = document.getElementById('repo');
  link.textContent = text;
  if (repoPath && canOpenRepositoryLocally()) {
    link.href = '#';
    link.title = 'Open in Finder: ' + repoPath;
  } else {
    link.removeAttribute('href');
    if (repoPath) {
      link.title = 'Finder opening is available only from 127.0.0.1.';
    } else {
      link.removeAttribute('title');
    }
  }
}

function openCurrentRepository(event) {
  if (event) event.preventDefault();
  if (!targetRepo) return;
  if (!canOpenRepositoryLocally()) return;
  fetch('/api/open-repository?repo=' + encodeURIComponent(targetRepo), { method: 'POST' })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
        return data;
      });
    })
    .catch(function(error) {
      alert('Open in Finder failed: ' + error.message);
    });
}

function canOpenRepositoryLocally() {
  return window.location.hostname === '127.0.0.1' ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '::1' ||
    window.location.hostname === '[::1]';
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

function quit(port) {
  return new Promise(function (resolve) {
    var req = http.request({
      hostname: '127.0.0.1',
      port: port,
      path: '/api/quit',
      method: 'POST',
      headers: {
        'X-GMC-Auth': getAuthToken()
      }
    }, function (res) {
      res.on('data', function () { });
      res.on('end', resolve);
    });
    req.on('error', function () {
      resolve();
    });
    req.setTimeout(1000, function () {
      req.destroy();
      resolve();
    });
    req.end();
  });
}

module.exports = {
  start: start,
  collectStatus: collectStatus,
  checkRunning: checkRunning,
  quit: quit,
  resolveWeblocPort: resolveWeblocPort,
  createWebloc: createWebloc,
  authenticatedUrl: authenticatedUrl,
  openBrowser: openBrowser,
  DEFAULT_PORT: DEFAULT_PORT
};
