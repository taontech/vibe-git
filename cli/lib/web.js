'use strict';

var childProcess = require('child_process');
var crypto = require('crypto');
var fs = require('fs');
var http = require('http');
var net = require('net');
var os = require('os');
var path = require('path');
var url = require('url');
var autogmc = require('./autogmc');
var agent = require('./agent');
var config = require('./config');
var commitMessage = require('./commit-message');
var git = require('./git');
var prompts = require('./prompts');
var taskStatus = require('./task-status');

var DEFAULT_PORT = 4277;
var GITWEB_VERSION = 2;
var DIFF_LIMIT = 120000;
var RELOAD_TOKEN = process.env.GMC_GITWEB_RELOAD_TOKEN || String(Date.now());
var RECENT_REPOS_FILE = path.join(os.homedir(), '.config', 'gmc', 'recent-repos.json');
var CONTRIBUTIONS_CACHE_FILE = path.join(os.homedir(), '.config', 'gmc', 'contributions-cache.json');
var AUTH_TOKEN_FILE = path.join(os.homedir(), '.config', 'gmc', 'gitweb-token');
var SECURITY_SETTINGS_FILE = path.join(os.homedir(), '.config', 'gmc', 'gitweb-security.json');
var AUTH_QUERY_PARAM = 'gmc_auth';
var AUTH_COOKIE = 'gmc_gitweb_auth';
var RECENT_REPOS_LIMIT = 20;
var RECENT_REPOS_VISIT_INTERVAL_MS = 10 * 60 * 1000;
var STATUS_CACHE_TTL_MS = process.env.GMC_STATUS_CACHE_MS ? Number(process.env.GMC_STATUS_CACHE_MS) : 10000;
var TASK_EVENT_DEBOUNCE_MS = 100;
var TASK_EVENT_HEARTBEAT_MS = 15000;
var AGENT_MONITOR_DEFAULT_PORT = 8898;
var AGENT_MONITOR_TIMEOUT_MS = 1500;
var AGENT_MONITOR_MAX_RESPONSE_BYTES = 256 * 1024;
var TASK_AGENT_STATUSES = ['codex', 'claude', 'antigravity'];
var TASK_STATUSES = ['todo', 'codex', 'claude', 'antigravity', 'doing', 'review', 'done'];
var recentRepoVisitTimes = {};
var statusCache = {};
var repoQuickStatusCache = {};
var REPO_STATUS_CACHE_TTL_MS = 20000;
var taskEventChannels = Object.create(null);
var agentMonitorRuntime = null;
var shutdownHandler = null;

function start(root, options) {
  options = options || {};
  if (options.agentMonitor || options.monitor) {
    agentMonitorRuntime = options.agentMonitor || options.monitor;
  }
  shutdownHandler = typeof options.onQuit === 'function' ? options.onQuit : null;
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
      var timer = setTimeout(function () {
        if (!res.writableEnded && !res.gmcLongLived) {
          res.writeHead(408, { 'Content-Type': 'text/plain; charset=utf-8', 'Connection': 'close' });
          res.end('Request timeout');
        }
      }, 120000);
      res.on('close', function () { clearTimeout(timer); });
      res.on('finish', function () { clearTimeout(timer); });
      handleRequest(req, res);
    });
    server.on('upgrade', handleAgentMonitorUpgrade);
    server.timeout = 30000;
    server.keepAliveTimeout = 10000;
    server.headersTimeout = 15000;
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
  var reqT0 = Date.now();
  var reqPath;
  try {
    var parsed = url.parse(req.url, true);
    reqPath = parsed.pathname;

    if (req.method === 'OPTIONS') {
      setCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

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
        handleQuit(res);
        return;
      }
      if (parsed.pathname === '/api/commit-selected') {
        handleCommitSelected(req, res, parsed.query.repo);
        return;
      }
      if (parsed.pathname === '/api/stage-selected') {
        handleStageSelected(req, res, parsed.query.repo);
        return;
      }
      if (parsed.pathname === '/api/unstage-selected') {
        handleUnstageSelected(req, res, parsed.query.repo);
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
      if (parsed.pathname === '/api/checkout-branch') {
        handleCheckoutBranch(req, res, parsed.query.repo);
        return;
      }
      if (parsed.pathname === '/api/install') {
        handleInstall(req, res, parsed.query.repo);
        return;
      }
      if (parsed.pathname === '/api/open-app') {
        handleOpenApp(req, res);
        return;
      }
      if (parsed.pathname === '/api/git-config') {
        handleUpdateGitConfig(req, res);
        return;
      }
      if (parsed.pathname === '/api/open-repository') {
        handleOpenRepository(req, res, parsed.query.repo);
        return;
      }
      if (parsed.pathname === '/api/open-terminal') {
        handleOpenTerminal(req, res, parsed.query.repo);
        return;
      }
      if (parsed.pathname === '/api/open-agent') {
        handleOpenAgent(req, res, parsed.query.repo, parsed.query.agent);
        return;
      }
      if (parsed.pathname === '/api/open-ide') {
        handleOpenIde(req, res, parsed.query.repo);
        return;
      }
      if (parsed.pathname === '/api/repositories/remove') {
        handleRemoveRepository(req, res);
        return;
      }
      if (parsed.pathname === '/api/add-repository' ||
          parsed.pathname === '/api/select-repository' ||
          parsed.pathname === '/api/create-repository') {
        handleAddRepository(req, res);
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
      if (parsed.pathname === '/api/agent') {
        handleSetAgent(req, res, parsed.query.repo);
        return;
      }
      if (parsed.pathname === '/api/tasks/create') {
        handleCreateTask(req, res, parsed.query.repo);
        return;
      }
      if (parsed.pathname === '/api/tasks/decompose') {
        handleDecomposeTask(req, res, parsed.query.repo);
        return;
      }
      if (parsed.pathname === '/api/tasks/update') {
        handleUpdateTask(req, res, parsed.query.repo);
        return;
      }
      if (parsed.pathname === '/api/tasks/delete') {
        handleDeleteTask(req, res, parsed.query.repo);
        return;
      }
      if (parsed.pathname === '/api/merge/resolve-file') {
        handleMergeResolveFile(req, res, parsed.query.repo);
        return;
      }
      if (parsed.pathname === '/api/merge/accept-file') {
        handleMergeAcceptFile(req, res, parsed.query.repo);
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
      var forceRepos = Boolean(parsed.query && parsed.query.force === '1');
      var repoList = readRecentRepositories(forceRepos);
      sendJson(res, { repositories: attachRepoStatus(repoList, forceRepos) });
      return;
    }

    if (parsed.pathname === '/api/git-overview') {
      handleGetGitOverview(req, res, parsed);
      return;
    }

    if (parsed.pathname === '/api/city-data') {
      handleGetCityData(req, res, parsed);
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

    if (parsed.pathname === '/api/agent-monitor') {
      handleAgentMonitor(req, res);
      return;
    }

    if (parsed.pathname === '/api/agent') {
      var currentAgent = 'codex';
      var currentCommitAgent = 'codex';
      var currentTaskAgent = 'codex';
      var currentRepositoryTaskAgent = null;
      try {
        currentAgent = config.currentAgent();
      } catch (ignore) {
        // ignore
      }
      try {
        currentCommitAgent = config.currentCommitAgent();
      } catch (ignoreCommitAgent) {
        currentCommitAgent = currentAgent;
      }
      try {
        currentTaskAgent = config.currentTaskAgent();
      } catch (ignoreTaskAgent) {
        currentTaskAgent = currentAgent;
      }
      if (parsed.query.repo) {
        try {
          currentRepositoryTaskAgent = config.currentRepositoryTaskAgent(parsed.query.repo);
        } catch (ignoreRepositoryTaskAgent) {
          currentRepositoryTaskAgent = currentTaskAgent;
        }
      }
      sendJson(res, {
        agent: currentAgent,
        commitAgent: currentCommitAgent,
        taskAgent: currentTaskAgent,
        repositoryTaskAgent: currentRepositoryTaskAgent
      });
      return;
    }

    if (parsed.pathname.startsWith('/icons/')) {
      var iconPath = path.join(__dirname, 'icons', path.basename(parsed.pathname));
      if (fs.existsSync(iconPath)) {
        var svg = fs.readFileSync(iconPath, 'utf8');
        send(res, 200, 'image/svg+xml; charset=utf-8', svg);
      } else {
        send(res, 404, 'text/plain; charset=utf-8', 'Icon not found');
      }
      return;
    }

    var targetRepo = parsed.query.repo;
    if (!targetRepo) {
      if (parsed.pathname.startsWith('/api/')) {
        throwHttpError('Missing repo parameter');
      }
      send(res, 200, 'text/html; charset=utf-8', webHtml(getAuthToken(), req));
      return;
    }

    if (parsed.pathname === '/api/status') {
      var cached = getCachedStatus(targetRepo);
      if (cached) {
        sendJson(res, cached);
      } else {
        var statusResult = collectStatus(targetRepo);
        setCachedStatus(targetRepo, statusResult);
        sendJson(res, statusResult);
      }
      return;
    }

    if (parsed.pathname === '/api/events') {
      handleTaskEvents(req, res, targetRepo);
      return;
    }

    if (parsed.pathname === '/api/readme') {
      sendJson(res, readmeContent(targetRepo));
      return;
    }

    if (parsed.pathname === '/api/repository-tree') {
      sendJson(res, repositoryTree(targetRepo, parsed.query.path, parsed.query.recursive === '1'));
      return;
    }

    if (parsed.pathname === '/api/repository-file') {
      sendJson(res, repositoryFile(targetRepo, parsed.query.path));
      return;
    }

    if (parsed.pathname === '/api/file-diff') {
      sendJson(res, fileDiff(targetRepo, parsed.query.path));
      return;
    }

    if (parsed.pathname === '/api/tasks') {
      var tasksT0 = Date.now();
      var tasksResult = readRepositoryTasks(targetRepo);
      tasksResult.timings = { total: Date.now() - tasksT0 };
      sendJson(res, tasksResult);
      return;
    }

    if (parsed.pathname === '/api/commit') {
      sendJson(res, commitDetails(targetRepo, parsed.query.oid));
      return;
    }

    if (parsed.pathname === '/api/merge/conflict-detail') {
      handleMergeConflictDetail(req, res, targetRepo);
      return;
    }

    if (parsed.pathname === '/api/detect-project') {
      sendJson(res, detectProjectType(targetRepo));
      return;
    }

    send(res, 404, 'text/plain; charset=utf-8', 'Not found');
  } catch (error) {
    logRequestTiming(reqPath, reqT0, error);
    sendJsonError(res, error.httpStatus || 500, error.message);
  }
}

function handleQuit(res) {
  var shutdown;
  try {
    shutdown = shutdownHandler ? shutdownHandler() : null;
  } catch (error) {
    shutdown = Promise.reject(error);
  }
  Promise.resolve(shutdown).catch(function (error) {
    console.error('GMC Web shutdown cleanup failed: ' + error.message);
  }).then(function () {
    sendJson(res, { status: 'ok' });
    setTimeout(function () {
      process.exit(0);
    }, 100);
  });
}

function handleAgentMonitor(req, res) {
  var monitor = resolveAgentMonitorConfig();
  if (!monitor.enabled) {
    sendJson(res, agentMonitorUnavailable('disabled'));
    return;
  }
  if (monitor.healthy === false) {
    sendJson(res, agentMonitorUnavailable(monitor.reason || 'unavailable'));
    return;
  }

  requestAgentMonitorAgents(monitor).then(function (result) {
    sendJson(res, {
      status: 'ok',
      available: true,
      agents: result.agents,
      usage: result.usage || null,
      fetchedAt: new Date().toISOString()
    });
  }).catch(function (error) {
    var reason = error && error.agentMonitorReason || 'unavailable';
    var status = reason === 'invalid_response' || reason === 'http_error' ? 'error' : 'unavailable';
    sendJson(res, {
      status: status,
      available: false,
      reason: reason,
      agents: [],
      usage: null
    });
  });
}

function handleAgentMonitorUpgrade(req, socket, head) {
  var parsed;
  try {
    parsed = url.parse(req.url, true);
  } catch (error) {
    sendWebSocketUpgradeError(socket, 400, 'Bad Request');
    return;
  }
  if (parsed.pathname !== '/api/agent-monitor/ws') {
    sendWebSocketUpgradeError(socket, 404, 'Not Found');
    return;
  }
  if (isExternalAccessBlocked(req)) {
    sendWebSocketUpgradeError(socket, 403, 'Forbidden');
    return;
  }
  if (requiresAuth(req, parsed) && !isAuthorizedRequest(req)) {
    sendWebSocketUpgradeError(socket, 401, 'Unauthorized');
    return;
  }

  var monitor = resolveAgentMonitorConfig();
  if (!monitor.enabled || monitor.healthy === false) {
    sendWebSocketUpgradeError(socket, 503, 'Service Unavailable');
    return;
  }

  var connected = false;
  var upstream = net.connect(monitor.port, monitor.hostname);
  upstream.setTimeout(AGENT_MONITOR_TIMEOUT_MS, function () {
    upstream.destroy();
    if (!connected) sendWebSocketUpgradeError(socket, 504, 'Gateway Timeout');
  });
  upstream.on('connect', function () {
    connected = true;
    upstream.setTimeout(0);
    upstream.write(agentMonitorWebSocketRequest(req, monitor));
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('error', function () {
    if (!connected) sendWebSocketUpgradeError(socket, 502, 'Bad Gateway');
    else socket.destroy();
  });
  socket.on('error', function () {
    upstream.destroy();
  });
  socket.on('close', function () {
    upstream.destroy();
  });
}

function agentMonitorWebSocketRequest(req, monitor) {
  var lines = [
    'GET ' + monitor.websocketPath + ' HTTP/1.1',
    'Host: ' + formatUrlHost(monitor.hostname) + ':' + monitor.port,
    'Upgrade: websocket',
    'Connection: Upgrade'
  ];
  [
    'sec-websocket-key',
    'sec-websocket-version',
    'sec-websocket-protocol',
    'sec-websocket-extensions',
    'origin',
    'user-agent'
  ].forEach(function (name) {
    if (req.headers[name]) lines.push(name + ': ' + req.headers[name]);
  });
  return lines.join('\r\n') + '\r\n\r\n';
}

function sendWebSocketUpgradeError(socket, statusCode, statusText) {
  if (!socket || socket.destroyed || socket.writableEnded) return;
  socket.end(
    'HTTP/1.1 ' + statusCode + ' ' + statusText + '\r\n' +
    'Connection: close\r\n' +
    'Content-Length: 0\r\n\r\n'
  );
}

function resolveAgentMonitorConfig() {
  var runtime = agentMonitorRuntime || {};
  var runtimeStatus = String(runtime.status || '').toLowerCase();
  var runtimeReason = String(runtime.reason || '').toLowerCase();
  if (runtimeReason !== 'timeout' && runtimeReason !== 'disabled' &&
      runtimeReason !== 'unavailable' && runtimeReason !== 'invalid_configuration' &&
      runtimeReason !== 'python_not_found' && runtimeReason !== 'dependency_missing' &&
      runtimeReason !== 'service_missing' && runtimeReason !== 'port_conflict' &&
      runtimeReason !== 'process_exited' && runtimeReason !== 'stopped') {
    runtimeReason = '';
  }
  var disabled = process.env.GMC_AGENT_MONITOR_DISABLED === '1' ||
    process.env.GMC_AGENT_MONITOR_DISABLED === 'true' ||
    runtime.enabled === false ||
    runtimeStatus === 'disabled';
  var configuredUrl = runtime.url || runtime.address || runtime.baseUrl || runtime.monitorUrl ||
    process.env.GMC_AGENT_MONITOR_URL || '';
  var port;
  var parsed;

  if (disabled) {
    return { enabled: false };
  }
  try {
    port = normalizePort(runtime.port || process.env.GMC_AGENT_MONITOR_PORT || AGENT_MONITOR_DEFAULT_PORT);
    parsed = configuredUrl ? new URL(configuredUrl) : new URL('http://127.0.0.1:' + port);
  } catch (error) {
    return { enabled: true, healthy: false, reason: 'invalid_configuration' };
  }
  if (parsed.protocol !== 'http:') {
    return { enabled: true, healthy: false, reason: 'invalid_configuration' };
  }
  if (parsed.hostname === '0.0.0.0' || parsed.hostname === '::') {
    parsed.hostname = '127.0.0.1';
  }
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost' && parsed.hostname !== '::1') {
    return { enabled: true, healthy: false, reason: 'invalid_configuration' };
  }
  var basePath = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.replace(/\/$/, '') : '';
  basePath = basePath.replace(/\/(?:health|agents|status|ws\/status)$/, '');
  return {
    enabled: true,
    healthy: runtime.healthy === false || runtime.available === false ||
      runtimeStatus === 'unavailable' || runtimeStatus === 'unhealthy' ||
      runtimeStatus === 'error' || runtimeStatus === 'failed' ? false : true,
    reason: runtimeReason,
    hostname: parsed.hostname,
    port: normalizePort(parsed.port || port),
    path: basePath + '/status',
    websocketPath: basePath + '/ws/status'
  };
}

function requestAgentMonitorAgents(monitor) {
  return new Promise(function (resolve, reject) {
    var settled = false;
    var req = http.request({
      hostname: monitor.hostname,
      port: monitor.port,
      path: monitor.path,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Connection': 'close'
      }
    }, function (response) {
      var chunks = [];
      var size = 0;
      response.on('data', function (chunk) {
        if (settled) return;
        size += chunk.length;
        if (size > AGENT_MONITOR_MAX_RESPONSE_BYTES) {
          settled = true;
          req.destroy();
          reject(agentMonitorError('invalid_response'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', function () {
        if (settled) return;
        settled = true;
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(agentMonitorError('http_error'));
          return;
        }
        var parsed;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (error) {
          reject(agentMonitorError('invalid_response'));
          return;
        }
        try {
          resolve(normalizeAgentMonitorResponse(parsed));
        } catch (error) {
          reject(agentMonitorError('invalid_response'));
        }
      });
    });
    req.on('error', function () {
      if (settled) return;
      settled = true;
      reject(agentMonitorError('unavailable'));
    });
    req.setTimeout(AGENT_MONITOR_TIMEOUT_MS, function () {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(agentMonitorError('timeout'));
    });
    req.end();
  });
}

function normalizeAgentMonitorResponse(parsed) {
  var agentsRaw = parsed;
  var usageRaw = null;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    agentsRaw = parsed.agents || [];
    usageRaw = parsed.usage || null;
  }
  return {
    agents: normalizeAgentMonitorAgents(agentsRaw),
    usage: usageRaw
  };
}

function normalizeAgentMonitorAgents(value) {
  if (!Array.isArray(value)) {
    throw new Error('Agent Monitor response must be an array');
  }
  return value.slice(0, 50).map(function (item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Invalid Agent Monitor entry');
    }
    var agentId = String(item.agent_id || item.id || '').trim().toLowerCase();
    if (!agentId || agentId.length > 80) {
      throw new Error('Invalid Agent Monitor id');
    }
    var processCount = safeAgentMonitorNumber(item.process_count, true);
    var status = String(item.status || '').trim().toLowerCase();
    if (status !== 'working' && status !== 'idle' &&
        status !== 'paused' && status !== 'stopped') {
      status = 'unknown';
    }
    if (processCount === 0) status = 'stopped';
    return {
      agentId: agentId,
      displayName: String(item.display_name || item.displayName || agentId).slice(0, 120),
      status: status,
      processCount: processCount,
      cpuPercent: safeAgentMonitorNumber(item.total_cpu_percent, false),
      memoryMb: safeAgentMonitorNumber(item.total_memory_mb, false),
      uptimeSeconds: safeAgentMonitorNumber(item.max_uptime_seconds, false)
    };
  });
}

function safeAgentMonitorNumber(value, integer) {
  value = Number(value);
  if (!Number.isFinite(value) || value < 0) return 0;
  return integer ? Math.floor(value) : Math.round(value * 10) / 10;
}

function agentMonitorUnavailable(reason) {
  return {
    status: 'unavailable',
    available: false,
    reason: reason || 'unavailable',
    agents: [],
    usage: null
  };
}

function agentMonitorError(reason) {
  var error = new Error('Agent Monitor request failed');
  error.agentMonitorReason = reason;
  return error;
}

function logRequestTiming(pathname, t0, error) {
  if (!process.env.GMC_DEBUG_TIMING) return;
  var elapsed = Date.now() - t0;
  if (elapsed >= 100 || error) {
    console.error('[gmc:req] %s %s %dms%s', pathname || '?', error ? 'ERROR' : 'OK', elapsed, error ? ' (' + error.message + ')' : '');
  }
}

function handleCommitSelected(req, res, targetRepo) {
  if (!targetRepo) {
    sendJsonError(res, 400, 'Missing repo parameter');
    return;
  }

  readJsonBody(req).then(function (body) {
    var result = commitSelectedFiles(targetRepo, body.files, body.language, body.source);
    invalidateStatusCache(targetRepo);
    sendJson(res, result);
  }).catch(function (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  });
}

function handleStageSelected(req, res, targetRepo) {
  if (!targetRepo) return sendJsonError(res, 400, 'Missing repo parameter');
  readJsonBody(req).then(function (body) {
    var result = stageSelectedFiles(targetRepo, body.files);
    invalidateStatusCache(targetRepo);
    sendJson(res, result);
  }).catch(function (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  });
}

function handleUnstageSelected(req, res, targetRepo) {
  if (!targetRepo) return sendJsonError(res, 400, 'Missing repo parameter');
  readJsonBody(req).then(function (body) {
    var result = unstageSelectedFiles(targetRepo, body.files);
    invalidateStatusCache(targetRepo);
    sendJson(res, result);
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
    var result = ignoreSelectedFiles(targetRepo, body.files);
    invalidateStatusCache(targetRepo);
    sendJson(res, result);
  }).catch(function (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  });
}

function handleRestoreSelected(req, res, targetRepo) {
  if (!targetRepo) return sendJsonError(res, 400, 'Missing repo parameter');
  readJsonBody(req).then(function (body) {
    var result = restoreSelectedFiles(targetRepo, body.files);
    invalidateStatusCache(targetRepo);
    sendJson(res, result);
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
  invalidateStatusCache(targetRepo);
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
  invalidateStatusCache(targetRepo);
  sendJson(res, { status: 'ok', output: ((result.stdout || '') + (result.stderr || '')).trim() });
}

function handleCheckoutBranch(req, res, targetRepo) {
  if (!targetRepo) return sendJsonError(res, 400, 'Missing repo parameter');
  readJsonBody(req).then(function (body) {
    var result = checkoutBranch(targetRepo, body.branch);
    invalidateStatusCache(targetRepo);
    sendJson(res, result);
  }).catch(function (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  });
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

function handleMergeResolveFile(req, res, targetRepo) {
  if (!targetRepo) return sendJsonError(res, 400, 'Missing repo parameter');
  readJsonBody(req).then(function (body) {
    var filePath = body && body.path;
    if (!filePath) {
      var err = new Error('Missing file path');
      err.httpStatus = 400;
      throw err;
    }
    var mergeConflict = require('./merge-conflict');
    var detail = mergeConflict.getConflictDetail(targetRepo, filePath);
    if (!detail) {
      var err2 = new Error('File is not in a merge conflict');
      err2.httpStatus = 400;
      throw err2;
    }
    return detail;
  }).then(function (detail) {
    sendJson(res, {
      ours: detail.ours,
      theirs: detail.theirs,
      base: detail.base,
      conflicted: detail.conflicted,
      branch: detail.branch,
      mergeBranch: detail.mergeBranch
    });
  }).catch(function (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  });
}

function handleMergeAcceptFile(req, res, targetRepo) {
  if (!targetRepo) return sendJsonError(res, 400, 'Missing repo parameter');
  readJsonBody(req).then(function (body) {
    var filePath = body && body.path;
    if (!filePath) {
      var err = new Error('Missing file path');
      err.httpStatus = 400;
      throw err;
    }
    var mergeConflict = require('./merge-conflict');
    var repoRoot = git.repoRoot(targetRepo);
    if (body.content) {
      mergeConflict.resolveFileWithContent(targetRepo, filePath, body.content);
    } else {
      mergeConflict.resolveFile(targetRepo, filePath);
    }
    var fullPath = path.resolve(repoRoot, filePath);
    var valid = mergeConflict.validateResolution(fullPath);
    if (!valid.valid) {
      var err2 = new Error(valid.error);
      err2.httpStatus = 400;
      throw err2;
    }
    return { status: 'ok', path: filePath };
  }).then(function (result) {
    sendJson(res, result);
  }).catch(function (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  });
}

function handleMergeConflictDetail(req, res, targetRepo) {
  if (!targetRepo) return sendJsonError(res, 400, 'Missing repo parameter');
  try {
    var parsed = url.parse(req.url, true);
    var filePath = parsed.query && parsed.query.path;
    if (!filePath) return sendJsonError(res, 400, 'Missing file path');
    var mergeConflict = require('./merge-conflict');
    var detail = mergeConflict.getConflictDetail(targetRepo, filePath);
    if (!detail) return sendJsonError(res, 400, 'Not a merge conflict');
    sendJson(res, detail);
  } catch (error) {
    sendJsonError(res, 500, error.message);
  }
}

function handleAddRepository(req, res) {
  if (!isLoopbackRequest(req)) {
    return sendJsonError(res, 403, 'Adding repositories is only available from 127.0.0.1.');
  }
  try {
    sendJson(res, addRepository());
  } catch (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  }
}

function addRepository() {
  if (process.platform !== 'darwin') {
    throwHttpError('Adding repositories via system dialog is only supported on macOS.');
  }

  var script = 'POSIX path of (choose folder with prompt "选择要导入或创建 Git 仓库的文件夹")';
  var result = childProcess.spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return { status: 'cancelled' };
  }

  var posixPath = (result.stdout || '').trim();
  // Remove trailing newline/carriage return
  posixPath = posixPath.replace(/[\r\n]+$/, '');

  if (!posixPath || !fs.existsSync(posixPath)) {
    throwHttpError('Selected path does not exist: ' + posixPath);
  }
  if (!fs.statSync(posixPath).isDirectory()) {
    throwHttpError('Selected path is not a directory.');
  }

  var repoRoot = null;
  try {
    repoRoot = git.repoRoot(posixPath);
  } catch (error) {
    // The selected directory is not inside a Git working tree yet.
  }

  if (!repoRoot) {
    if (!confirmRepositoryInitialization(posixPath)) {
      return { status: 'cancelled' };
    }

    var initResult = childProcess.spawnSync('git', ['init'], {
      cwd: posixPath,
      encoding: 'utf8'
    });
    if (initResult.error || initResult.status !== 0) {
      var initMsg = (initResult.stderr || initResult.stdout || initResult.error && initResult.error.message || 'git init failed').trim();
      throwHttpError(initMsg || 'Failed to initialize git repository.');
    }
    repoRoot = git.repoRoot(posixPath);
  }

  installHooksAndWeb(repoRoot);
  recordRepositoryVisit(repoRoot);

  return {
    status: 'ok',
    path: repoRoot,
    name: repoName(repoRoot)
  };
}

function confirmRepositoryInitialization(repoPath) {
  var script = [
    'on run argv',
    'set selectedPath to item 1 of argv',
    'display dialog "所选文件夹不是 Git 仓库：" & return & selectedPath & return & return & "是否在此创建 Git 仓库？" with title "创建 Git 仓库" buttons {"取消", "创建"} default button "创建" cancel button "取消" with icon caution',
    'return button returned of result',
    'end run'
  ];
  var args = [];
  script.forEach(function (line) {
    args.push('-e', line);
  });
  args.push('--', repoPath);

  var result = childProcess.spawnSync('osascript', args, { encoding: 'utf8' });
  return !result.error && result.status === 0;
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

function handleOpenTerminal(req, res, targetRepo) {
  if (!targetRepo) return sendJsonError(res, 400, 'Missing repo parameter');
  if (!isLoopbackRequest(req)) {
    return sendJsonError(res, 403, 'Opening Terminal is only available from 127.0.0.1.');
  }
  try {
    sendJson(res, openTerminalAtRepository(targetRepo));
  } catch (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  }
}

function detectProjectType(root) {
  try {
    var repoRoot = git.repoRoot(root);
    if (!fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) {
      return { type: 'unknown', ide: 'code', ideLabel: 'VS Code', ideIcon: 'code' };
    }

    // iOS / Xcode
    var xcodeMatch = fs.readdirSync(repoRoot).some(function(name) {
      return /\.xcodeproj$/i.test(name) || /\.xcworkspace$/i.test(name);
    });
    if (xcodeMatch) {
      return { type: 'ios', ide: 'xcode', ideLabel: 'Xcode', ideIcon: 'xcode' };
    }

    // Android
    var hasRootGradle = fs.existsSync(path.join(repoRoot, 'build.gradle')) ||
      fs.existsSync(path.join(repoRoot, 'build.gradle.kts'));
    var hasAppGradle = fs.existsSync(path.join(repoRoot, 'app', 'build.gradle')) ||
      fs.existsSync(path.join(repoRoot, 'app', 'build.gradle.kts'));
    if (hasRootGradle || hasAppGradle) {
      return { type: 'android', ide: 'android-studio', ideLabel: 'Android Studio', ideIcon: 'android' };
    }

    // Default: VS Code
    return { type: 'other', ide: 'code', ideLabel: 'VS Code', ideIcon: 'code' };
  } catch (e) {
    return { type: 'unknown', ide: 'code', ideLabel: 'VS Code', ideIcon: 'code' };
  }
}

function handleOpenIde(req, res, targetRepo) {
  if (!targetRepo) return sendJsonError(res, 400, 'Missing repo parameter');
  if (!isLoopbackRequest(req)) {
    return sendJsonError(res, 403, 'Opening IDE is only available from 127.0.0.1.');
  }
  try {
    var repoRoot = git.repoRoot(targetRepo);
    if (!fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) {
      throwHttpError('Repository path does not exist: ' + repoRoot);
    }

    var project = detectProjectType(targetRepo);
    var result;
    var env = Object.assign({}, process.env);

    switch (project.ide) {
      case 'xcode': {
        var xcodeFiles = fs.readdirSync(repoRoot).filter(function(name) {
          return /\.xcworkspace$/i.test(name) || /\.xcodeproj$/i.test(name);
        });
        var ws = xcodeFiles.filter(function(name) { return /\.xcworkspace$/i.test(name); });
        var pbx = xcodeFiles.filter(function(name) { return /\.xcodeproj$/i.test(name); });
        var xcodeTarget = (ws.length ? ws : pbx)[0];
        if (xcodeTarget) {
          result = childProcess.spawnSync('open', [path.join(repoRoot, xcodeTarget)], { env: env, encoding: 'utf8' });
        } else {
          throwHttpError('No Xcode project file found');
        }
        break;
      }
      case 'android-studio':
        // Try open with bundle ID (most reliable)
        result = childProcess.spawnSync('open', ['-b', 'com.google.android.studio', repoRoot], { env: env, encoding: 'utf8' });
        if (result.error || result.status !== 0) {
          // Try by app name
          result = childProcess.spawnSync('open', ['-a', 'Android Studio', repoRoot], { env: env, encoding: 'utf8' });
        }
        if (result.error || result.status !== 0) {
          // Try studio CLI
          result = childProcess.spawnSync('studio', ['.'], { cwd: repoRoot, env: env, encoding: 'utf8' });
        }
        break;
      case 'code':
      default:
        // Try code CLI first
        result = childProcess.spawnSync('code', ['.'], { cwd: repoRoot, env: env, encoding: 'utf8' });
        if (result.error || result.status !== 0) {
          // Try open with bundle ID for VS Code
          result = childProcess.spawnSync('open', ['-b', 'com.microsoft.VSCode', repoRoot], { env: env, encoding: 'utf8' });
        }
        if (result.error || result.status !== 0) {
          // Try open with app name
          result = childProcess.spawnSync('open', ['-a', 'Visual Studio Code', repoRoot], { env: env, encoding: 'utf8' });
        }
        if (result.error || result.status !== 0) {
          // Fallback: open the folder in Finder
          result = childProcess.spawnSync('open', [repoRoot], { env: env, encoding: 'utf8' });
        }
        break;
    }

    if (result.error || result.status !== 0) {
      var stderr = (result.stderr || '').trim();
      var stdout = (result.stdout || '').trim();
      console.error('handleOpenIde failed: ide=%s status=%s error=%s stderr=%s stdout=%s',
        project.ide, result.status, result.error ? result.error.message : '', stderr, stdout);
      var errorMsg = stderr || stdout || (result.error && result.error.message) || ('Exit code ' + result.status);
      throwHttpError(errorMsg || 'Failed to open project in ' + project.ideLabel);
    }

    sendJson(res, { status: 'ok', ide: project.ide, ideLabel: project.ideLabel });
  } catch (error) {
    console.error('handleOpenIde exception:', error.message);
    sendJsonError(res, error.httpStatus || 500, error.message);
  }
}

function handleOpenApp(req, res) {
  if (!isLoopbackRequest(req)) {
    return sendJsonError(res, 403, 'Opening applications is only available from 127.0.0.1.');
  }
  readJsonBody(req).then(function (body) {
    body = body || {};
    var app = String(body.app || '').toLowerCase();
    var result;
    var env = Object.assign({}, process.env);

    if (process.platform === 'darwin') {
      switch (app) {
        case 'xcode':
          result = childProcess.spawnSync('open', ['-b', 'com.apple.dt.Xcode'], { env: env, encoding: 'utf8' });
          if (result.error || result.status !== 0) {
            result = childProcess.spawnSync('open', ['-a', 'Xcode'], { env: env, encoding: 'utf8' });
          }
          break;
        case 'android-studio':
        case 'studio':
          result = childProcess.spawnSync('open', ['-b', 'com.google.android.studio'], { env: env, encoding: 'utf8' });
          if (result.error || result.status !== 0) {
            result = childProcess.spawnSync('open', ['-a', 'Android Studio'], { env: env, encoding: 'utf8' });
          }
          if (result.error || result.status !== 0) {
            result = childProcess.spawnSync('studio', [], { env: env, encoding: 'utf8' });
          }
          break;
        case 'vscode':
        case 'code':
          result = childProcess.spawnSync('open', ['-b', 'com.microsoft.VSCode'], { env: env, encoding: 'utf8' });
          if (result.error || result.status !== 0) {
            result = childProcess.spawnSync('open', ['-a', 'Visual Studio Code'], { env: env, encoding: 'utf8' });
          }
          if (result.error || result.status !== 0) {
            result = childProcess.spawnSync('code', [], { env: env, encoding: 'utf8' });
          }
          break;
        case 'sublime':
        case 'subl':
          result = childProcess.spawnSync('open', ['-b', 'com.sublimetext.4'], { env: env, encoding: 'utf8' });
          if (result.error || result.status !== 0) {
            result = childProcess.spawnSync('open', ['-b', 'com.sublimetext.3'], { env: env, encoding: 'utf8' });
          }
          if (result.error || result.status !== 0) {
            result = childProcess.spawnSync('open', ['-a', 'Sublime Text'], { env: env, encoding: 'utf8' });
          }
          if (result.error || result.status !== 0) {
            result = childProcess.spawnSync('subl', [], { env: env, encoding: 'utf8' });
          }
          break;
        case 'cursor':
          result = childProcess.spawnSync('open', ['-b', 'com.todesktop.230313mzl4w4u92'], { env: env, encoding: 'utf8' });
          if (result.error || result.status !== 0) {
            result = childProcess.spawnSync('open', ['-a', 'Cursor'], { env: env, encoding: 'utf8' });
          }
          if (result.error || result.status !== 0) {
            result = childProcess.spawnSync('cursor', [], { env: env, encoding: 'utf8' });
          }
          break;
        case 'terminal':
          result = childProcess.spawnSync('open', ['-a', 'Terminal'], { env: env, encoding: 'utf8' });
          break;
        default:
          throwHttpError('Unknown application: ' + app);
      }
    } else {
      switch (app) {
        case 'code':
        case 'vscode':
          result = childProcess.spawnSync('code', [], { env: env, encoding: 'utf8' });
          break;
        case 'sublime':
        case 'subl':
          result = childProcess.spawnSync('subl', [], { env: env, encoding: 'utf8' });
          break;
        case 'cursor':
          result = childProcess.spawnSync('cursor', [], { env: env, encoding: 'utf8' });
          break;
        case 'terminal':
          result = childProcess.spawnSync('x-terminal-emulator', [], { env: env, encoding: 'utf8' });
          break;
        default:
          throwHttpError('App launching is not supported for ' + app);
      }
    }

    if (result && (result.error || result.status !== 0)) {
      var err = (result.stderr || '').trim() || (result.error && result.error.message) || ('Exit code ' + result.status);
      throwHttpError(err || 'Failed to launch ' + app);
    }
    sendJson(res, { status: 'ok', app: app });
  }).catch(function (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  });
}

function getGlobalGitConfig() {
  var raw = runGitOptional(process.cwd(), ['config', '--global', '--list']);
  var list = [];
  var map = {};
  if (raw) {
    var lines = raw.split(/\r?\n/);
    lines.forEach(function (line) {
      if (!line) return;
      var eq = line.indexOf('=');
      if (eq >= 0) {
        var key = line.slice(0, eq).trim();
        var val = line.slice(eq + 1).trim();
        if (key) {
          list.push({ key: key, value: val });
          map[key] = val;
        }
      }
    });
  }
  return { list: list, map: map };
}

function collectGitOverview(force) {
  var version = runGitOptional(process.cwd(), ['--version']) || 'git version unknown';
  var execPath = runGitOptional(process.cwd(), ['--exec-path']) || '';
  var gitBin = '';
  try {
    if (process.platform === 'darwin' || process.platform === 'linux') {
      var whichRes = childProcess.spawnSync('which', ['git'], { encoding: 'utf8' });
      if (whichRes.status === 0 && whichRes.stdout) {
        gitBin = whichRes.stdout.trim();
      }
    }
  } catch (e) {}

  var globalCfg = getGlobalGitConfig();
  var rawRepos = readRecentRepositories(force);
  var repos = attachRepoStatus(rawRepos, force);
  var globalContribs = globalContributions(null, null);

  return {
    version: version,
    execPath: execPath,
    gitBin: gitBin || execPath || 'git',
    userName: git.getGlobalConfig('user.name') || '',
    userEmail: git.getGlobalConfig('user.email') || '',
    coreEditor: git.getGlobalConfig('core.editor') || '',
    defaultBranch: git.getGlobalConfig('init.defaultBranch') || '',
    pullRebase: git.getGlobalConfig('pull.rebase') || '',
    configs: globalCfg.list,
    configMap: globalCfg.map,
    repositories: repos,
    repositoriesCount: repos.length,
    globalContributions: globalContribs,
    cityData: collectAllReposCityData(rawRepos, force)
  };
}

function handleGetGitOverview(req, res, parsed) {
  try {
    var force = Boolean(parsed && parsed.query && parsed.query.force === '1');
    sendJson(res, collectGitOverview(force));
  } catch (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  }
}

function handleUpdateGitConfig(req, res) {
  if (!isLoopbackRequest(req)) {
    return sendJsonError(res, 403, 'Editing Git config is only available from 127.0.0.1.');
  }
  readJsonBody(req).then(function (body) {
    body = body || {};
    if (body.entries && typeof body.entries === 'object') {
      Object.keys(body.entries).forEach(function (key) {
        var val = body.entries[key];
        if (val === null || val === '') {
          git.runGit(['config', '--global', '--unset', key], { allowFailure: true });
        } else {
          git.setGlobalConfig(key, String(val).trim());
        }
      });
    } else if (body.key) {
      if (body.value === null || body.value === '') {
        git.runGit(['config', '--global', '--unset', body.key], { allowFailure: true });
      } else {
        git.setGlobalConfig(body.key, String(body.value).trim());
      }
    }
    sendJson(res, { status: 'ok', overview: collectGitOverview() });
  }).catch(function (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  });
}

function handleOpenAgent(req, res, targetRepo, agent) {
  if (!targetRepo) return sendJsonError(res, 400, 'Missing repo parameter');
  if (!agent) return sendJsonError(res, 400, 'Missing agent parameter');
  if (!isLoopbackRequest(req)) {
    return sendJsonError(res, 403, 'Opening Agent is only available from 127.0.0.1.');
  }
  try {
    sendJson(res, openAgentAtRepository(targetRepo, agent));
  } catch (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  }
}

function handleCreateTask(req, res, targetRepo) {
  if (!targetRepo) return sendJsonError(res, 400, 'Missing repo parameter');
  readJsonBody(req).then(function (body) {
    sendJson(res, createRepositoryTask(targetRepo, body));
  }).catch(function (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  });
}

function handleDecomposeTask(req, res, targetRepo) {
  if (!targetRepo) return sendJsonError(res, 400, 'Missing repo parameter');
  res.gmcLongLived = true;
  req.setTimeout(0);
  res.setTimeout(0);
  readJsonBody(req).then(function (body) {
    return decomposeRepositoryTasks(targetRepo, body);
  }).then(function (result) {
    sendJson(res, result);
  }).catch(function (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  });
}

function handleUpdateTask(req, res, targetRepo) {
  if (!targetRepo) return sendJsonError(res, 400, 'Missing repo parameter');
  readJsonBody(req).then(function (body) {
    sendJson(res, updateRepositoryTask(targetRepo, body, {
      allowAgentLaunch: isLoopbackRequest(req)
    }));
  }).catch(function (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  });
}

function handleDeleteTask(req, res, targetRepo) {
  if (!targetRepo) return sendJsonError(res, 400, 'Missing repo parameter');
  readJsonBody(req).then(function (body) {
    sendJson(res, deleteRepositoryTask(targetRepo, body));
  }).catch(function (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  });
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

function handleSetAgent(req, res, targetRepo) {
  readJsonBody(req).then(function (body) {
    var newAgent = String(body.agent || '').trim().toLowerCase();
    var scope = String(body.scope || '').trim().toLowerCase();
    if (!newAgent) {
      return sendJsonError(res, 400, 'Missing agent parameter.');
    }
    try {
      var selectedAgent;
      if (scope === 'commit') {
        selectedAgent = config.setCommitAgent(newAgent);
      } else if (scope === 'task') {
        selectedAgent = config.setTaskAgent(newAgent);
      } else if (scope === 'repository-task') {
        if (!targetRepo) {
          return sendJsonError(res, 400, 'Missing repo parameter.');
        }
        selectedAgent = config.setRepositoryTaskAgent(newAgent, targetRepo);
      } else if (!scope) {
        selectedAgent = config.setAgent(newAgent);
      } else {
        return sendJsonError(res, 400, 'Unsupported agent setting scope: ' + scope);
      }
      sendJson(res, { agent: selectedAgent, scope: scope || 'default' });
    } catch (error) {
      sendJsonError(res, 400, error.message);
    }
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
  var currentScriptPath = path.resolve(__dirname, '../bin/gmc.js');
  var realCurrentScriptPath = '';
  try {
    realCurrentScriptPath = fs.realpathSync(currentScriptPath);
  } catch (e) { /* ignore */ }

  function verifyHookFile(filePath) {
    if (!fs.existsSync(filePath)) {
      return false;
    }
    var content = fs.readFileSync(filePath, 'utf8');
    if (content.indexOf('# GMHOOK') < 0) {
      return false;
    }
    var match = content.match(/exec\s+['"]?[^'"]+['"]?\s+['"]([^'"]+)['"]\s+hook/);
    if (!match) {
      return false;
    }
    try {
      var realScriptPath = fs.realpathSync(match[1]);
      return realScriptPath === realCurrentScriptPath;
    } catch (e) {
      return false;
    }
  }

  try {
    var cmPath = path.join(gitDirPath, 'hooks', 'commit-msg');
    hooks.commitMsg = verifyHookFile(cmPath);
  } catch (e) { /* ignore */ }
  try {
    var pcPath = path.join(gitDirPath, 'hooks', 'post-commit');
    hooks.postCommit = verifyHookFile(pcPath);
  } catch (e) { /* ignore */ }
  return {
    hooks: hooks.commitMsg && hooks.postCommit
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

function appleScriptString(value) {
  return JSON.stringify(String(value));
}

function hasMacApplication(appName) {
  var result = childProcess.spawnSync('osascript', ['-e', 'id of application ' + appleScriptString(appName)], { encoding: 'utf8' });
  return !result.error && result.status === 0;
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

function openTerminalAtRepository(root) {
  var repoRoot = git.repoRoot(root);
  if (process.platform !== 'darwin') {
    throwHttpError('Opening Terminal is only supported on macOS.');
  }
  if (!fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) {
    throwHttpError('Repository path does not exist: ' + repoRoot);
  }

  var command = 'cd ' + shellQuote(repoRoot);
  if (hasMacApplication('iTerm')) {
    try {
      return openITermAtPath(repoRoot, command);
    } catch (error) {
      return openTerminalAppAtPath(repoRoot, command);
    }
  }
  return openTerminalAppAtPath(repoRoot, command);
}

function runTerminalAppleScript(script, fallbackMessage) {
  var result = childProcess.spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    var message = (result.stderr || result.stdout || result.error && result.error.message || 'osascript failed').trim();
    throwHttpError(message || fallbackMessage);
  }
}

function openITermAtPath(repoRoot, command) {
  var script = [
    'tell application "iTerm"',
    '  activate',
    '  create window with default profile',
    '  tell current session of current window',
    '    write text ' + appleScriptString(command),
    '  end tell',
    'end tell'
  ].join(String.fromCharCode(10));
  runTerminalAppleScript(script, 'Failed to open iTerm.');
  return {
    status: 'ok',
    terminal: 'iTerm',
    path: repoRoot
  };
}

function openTerminalAppAtPath(repoRoot, command) {
  var script = [
    'tell application "Terminal"',
    '  do script ' + appleScriptString(command),
    '  activate',
    'end tell'
  ].join(String.fromCharCode(10));
  runTerminalAppleScript(script, 'Failed to open Terminal.');
  return {
    status: 'ok',
    terminal: 'Terminal',
    path: repoRoot
  };
}

function openAgentAtRepository(root, selectedAgent, prompt) {
  console.log('openAgentAtRepository called: root=%s agent=%s', root, selectedAgent);
  var repoRoot = git.repoRoot(root);
  console.log('repoRoot resolved: %s', repoRoot);
  if (process.platform !== 'darwin') {
    throwHttpError('Opening Agent is only supported on macOS.');
  }
  if (!fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) {
    throwHttpError('Repository path does not exist: ' + repoRoot);
  }

  var invocation;
  try {
    invocation = agent.interactiveInvocation(selectedAgent, repoRoot, prompt);
  } catch (error) {
    throwHttpError(error.message);
  }
  var command = 'cd ' + shellQuote(repoRoot) + ' && ' + shellQuote(invocation.command);
  invocation.args.forEach(function (arg) {
    command += ' ' + shellQuote(arg);
  });

  if (hasMacApplication('iTerm')) {
    return openITermAtPath(repoRoot, command);
  }
  return openTerminalAppAtPath(repoRoot, command);
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

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-GMC-Auth');
}

function sendJson(res, payload, headers) {
  setCorsHeaders(res);
  res.setHeader('Connection', 'close');
  res.writeHead(200, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, headers || {}));
  res.end(JSON.stringify(payload));
}

function sendJsonError(res, status, message) {
  setCorsHeaders(res);
  res.setHeader('Connection', 'close');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify({
    error: message
  }));
}

function send(res, status, type, body) {
  setCorsHeaders(res);
  res.setHeader('Connection', 'close');
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

var repoContributionsCache = null;
var lastCommitTimeCache = {};
var recentReposCache = { at: 0, list: [] };

function loadContributionsCache() {
  if (repoContributionsCache !== null && typeof repoContributionsCache === 'object') {
    return repoContributionsCache;
  }
  try {
    if (fs.existsSync(CONTRIBUTIONS_CACHE_FILE)) {
      var raw = JSON.parse(fs.readFileSync(CONTRIBUTIONS_CACHE_FILE, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        repoContributionsCache = raw;
        return repoContributionsCache;
      }
    }
  } catch (e) {}
  repoContributionsCache = {};
  return repoContributionsCache;
}

function saveContributionsCache() {
  try {
    if (!repoContributionsCache) return;
    fs.mkdirSync(path.dirname(CONTRIBUTIONS_CACHE_FILE), { recursive: true });
    fs.writeFileSync(CONTRIBUTIONS_CACHE_FILE, JSON.stringify(repoContributionsCache, null, 2) + '\n');
  } catch (e) {}
}

function getRepoLastCommitTime(repoPath) {
  try {
    if (!repoPath) return 0;
    var cached = lastCommitTimeCache[repoPath];
    var gitDir = path.join(repoPath, '.git');
    var headFile = path.join(gitDir, 'HEAD');
    var headMtime = 0;
    try {
      headMtime = fs.statSync(headFile).mtimeMs;
    } catch (e) {}

    if (cached && (headMtime === 0 || cached.headMtime === headMtime) && Date.now() - cached.checkedAt < 30000) {
      return cached.time;
    }

    var raw = runGitOptional(repoPath, ['log', '-1', '--format=%at']);
    if (!raw) {
      raw = runGitOptional(repoPath, ['log', '-1', '--format=%ct']);
    }
    var sec = Number(raw);
    var commitTime = (!isNaN(sec) && sec > 0) ? sec * 1000 : 0;
    lastCommitTimeCache[repoPath] = {
      headMtime: headMtime,
      time: commitTime,
      checkedAt: Date.now()
    };
    return commitTime;
  } catch (e) {}
  return 0;
}

function readRecentRepositories(force) {
  if (!force && recentReposCache.list.length > 0 && Date.now() - recentReposCache.at < 5000) {
    return recentReposCache.list;
  }

  var raw;
  try {
    if (!fs.existsSync(RECENT_REPOS_FILE)) {
      recentReposCache = { at: Date.now(), list: [] };
      return [];
    }
    raw = JSON.parse(fs.readFileSync(RECENT_REPOS_FILE, 'utf8'));
  } catch (e) {
    recentReposCache = { at: Date.now(), list: [] };
    return [];
  }

  var repositories = Array.isArray(raw) ? raw : raw.repositories;
  if (!Array.isArray(repositories)) {
    recentReposCache = { at: Date.now(), list: [] };
    return [];
  }

  var list = repositories
    .filter(function (item) { return item && item.path; })
    .map(function (item) {
      var repoPath = String(item.path);
      var lastCommitTime = getRepoLastCommitTime(repoPath);
      return {
        name: String(item.name || repoName(repoPath)),
        path: repoPath,
        lastVisited: Number(item.lastVisited) || 0,
        lastCommitTime: lastCommitTime
      };
    })
    .sort(function (a, b) {
      if (b.lastCommitTime !== a.lastCommitTime) {
        return b.lastCommitTime - a.lastCommitTime;
      }
      return b.lastVisited - a.lastVisited;
    })
    .slice(0, RECENT_REPOS_LIMIT);

  recentReposCache = { at: Date.now(), list: list };
  return list;
}

function writeRecentRepositories(repositories) {
  var recent = repositories.slice(0, RECENT_REPOS_LIMIT);
  fs.mkdirSync(path.dirname(RECENT_REPOS_FILE), { recursive: true });
  fs.writeFileSync(RECENT_REPOS_FILE, JSON.stringify({
    repositories: recent
  }, null, 2) + '\n');
  recentReposCache.at = 0;
  return readRecentRepositories(true);
}

function getRepoQuickStatus(repoPath, force) {
  if (!repoPath) return null;
  var resolved = path.resolve(repoPath);
  if (!force && repoQuickStatusCache[resolved] && (Date.now() - repoQuickStatusCache[resolved].at < REPO_STATUS_CACHE_TTL_MS)) {
    return repoQuickStatusCache[resolved].status;
  }

  try {
    if (!fs.existsSync(resolved)) {
      return null;
    }
    var root = git.repoRoot(resolved);
    if (!root) {
      return null;
    }

    var branch = git.currentBranch(root) || 'HEAD';
    var upstream = runGitOptional(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    var aheadBehind = upstream ? parseAheadBehind(runGitOptional(root, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'])) : { ahead: 0, behind: 0 };
    var statusRaw = runGitOptional(root, ['status', '--porcelain=v1', '-b', '-z']);
    var parsedStatus = parseStatusOutput(statusRaw);

    var isClean = parsedStatus.clean && (aheadBehind.ahead === 0) && (aheadBehind.behind === 0);

    var result = {
      branch: branch,
      upstream: upstream || null,
      ahead: aheadBehind.ahead || 0,
      behind: aheadBehind.behind || 0,
      clean: isClean,
      staged: parsedStatus.staged || 0,
      unstaged: parsedStatus.unstaged || 0,
      untracked: parsedStatus.untracked || 0
    };

    repoQuickStatusCache[resolved] = { at: Date.now(), status: result };
    return result;
  } catch (e) {
    return null;
  }
}

function attachRepoStatus(repositories, force) {
  if (!Array.isArray(repositories)) return [];
  return repositories.map(function (item) {
    return {
      name: item.name,
      path: item.path,
      lastVisited: item.lastVisited,
      lastCommitTime: item.lastCommitTime,
      status: getRepoQuickStatus(item.path, force)
    };
  });
}

var repoCityDataCache = {};
var REPO_CITY_DATA_CACHE_TTL_MS = 25000;

var BINARY_EXTENSIONS = {
  png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1, ico: 1, bmp: 1, tiff: 1, tif: 1, avif: 1, heic: 1, psd: 1, ai: 1,
  mp4: 1, webm: 1, mov: 1, avi: 1, mkv: 1, mp3: 1, wav: 1, ogg: 1, flac: 1, aac: 1, m4a: 1,
  zip: 1, tar: 1, gz: 1, tgz: 1, '7z': 1, rar: 1, bz2: 1, xz: 1,
  pdf: 1, doc: 1, docx: 1, xls: 1, xlsx: 1, ppt: 1, pptx: 1,
  exe: 1, dll: 1, so: 1, dylib: 1, class: 1, jar: 1, war: 1, wasm: 1, bin: 1, dat: 1, db: 1, sqlite: 1, sqlite3: 1,
  ttf: 1, otf: 1, woff: 1, woff2: 1, eot: 1,
  blend: 1, fbx: 1, obj: 1, glb: 1, gltf: 1, ply: 1, splat: 1, usdz: 1, xyz: 1,
  onnx: 1, pt: 1, pth: 1, tflite: 1, pb: 1, pkl: 1, h5: 1, weights: 1,
  apk: 1, ipa: 1, car: 1, a: 1, o: 1, lib: 1, dex: 1, xcuserstate: 1, zst: 1, iso: 1, dmg: 1
};

function unquoteGitPath(p) {
  p = (p || '').trim();
  if (p.startsWith('"') && p.endsWith('"')) {
    p = p.slice(1, -1).replace(/\\([0-7]{1,3})/g, function (m, oct) {
      return String.fromCharCode(parseInt(oct, 8));
    }).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return p;
}

function scanRepoFiles(repoRoot, maxFiles) {
  maxFiles = maxFiles || 200;
  var textFiles = [];
  var nonTextCount = 0;
  var maxFile = null;
  var total = 0;

  function walk(dir) {
    if (total >= maxFiles * 3) return;
    var entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.gmc') continue;
      var fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        total++;
        var relPath = path.relative(repoRoot, fullPath);
        var ext = path.extname(entry.name).slice(1).toLowerCase();
        var size = 0;
        try {
          size = fs.statSync(fullPath).size;
        } catch (e) {}
        if (BINARY_EXTENSIONS[ext]) {
          nonTextCount++;
        } else {
          var fileObj = { name: entry.name, path: relPath, size: size, ext: ext };
          textFiles.push(fileObj);
          if (!maxFile || size > maxFile.size) {
            maxFile = fileObj;
          }
        }
      }
    }
  }

  walk(repoRoot);
  return {
    total: total,
    textFiles: textFiles,
    nonTextCount: nonTextCount,
    maxFile: maxFile
  };
}

function getRepoCityData(repoPath, repoName, force) {
  if (!repoPath) return null;
  var resolved = path.resolve(repoPath);
  if (!force && repoCityDataCache[resolved] && (Date.now() - repoCityDataCache[resolved].at < REPO_CITY_DATA_CACHE_TTL_MS)) {
    return repoCityDataCache[resolved].data;
  }

  try {
    if (!fs.existsSync(resolved)) return null;
    var root = git.repoRoot(resolved);
    if (!root) return null;

    var raw = runGitOptional(root, ['ls-tree', '-r', '-l', 'HEAD']);
    var textFiles = [];
    var nonTextCount = 0;
    var maxFile = null;
    var totalFiles = 0;

    if (raw && raw.trim()) {
      var lines = raw.trim().split(/\r?\n/);
      totalFiles = lines.length;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (!line) continue;
        var tabIdx = line.indexOf('\t');
        if (tabIdx < 0) continue;
        var filePath = unquoteGitPath(line.slice(tabIdx + 1));
        var meta = line.slice(0, tabIdx).trim().split(/\s+/);
        var size = parseInt(meta[3], 10) || 0;
        var ext = path.extname(filePath).slice(1).toLowerCase();

        if (BINARY_EXTENSIONS[ext]) {
          nonTextCount++;
        } else {
          var item = { name: path.basename(filePath), path: filePath, size: size, ext: ext };
          textFiles.push(item);
          if (!maxFile || size > maxFile.size) {
            maxFile = item;
          }
        }
      }
    } else {
      var fallback = scanRepoFiles(root, 200);
      totalFiles = fallback.total;
      textFiles = fallback.textFiles;
      nonTextCount = fallback.nonTextCount;
      maxFile = fallback.maxFile;
    }

    textFiles.sort(function (a, b) { return b.size - a.size; });
    var sampled = textFiles.slice(0, 150);

    var data = {
      name: repoName || path.basename(root),
      path: root,
      totalFiles: totalFiles,
      textCount: textFiles.length,
      nonTextCount: nonTextCount,
      tallest: maxFile || (textFiles[0] || { name: 'index', path: 'index', size: 1000 }),
      buildings: sampled,
      status: getRepoQuickStatus(root, force),
      contributions: contributions(root)
    };

    repoCityDataCache[resolved] = { at: Date.now(), data: data };
    return data;
  } catch (err) {
    return null;
  }
}

function collectAllReposCityData(repositories, force) {
  if (!Array.isArray(repositories)) return [];
  var list = [];
  for (var i = 0; i < repositories.length; i++) {
    var item = repositories[i];
    if (!item || !item.path) continue;
    var data = getRepoCityData(item.path, item.name, force);
    if (data) {
      list.push(data);
    }
  }
  return list;
}

function handleGetCityData(req, res, parsed) {
  try {
    var force = Boolean(parsed && parsed.query && parsed.query.force === '1');
    var rawRepos = readRecentRepositories(force);
    sendJson(res, { cityData: collectAllReposCityData(rawRepos, force) });
  } catch (error) {
    sendJsonError(res, error.httpStatus || 500, error.message);
  }
}

function getCachedStatus(repoRoot) {
  var entry = statusCache[repoRoot];
  if (!entry) return null;
  if (Date.now() - entry.at > STATUS_CACHE_TTL_MS) {
    delete statusCache[repoRoot];
    return null;
  }
  return entry.data;
}

function setCachedStatus(repoRoot, data) {
  statusCache[repoRoot] = { at: Date.now(), data: data };
}

function invalidateStatusCache(repoRoot) {
  var cache = loadContributionsCache();
  if (repoRoot) {
    delete statusCache[repoRoot];
    delete lastCommitTimeCache[repoRoot];
    delete repoQuickStatusCache[repoRoot];
    delete repoQuickStatusCache[path.resolve(repoRoot)];
    delete repoCityDataCache[repoRoot];
    delete repoCityDataCache[path.resolve(repoRoot)];
    try {
      var rootKey = git.repoRoot(repoRoot);
      delete statusCache[rootKey];
      delete lastCommitTimeCache[rootKey];
      delete repoQuickStatusCache[rootKey];
      delete repoQuickStatusCache[path.resolve(rootKey)];
      delete repoCityDataCache[rootKey];
      delete repoCityDataCache[path.resolve(rootKey)];
      delete cache[path.resolve(rootKey)];
    } catch (e) {
      delete cache[path.resolve(repoRoot)];
    }
  } else {
    statusCache = {};
    lastCommitTimeCache = {};
    repoContributionsCache = {};
    repoQuickStatusCache = {};
    repoCityDataCache = {};
  }
  recentReposCache.at = 0;
  saveContributionsCache();
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

function handleTaskEvents(req, res, root) {
  var repoRoot = git.repoRoot(root);
  var channel = getTaskEventChannel(repoRoot);
  var closed = false;

  res.gmcLongLived = true;
  setCorsHeaders(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive'
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  if (res.socket && typeof res.socket.setKeepAlive === 'function') {
    res.socket.setKeepAlive(true, TASK_EVENT_HEARTBEAT_MS);
  }

  channel.clients.push(res);
  startTaskEventChannel(channel);
  writeTaskEvent(res, 'ready', { type: 'ready', repo: repoRoot });

  function close() {
    if (closed) return;
    closed = true;
    removeTaskEventClient(channel, res);
  }

  req.on('close', close);
  res.on('close', close);
}

function getTaskEventChannel(repoRoot) {
  var key = path.resolve(repoRoot);
  if (!taskEventChannels[key]) {
    taskEventChannels[key] = {
      key: key,
      repoRoot: key,
      clients: [],
      watcher: null,
      debounceTimer: null,
      retryTimer: null,
      heartbeatTimer: null
    };
  }
  return taskEventChannels[key];
}

function startTaskEventChannel(channel) {
  attachTaskEventWatcher(channel);
  if (!channel.heartbeatTimer) {
    channel.heartbeatTimer = setInterval(function () {
      channel.clients.slice().forEach(function (client) {
        if (!client.destroyed && !client.writableEnded) {
          client.write(': keep-alive\n\n');
        }
      });
    }, TASK_EVENT_HEARTBEAT_MS);
    if (channel.heartbeatTimer.unref) channel.heartbeatTimer.unref();
  }
}

function attachTaskEventWatcher(channel) {
  if (!channel.clients.length || channel.watcher) return;

  var tasksDir = repositoryTasksDir(channel.repoRoot);
  var gmcDir = path.dirname(tasksDir);
  var watchDir = fs.existsSync(tasksDir) ? tasksDir : (fs.existsSync(gmcDir) ? gmcDir : channel.repoRoot);
  var expectedName = watchDir === tasksDir ? '' : (watchDir === gmcDir ? path.basename(tasksDir) : path.basename(gmcDir));

  try {
    channel.watcher = fs.watch(watchDir, { persistent: false }, function (eventType, filename) {
      var changedName = filename == null ? '' : String(filename);
      if (expectedName && changedName && changedName !== expectedName) return;
      scheduleTaskEvent(channel);
      if (expectedName || eventType === 'rename') restartTaskEventWatcher(channel);
    });
    channel.watcher.on('error', function () {
      restartTaskEventWatcher(channel);
    });
  } catch (error) {
    scheduleTaskEventWatcherRetry(channel);
  }
}

function restartTaskEventWatcher(channel) {
  if (channel.watcher) {
    channel.watcher.close();
    channel.watcher = null;
  }
  scheduleTaskEventWatcherRetry(channel);
}

function scheduleTaskEventWatcherRetry(channel) {
  if (channel.retryTimer || !channel.clients.length) return;
  channel.retryTimer = setTimeout(function () {
    channel.retryTimer = null;
    attachTaskEventWatcher(channel);
  }, TASK_EVENT_DEBOUNCE_MS);
  if (channel.retryTimer.unref) channel.retryTimer.unref();
}

function scheduleTaskEvent(channel) {
  clearTimeout(channel.debounceTimer);
  channel.debounceTimer = setTimeout(function () {
    channel.debounceTimer = null;
    broadcastTaskEvent(channel);
  }, TASK_EVENT_DEBOUNCE_MS);
  if (channel.debounceTimer.unref) channel.debounceTimer.unref();
}

function broadcastTaskEvent(channel) {
  channel.clients.slice().forEach(function (client) {
    if (!client.destroyed && !client.writableEnded) {
      writeTaskEvent(client, 'tasks-changed', { type: 'tasks-changed', repo: channel.repoRoot });
    }
  });
}

function writeTaskEvent(res, eventName, payload) {
  res.write('event: ' + eventName + '\n');
  res.write('data: ' + JSON.stringify(payload) + '\n\n');
}

function removeTaskEventClient(channel, res) {
  var index = channel.clients.indexOf(res);
  if (index >= 0) channel.clients.splice(index, 1);
  if (channel.clients.length) return;

  if (channel.watcher) channel.watcher.close();
  clearTimeout(channel.debounceTimer);
  clearTimeout(channel.retryTimer);
  clearInterval(channel.heartbeatTimer);
  delete taskEventChannels[channel.key];
}

function readRepositoryTasks(root) {
  var repoRoot = git.repoRoot(root);
  var dir = repositoryTasksDir(repoRoot);
  if (!fs.existsSync(dir)) {
    return {
      tasks: [],
      directory: path.relative(repoRoot, dir)
    };
  }

  var tasks = fs.readdirSync(dir)
    .filter(function (name) { return /\.md$/i.test(name); })
    .map(function (name) {
      return readRepositoryTaskFile(repoRoot, path.join(dir, name));
    })
    .filter(Boolean)
    .sort(function (a, b) {
      var statusOrder = TASK_STATUSES.indexOf(a.status) - TASK_STATUSES.indexOf(b.status);
      if (statusOrder !== 0) return statusOrder;
      return String(b.updated || b.created || '').localeCompare(String(a.updated || a.created || '')) ||
        String(a.id).localeCompare(String(b.id));
    });

  return {
    tasks: tasks,
    directory: path.relative(repoRoot, dir)
  };
}

function createRepositoryTask(root, input) {
  var repoRoot = git.repoRoot(root);
  input = input || {};
  var content = String(input.content || '').trim();
  var status = normalizeTaskStatus(input.status || 'todo');
  if (!content) throwHttpError('Task content is required');
  if (content.length > 12000) throwHttpError('Task content is too long');

  var now = new Date().toISOString();
  var task = {
    id: nextRepositoryTaskId(repoRoot),
    status: status,
    created: now,
    updated: now,
    content: content
  };
  writeRepositoryTask(repoRoot, task);
  return {
    task: task,
    tasks: readRepositoryTasks(repoRoot).tasks
  };
}

function decomposeRepositoryTasks(root, input) {
  var repoRoot = git.repoRoot(root);
  input = input || {};
  var content = String(input.content || '').trim();
  if (!content) throwHttpError('Task content is required');
  if (content.length > 12000) throwHttpError('Task content is too long');

  var selectedAgent = config.currentRepositoryTaskAgent(repoRoot);
  return agent.generateTextAsync(prompts.taskDecompositionPrompt({
    content: content
  }), repoRoot, selectedAgent, {
    outputPrefix: 'gmc-task-decomposition',
    description: 'task decomposition'
  }).then(function (generated) {
    return taskStatus.parseTaskDecomposition(generated);
  }).then(function (decomposition) {
    var createdTasks = decomposition.map(function (task) {
      return createRepositoryTask(repoRoot, {
        content: task.content,
        status: 'todo'
      }).task;
    });
    return {
      agent: selectedAgent,
      createdTasks: createdTasks,
      tasks: readRepositoryTasks(repoRoot).tasks
    };
  }).catch(function (error) {
    var generationError = new Error('AI task decomposition failed: ' + error.message);
    generationError.httpStatus = 500;
    throw generationError;
  });
}

function updateRepositoryTask(root, input, options) {
  var repoRoot = git.repoRoot(root);
  input = input || {};
  options = options || {};
  var id = normalizeTaskId(input.id);
  if (!id) throwHttpError('Task id is required');
  var filePath = path.join(repositoryTasksDir(repoRoot), id + '.md');
  if (!isPathInside(repositoryTasksDir(repoRoot), filePath) || !fs.existsSync(filePath)) {
    throwHttpError('Task not found: ' + id);
  }

  var task = readRepositoryTaskFile(repoRoot, filePath);
  if (!task) throwHttpError('Task not found: ' + id);
  var previousStatus = task.status;
  if (Object.prototype.hasOwnProperty.call(input, 'content')) {
    var content = String(input.content || '').trim();
    if (!content) throwHttpError('Task content is required');
    if (content.length > 12000) throwHttpError('Task content is too long');
    task.content = content;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'status')) {
    task.status = normalizeTaskStatus(input.status);
  }
  var selectedAgent = null;
  if (previousStatus === 'todo' && TASK_AGENT_STATUSES.indexOf(task.status) >= 0) {
    selectedAgent = task.status;
  } else if (previousStatus === 'todo' && task.status === 'doing') {
    selectedAgent = config.currentRepositoryTaskAgent(repoRoot);
  }
  var shouldLaunchAgent = !!selectedAgent;
  var agentLaunch = null;
  if (shouldLaunchAgent) {
    if (!options.allowAgentLaunch) {
      var localOnlyError = new Error('Starting an Agent is only available from 127.0.0.1.');
      localOnlyError.httpStatus = 403;
      throw localOnlyError;
    }
    agentLaunch = openAgentAtRepository(repoRoot, selectedAgent, prompts.taskPrompt(task));
    agentLaunch.agent = selectedAgent;
    agentLaunch.taskId = task.id;
  }
  task.updated = new Date().toISOString();
  writeRepositoryTask(repoRoot, task);
  return {
    task: task,
    tasks: readRepositoryTasks(repoRoot).tasks,
    agentLaunch: agentLaunch
  };
}

function deleteRepositoryTask(root, input) {
  var repoRoot = git.repoRoot(root);
  input = input || {};
  var id = normalizeTaskId(input.id);
  if (!id) throwHttpError('Task id is required');
  var dir = repositoryTasksDir(repoRoot);
  var filePath = path.join(dir, id + '.md');
  if (!isPathInside(dir, filePath) || !fs.existsSync(filePath)) {
    throwHttpError('Task not found: ' + id);
  }
  fs.unlinkSync(filePath);
  return {
    status: 'ok',
    deleted: id,
    tasks: readRepositoryTasks(repoRoot).tasks
  };
}

function readRepositoryTaskFile(repoRoot, filePath) {
  if (!isPathInside(repositoryTasksDir(repoRoot), filePath)) return null;
  var raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return null;
  }

  var parsed = parseTaskMarkdown(raw);
  var id = normalizeTaskId(parsed.meta.id) || normalizeTaskId(path.basename(filePath, '.md'));
  if (!id) return null;
  var task = {
    id: id,
    status: normalizeTaskStatus(parsed.meta.status || 'todo'),
    created: String(parsed.meta.created || ''),
    updated: String(parsed.meta.updated || parsed.meta.created || ''),
    content: parsed.content.trim(),
    path: path.relative(repoRoot, filePath)
  };
  if (parsed.meta.title) {
    task.title = String(parsed.meta.title).trim().slice(0, 160);
  }
  return task;
}

function writeRepositoryTask(repoRoot, task) {
  var dir = repositoryTasksDir(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  var filePath = path.join(dir, normalizeTaskId(task.id) + '.md');
  if (!isPathInside(dir, filePath)) throwHttpError('Invalid task id');
  fs.writeFileSync(filePath, taskMarkdown(task));
}

function taskMarkdown(task) {
  var lines = [
    '---',
    'id: ' + task.id,
  ];
  if (task.title) {
    lines.push('title: ' + JSON.stringify(task.title));
  }
  return lines.concat([
    'status: ' + normalizeTaskStatus(task.status || 'todo'),
    'created: ' + JSON.stringify(task.created || new Date().toISOString()),
    'updated: ' + JSON.stringify(task.updated || task.created || new Date().toISOString()),
    '---',
    '',
    String(task.content || '').trim(),
    ''
  ]).join(String.fromCharCode(10));
}

function parseTaskMarkdown(raw) {
  var text = String(raw || '');
  var match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) {
    return { meta: {}, content: text };
  }
  var meta = {};
  match[1].split(/\r?\n/).forEach(function (line) {
    var item = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!item) return;
    meta[item[1]] = parseTaskScalar(item[2]);
  });
  return {
    meta: meta,
    content: text.slice(match[0].length)
  };
}

function parseTaskScalar(value) {
  value = String(value || '').trim();
  if (!value) return '';
  if ((value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') ||
      (value.charAt(0) === '[' && value.charAt(value.length - 1) === ']')) {
    try {
      return JSON.parse(value);
    } catch (e) { /* fall back */ }
  }
  return value;
}

function nextRepositoryTaskId(repoRoot) {
  var dir = repositoryTasksDir(repoRoot);
  var max = 0;
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir).forEach(function (name) {
      var match = /^GMC-(\d+)\.md$/i.exec(name);
      if (match) max = Math.max(max, Number(match[1]) || 0);
    });
  }
  return 'GMC-' + String(max + 1).padStart(4, '0');
}

function repositoryTasksDir(repoRoot) {
  return path.join(repoRoot, '.gmc', 'tasks');
}

function normalizeTaskId(value) {
  var id = String(value || '').trim().toUpperCase();
  return /^GMC-\d{4,}$/.test(id) ? id : '';
}

function normalizeTaskStatus(value) {
  value = String(value || '').trim().toLowerCase();
  return TASK_STATUSES.indexOf(value) >= 0 ? value : 'todo';
}

function isPathInside(parent, child) {
  var relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!!relative && relative.indexOf('..') !== 0 && !path.isAbsolute(relative));
}

function collectStatus(root) {
  var t0 = Date.now();
  var timings = {};
  var t, statusOutput, worktreeStat, stagedStat, branchList, commitList, contribs, globalContribs, binding, taskList;

  t = Date.now();
  root = git.repoRoot(root);
  timings.repoRoot = Date.now() - t;

  t = Date.now();
  recordRepositoryVisitIfStale(root);
  timings.recordVisit = Date.now() - t;

  t = Date.now();
  var branch = git.currentBranch(root) || '(detached)';
  timings.currentBranch = Date.now() - t;

  t = Date.now();
  var upstream = runGitOptional(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  timings.upstream = Date.now() - t;

  t = Date.now();
  statusOutput = parseStatusOutput(runGitOptional(root, ['status', '--porcelain=v1', '-b', '-z']));
  timings.status = Date.now() - t;

  t = Date.now();
  var remote = runGitOptional(root, ['remote', 'get-url', 'origin']);
  timings.remote = Date.now() - t;

  t = Date.now();
  var aheadBehind = upstream ? parseAheadBehind(runGitOptional(root, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'])) : {
    ahead: 0,
    behind: 0
  };
  timings.aheadBehind = Date.now() - t;

  t = Date.now();
  var installStatus = checkInstallStatus(root);
  timings.installCheck = Date.now() - t;

  t = Date.now();
  worktreeStat = runGitOptional(root, ['diff', '--stat']);
  timings.worktreeDiff = Date.now() - t;

  t = Date.now();
  stagedStat = runGitOptional(root, ['diff', '--cached', '--stat']);
  timings.stagedDiff = Date.now() - t;

  t = Date.now();
  branchList = branches(root);
  timings.branches = Date.now() - t;

  t = Date.now();
  commitList = commits(root, 44);
  timings.commits = Date.now() - t;

  t = Date.now();
  contribs = contributions(root);
  globalContribs = globalContributions(root, contribs);
  timings.contributions = Date.now() - t;

  t = Date.now();
  binding = safeBinding(root);
  timings.binding = Date.now() - t;

  t = Date.now();
  taskList = safeTasks(root);
  timings.tasks = Date.now() - t;

  timings.total = Date.now() - t0;

  if (process.env.GMC_DEBUG_TIMING) {
    console.error('[gmc:timing] collectStatus for %s total=%dms', root, timings.total);
    Object.keys(timings).forEach(function (key) {
      console.error('[gmc:timing]   %s: %dms', key, timings[key]);
    });
  }

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
    status: statusOutput,
    stats: {
      worktree: worktreeStat,
      staged: stagedStat
    },
    branches: branchList,
    commits: commitList,
    contributions: contribs,
    globalContributions: globalContribs,
    binding: binding,
    tasks: taskList,
    install: installStatus,
    timings: timings
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
  }).filter(function (branch) {
    return branch.name && !/\/HEAD$/.test(branch.name);
  });
}

function checkoutBranch(root, branchName) {
  var repoRoot = git.repoRoot(root);
  var name = String(branchName || '').trim();
  if (!name || name.indexOf('\0') >= 0) {
    throwHttpError('Invalid branch name');
  }

  var allBranches = branches(repoRoot);
  var selected = allBranches.find(function (branch) {
    return branch.name === name;
  });
  if (!selected) {
    throwHttpError('Branch not found: ' + name);
  }
  if (selected.current) {
    return collectStatus(repoRoot);
  }

  var result;
  if (selected.remote) {
    var localName = name.replace(/^[^\/]+\//, '');
    var localExists = allBranches.some(function (branch) {
      return !branch.remote && branch.name === localName;
    });
    result = childProcess.spawnSync('git', localExists ? ['switch', localName] : ['switch', '--track', name], {
      cwd: repoRoot,
      encoding: 'utf8'
    });
  } else {
    result = childProcess.spawnSync('git', ['switch', name], {
      cwd: repoRoot,
      encoding: 'utf8'
    });
  }

  if (result.error || result.status !== 0) {
    var message = (result.stderr || result.stdout || result.error && result.error.message || 'git switch failed').trim();
    throwHttpError(message || 'Failed to switch branch.');
  }
  return collectStatus(repoRoot);
}

function repositoryTree(root, treePath, recursive) {
  var repoRoot = git.repoRoot(root);
  var cleanPath = normalizeRepositoryPath(treePath, true);
  var branch = git.currentBranch(repoRoot) || '(detached)';
  if (!hasHead(repoRoot)) {
    return {
      branch: branch,
      path: cleanPath,
      entries: [],
      tree: recursive ? { name: '', path: '', type: 'tree', children: [] } : null
    };
  }

  if (recursive) {
    return {
      branch: branch,
      path: cleanPath,
      entries: listRepositoryTree(repoRoot, cleanPath),
      tree: buildRepositoryTree(repoRoot)
    };
  }

  return {
    branch: branch,
    path: cleanPath,
    entries: listRepositoryTree(repoRoot, cleanPath)
  };
}

function listRepositoryTree(repoRoot, treePath) {
  var spec = treePath ? ('HEAD:' + treePath) : 'HEAD';
  var output = runGitOptional(repoRoot, ['ls-tree', '-z', '-l', spec]);
  if (!output) return [];
  var entries = output.split('\0').filter(Boolean).map(function (record) {
    return parseLsTreeRecord(record, treePath);
  }).filter(Boolean).sort(compareTreeEntries);

  var hasTrees = entries.some(function (entry) { return entry.type === 'tree'; });
  if (hasTrees) {
    var subfolderSizes = {};
    var recursiveOutput = runGitOptional(repoRoot, ['ls-tree', '-r', '-z', '-l', spec]);
    if (recursiveOutput) {
      recursiveOutput.split('\0').filter(Boolean).forEach(function (record) {
        var tab = record.indexOf('\t');
        if (tab < 0) return;
        var meta = record.slice(0, tab).split(/\s+/);
        if (meta[1] === 'blob' && meta[3] && meta[3] !== '-') {
          var size = Number(meta[3]) || 0;
          var relativePath = record.slice(tab + 1);
          var slashIndex = relativePath.indexOf('/');
          if (slashIndex >= 0) {
            var topLevelDir = relativePath.slice(0, slashIndex);
            if (topLevelDir) {
              subfolderSizes[topLevelDir] = (subfolderSizes[topLevelDir] || 0) + size;
            }
          }
        }
      });
    }
    entries.forEach(function (entry) {
      if (entry.type === 'tree') {
        entry.size = subfolderSizes[entry.name] || 0;
      }
    });
  }
  return entries;
}

function getRecursiveTreeSize(repoRoot, treePath) {
  var output = runGitOptional(repoRoot, ['ls-tree', '-r', '-z', '-l', 'HEAD:' + treePath]);
  if (!output) return 0;
  var total = 0;
  output.split('\0').filter(Boolean).forEach(function (record) {
    var tab = record.indexOf('\t');
    if (tab < 0) return;
    var meta = record.slice(0, tab).split(/\s+/);
    if (meta[1] === 'blob' && meta[3] && meta[3] !== '-') {
      total += Number(meta[3]) || 0;
    }
  });
  return total;
}

function parseLsTreeRecord(record, parentPath) {
  var tab = record.indexOf('\t');
  if (tab < 0) return null;
  var meta = record.slice(0, tab).split(/\s+/);
  var name = record.slice(tab + 1);
  var type = meta[1] === 'tree' ? 'tree' : meta[1] === 'commit' ? 'submodule' : 'blob';
  return {
    name: name,
    path: parentPath ? (parentPath + '/' + name) : name,
    type: type,
    mode: meta[0] || '',
    hash: meta[2] || '',
    size: meta[3] && meta[3] !== '-' ? Number(meta[3]) || 0 : null
  };
}

function buildRepositoryTree(repoRoot) {
  var root = { name: '', path: '', type: 'tree', children: [] };
  var output = runGitOptional(repoRoot, ['ls-tree', '-r', '-z', '-l', 'HEAD']);
  if (!output) return root;

  output.split('\0').filter(Boolean).forEach(function (record) {
    var entry = parseLsTreeRecord(record, '');
    if (!entry) return;
    var parts = entry.path.split('/');
    var cursor = root;
    var cursorPath = '';
    parts.forEach(function (part, index) {
      cursorPath = cursorPath ? (cursorPath + '/' + part) : part;
      var isLeaf = index === parts.length - 1;
      var child = cursor.children.find(function (item) {
        return item.name === part;
      });
      if (!child) {
        child = isLeaf ? {
          name: part,
          path: entry.path,
          type: entry.type,
          mode: entry.mode,
          size: entry.size,
          children: []
        } : {
          name: part,
          path: cursorPath,
          type: 'tree',
          children: []
        };
        cursor.children.push(child);
      }
      cursor = child;
    });
  });

  sortRepositoryTree(root);
  return root;
}

function sortRepositoryTree(node) {
  if (!node || !node.children) return;
  node.children.sort(compareTreeEntries);
  node.children.forEach(sortRepositoryTree);
}

function compareTreeEntries(a, b) {
  var aTree = a.type === 'tree';
  var bTree = b.type === 'tree';
  if (aTree && !bTree) return -1;
  if (!aTree && bTree) return 1;
  return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
}

function repositoryFile(root, filePath) {
  var repoRoot = git.repoRoot(root);
  var cleanPath = normalizeRepositoryPath(filePath, false);
  if (!hasHead(repoRoot)) throwHttpError('Repository has no commits.');
  var type = runGitOptional(repoRoot, ['cat-file', '-t', 'HEAD:' + cleanPath]);
  if (type !== 'blob') {
    throwHttpError('Not a file: ' + cleanPath);
  }
  var size = Number(runGitOptional(repoRoot, ['cat-file', '-s', 'HEAD:' + cleanPath])) || 0;
  var mime = mimeTypeForPath(cleanPath);
  var maxReadableBytes = 1024 * 1024;
  var maxBinaryBytes = 5 * 1024 * 1024;
  var payload = {
    branch: git.currentBranch(repoRoot) || '(detached)',
    path: cleanPath,
    name: path.basename(cleanPath),
    type: 'blob',
    size: size,
    mime: mime,
    language: languageForPath(cleanPath),
    binary: true,
    truncated: false,
    content: '',
    dataUrl: ''
  };

  if (size > maxBinaryBytes) {
    return payload;
  }

  var result = childProcess.spawnSync('git', ['show', 'HEAD:' + cleanPath], {
    cwd: repoRoot,
    encoding: 'buffer',
    maxBuffer: maxBinaryBytes + 1024
  });
  if (result.error || result.status !== 0) {
    throwHttpError(((result.stderr && result.stderr.toString('utf8')) || result.error && result.error.message || 'Failed to read file').trim());
  }
  var buffer = result.stdout || Buffer.alloc(0);
  var binary = isBinaryBuffer(buffer);
  payload.binary = binary;
  if (binary) {
    if (mime.indexOf('image/') === 0) {
      payload.dataUrl = 'data:' + mime + ';base64,' + buffer.toString('base64');
    }
    return payload;
  }

  payload.binary = false;
  payload.truncated = buffer.length > maxReadableBytes;
  payload.content = buffer.slice(0, maxReadableBytes).toString('utf8');
  return payload;
}

function fileDiff(root, filePath) {
  var repoRoot = git.repoRoot(root);
  var cleanPath = normalizeRepositoryPath(filePath, false);
  var changedFiles = parseStatusOutput(runGitOptional(repoRoot, ['status', '--porcelain=v1', '-b', '-z'])).files;
  var file = changedFiles.find(function (item) {
    return item.path === cleanPath;
  });
  if (!file) {
    throwHttpError('File has no working tree changes: ' + cleanPath);
  }

  // Merge conflict file — show working tree diff with marker highlighting
  if (file.code === 'UU') {
    var output = runGitOptional(repoRoot, ['diff', 'HEAD', '--', cleanPath]);
    if (!output && file.originalPath) {
      output = runGitOptional(repoRoot, ['diff', 'HEAD', '--', file.originalPath, cleanPath]);
    }
    var truncated = output.length > DIFF_LIMIT;
    if (truncated) {
      output = output.slice(0, DIFF_LIMIT) + '\n\n[Diff truncated by gmc]\n';
    }
    return {
      path: cleanPath,
      displayPath: file.displayPath || cleanPath,
      code: 'UU',
      diff: output,
      truncated: truncated,
      mergeConflict: true
    };
  }

  var output = '';
  if (file.code === '??') {
    var untracked = childProcess.spawnSync('git', ['diff', '--no-index', '--', os.devNull || '/dev/null', cleanPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: DIFF_LIMIT + 1024
    });
    output = (untracked.stdout || untracked.stderr || '').trim();
  } else {
    output = runGitOptional(repoRoot, ['diff', 'HEAD', '--', cleanPath]);
    if (!output && file.originalPath) {
      output = runGitOptional(repoRoot, ['diff', 'HEAD', '--', file.originalPath, cleanPath]);
    }
  }

  var truncated = output.length > DIFF_LIMIT;
  if (truncated) {
    output = output.slice(0, DIFF_LIMIT) + '\n\n[Diff truncated by gmc]\n';
  }

  return {
    path: cleanPath,
    displayPath: file.displayPath || cleanPath,
    code: file.code,
    diff: output,
    truncated: truncated
  };
}

function hasHead(repoRoot) {
  return runGitOptional(repoRoot, ['rev-parse', '--verify', 'HEAD']) !== '';
}

function normalizeRepositoryPath(value, allowEmpty) {
  var clean = String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!clean) {
    if (allowEmpty) return '';
    throwHttpError('Missing repository path');
  }
  if (path.isAbsolute(clean) || clean.indexOf('\0') >= 0) {
    throwHttpError('Invalid repository path');
  }
  var parts = clean.split('/');
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i] || parts[i] === '.' || parts[i] === '..') {
      throwHttpError('Invalid repository path');
    }
  }
  return clean;
}

function isBinaryBuffer(buffer) {
  if (!buffer || !buffer.length) return false;
  var sampleSize = Math.min(buffer.length, 8000);
  for (var i = 0; i < sampleSize; i++) {
    var byte = buffer[i];
    if (byte === 0) return true;
  }
  return false;
}

function mimeTypeForPath(filePath) {
  var ext = path.extname(filePath).toLowerCase();
  var types = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };
  return types[ext] || 'text/plain; charset=utf-8';
}

function languageForPath(filePath) {
  var ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  var map = {
    js: 'JavaScript',
    jsx: 'JSX',
    ts: 'TypeScript',
    tsx: 'TSX',
    json: 'JSON',
    md: 'Markdown',
    css: 'CSS',
    html: 'HTML',
    sh: 'Shell',
    yml: 'YAML',
    yaml: 'YAML'
  };
  return map[ext] || (ext ? ext.toUpperCase() : 'Text');
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

function mergeContribCounts(target, source) {
  if (!source) return;
  Object.keys(source).forEach(function (day) {
    target[day] = (target[day] || 0) + source[day];
  });
}

function globalContributions(currentRoot, currentContribs) {
  var cache = loadContributionsCache();
  var repos = readRecentRepositories();
  var globalCounts = {};
  var currentNormalized = '';
  try {
    currentNormalized = currentRoot ? path.resolve(currentRoot) : '';
  } catch (e) {
    currentNormalized = currentRoot || '';
  }

  var dirty = false;

  if (currentNormalized && currentContribs) {
    var curCommitTime = getRepoLastCommitTime(currentNormalized);
    if (!cache[currentNormalized] || cache[currentNormalized].lastCommitTime !== curCommitTime) {
      cache[currentNormalized] = {
        lastCommitTime: curCommitTime,
        counts: currentContribs
      };
      dirty = true;
    }
  }

  var processedCurrent = false;

  repos.forEach(function (repo) {
    if (!repo || !repo.path) return;
    var repoPath = repo.path;
    var normalizedPath = '';
    try {
      normalizedPath = path.resolve(repoPath);
    } catch (e) {
      normalizedPath = repoPath;
    }

    if (currentNormalized && normalizedPath === currentNormalized) {
      processedCurrent = true;
      mergeContribCounts(globalCounts, currentContribs || {});
      return;
    }

    var cached = cache[normalizedPath];
    if (cached && cached.lastCommitTime === repo.lastCommitTime && cached.counts) {
      mergeContribCounts(globalCounts, cached.counts);
      return;
    }

    if (!fs.existsSync(repoPath)) return;
    var counts = contributions(repoPath);
    cache[normalizedPath] = {
      lastCommitTime: repo.lastCommitTime,
      counts: counts
    };
    dirty = true;
    mergeContribCounts(globalCounts, counts);
  });

  if (!processedCurrent && currentContribs) {
    mergeContribCounts(globalCounts, currentContribs);
  }

  if (dirty) {
    saveContributionsCache();
  }

  return globalCounts;
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

function commitSelectedFiles(root, selectedFiles, language, source) {
  if (source === 'modified') {
    return commitSelectedModifiedFiles(root, selectedFiles, language);
  }
  if (source && source !== 'staged') {
    throwHttpError('Invalid commit source: ' + source);
  }
  return commitSelectedStagedFiles(root, selectedFiles, language);
}

function commitSelectedModifiedFiles(root, selectedFiles, language) {
  var repoRoot = git.repoRoot(root);
  var selection = validateStatusSelection(repoRoot, selectedFiles, function (file) {
    return file.worktree !== ' ';
  }, 'modified file to commit');
  var originalHead = runGitOptional(repoRoot, ['rev-parse', '--verify', 'HEAD']);
  var originalIndexTree = writeIndexTree(repoRoot);

  try {
    stageSelectedFiles(repoRoot, selection.files);
    return commitSelectedStagedFiles(repoRoot, selection.files, language);
  } catch (error) {
    if (runGitOptional(repoRoot, ['rev-parse', '--verify', 'HEAD']) === originalHead) {
      restoreIndexTree(repoRoot, originalIndexTree);
    }
    throw error;
  }
}

function commitSelectedStagedFiles(root, selectedFiles, language) {
  var repoRoot = git.repoRoot(root);
  if (!Array.isArray(selectedFiles) || !selectedFiles.length) {
    throwHttpError('Select at least one staged file to commit.');
  }

  var changedFiles = parseStatusOutput(runGitOptional(repoRoot, ['status', '--porcelain=v1', '-b', '-z'])).files;
  var allowed = {};
  changedFiles.forEach(function (file) {
    if (file.index !== ' ' && file.index !== '?') allowed[file.path] = file;
  });

  var files = [];
  selectedFiles.forEach(function (filePath) {
    var cleanPath = String(filePath || '').trim();
    if (!cleanPath || path.isAbsolute(cleanPath) || cleanPath.indexOf('\0') >= 0 || !allowed[cleanPath]) {
      throwHttpError('Invalid or unchanged file selection: ' + cleanPath);
    }
    if (files.indexOf(cleanPath) < 0) {
      files.push(cleanPath);
    }
  });

  var selected = {};
  files.forEach(function (filePath) { selected[filePath] = true; });
  var unselectedPaths = [];
  changedFiles.forEach(function (file) {
    if (file.index !== ' ' && file.index !== '?' && !selected[file.path]) {
      appendStatusGitPaths(unselectedPaths, file);
    }
  });

  var mergeConflictModule = require('./merge-conflict');
  var isMergeInProgress = mergeConflictModule.inMerge(repoRoot);
  if (isMergeInProgress && unselectedPaths.length) {
    throwHttpError('All staged files must be selected to complete a merge commit.');
  }

  var installed = checkInstallStatus(repoRoot);
  var result;
  var taskUpdates = [];
  var savedIndexTree = null;

  if (unselectedPaths.length) {
    savedIndexTree = writeIndexTree(repoRoot);
  }

  try {
    if (unselectedPaths.length) resetIndexPaths(repoRoot, unselectedPaths);
    // During a merge, partial commit is forbidden. Complete the merge as a whole.
    if (isMergeInProgress) {
      result = childProcess.spawnSync('git', ['commit', '--no-edit'], {
        cwd: repoRoot,
        encoding: 'utf8'
      });
    } else if (installed.hooks) {
      // Hooks installed: git commit -m gmc triggers the commit-msg hook which generates AI message.
      writeCommitLanguage(repoRoot, language);
      result = childProcess.spawnSync('git', ['commit', '-m', 'gmc'], {
        cwd: repoRoot,
        encoding: 'utf8'
      });
    } else {
      // No hooks: generate AI commit message directly from the selected staged changes.
      var binding = safeBinding(repoRoot);
      var diff = git.stagedDiff(repoRoot);
      if (diff.length > DIFF_LIMIT) {
        diff = diff.slice(0, DIFF_LIMIT) + '\n\n[Diff truncated by gmc]\n';
      }
      var tasks = taskStatus.readUnfinishedTasksForPrompt(repoRoot);
      var promptOptions = language && language !== 'en' ? { language: language } : undefined;
      var prompt = tasks.length ? prompts.commitMessagePlanPrompt(
        binding,
        diff,
        git.statusShort(repoRoot),
        tasks,
        promptOptions
      ) : prompts.commitMessagePrompt(
        binding,
        diff,
        git.statusShort(repoRoot),
        promptOptions
      );
      var aiMessage;
      try {
        var selectedAgent = config.currentCommitAgent();
        var generated = agent.generateText(prompt, repoRoot, selectedAgent, {
          outputPrefix: tasks.length ? 'gmc-commit-plan' : 'gmc-commit-message',
          description: tasks.length ? 'commit plan generation' : 'commit message generation'
        });
        if (tasks.length) {
          var plan = taskStatus.parseCommitPlan(generated);
          generated = plan.message;
          taskUpdates = plan.taskUpdates;
        }
        aiMessage = prompts.appendCreatedBy(
          generated,
          selectedAgent
        );
        aiMessage = commitMessage.prepare(aiMessage, binding);
      } catch (aiError) {
        var err = new Error('AI commit message generation failed: ' + aiError.message);
        err.httpStatus = 500;
        throw err;
      }
      var messageFile = git.writeGitFile(repoRoot, 'GMC_WEB_COMMIT_EDITMSG', aiMessage);
      result = childProcess.spawnSync('git', ['commit', '-F', messageFile], {
        cwd: repoRoot,
        encoding: 'utf8'
      });
    }
  } finally {
    if (savedIndexTree) restoreIndexTree(repoRoot, savedIndexTree);
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

  var appliedTaskUpdates = applyTaskUpdatesAfterCommit(repoRoot, taskUpdates);
  return {
    status: 'ok',
    oid: runGitOptional(repoRoot, ['rev-parse', 'HEAD']),
    output: ((result.stdout || '') + (result.stderr || '')).trim(),
    taskUpdates: appliedTaskUpdates.updates,
    tasks: safeTasks(repoRoot)
  };
}

function stageSelectedFiles(root, selectedFiles) {
  var repoRoot = git.repoRoot(root);
  var selection = validateStatusSelection(repoRoot, selectedFiles, function (file) {
    return file.worktree !== ' ';
  }, 'modified file to stage');
  var result = childProcess.spawnSync('git', ['add', '-A', '--'].concat(selection.gitPaths), {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  if (result.error || result.status !== 0) {
    throwHttpError('Failed to stage files: ' + ((result.stderr || result.stdout || '').trim()));
  }
  return { status: 'ok', staged: selection.files };
}

function unstageSelectedFiles(root, selectedFiles) {
  var repoRoot = git.repoRoot(root);
  var selection = validateStatusSelection(repoRoot, selectedFiles, function (file) {
    return file.index !== ' ' && file.index !== '?';
  }, 'staged file to unstage');
  resetIndexPaths(repoRoot, selection.gitPaths);
  return { status: 'ok', unstaged: selection.files };
}

function validateStatusSelection(repoRoot, selectedFiles, predicate, description) {
  if (!Array.isArray(selectedFiles) || !selectedFiles.length) {
    throwHttpError('Select at least one ' + description + '.');
  }
  var changedFiles = parseStatusOutput(runGitOptional(repoRoot, ['status', '--porcelain=v1', '-b', '-z'])).files;
  var allowed = {};
  changedFiles.forEach(function (file) {
    if (predicate(file)) allowed[file.path] = file;
  });
  var files = [];
  var gitPaths = [];
  selectedFiles.forEach(function (filePath) {
    var cleanPath = String(filePath || '').trim();
    if (!cleanPath || path.isAbsolute(cleanPath) || cleanPath.indexOf('\0') >= 0 || !allowed[cleanPath]) {
      throwHttpError('Invalid file selection: ' + cleanPath);
    }
    if (files.indexOf(cleanPath) < 0) {
      files.push(cleanPath);
      appendStatusGitPaths(gitPaths, allowed[cleanPath]);
    }
  });
  return { files: files, gitPaths: gitPaths };
}

function appendStatusGitPaths(gitPaths, file) {
  if (file.originalPath && gitPaths.indexOf(file.originalPath) < 0) gitPaths.push(file.originalPath);
  if (gitPaths.indexOf(file.path) < 0) gitPaths.push(file.path);
}

function resetIndexPaths(repoRoot, gitPaths) {
  var hasHead = !!runGitOptional(repoRoot, ['rev-parse', '--verify', 'HEAD']);
  var args = hasHead
    ? ['restore', '--staged', '--'].concat(gitPaths)
    : ['rm', '--cached', '-r', '-f', '--ignore-unmatch', '--'].concat(gitPaths);
  var result = childProcess.spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throwHttpError('Failed to unstage files: ' + ((result.stderr || result.stdout || '').trim()));
  }
}

function writeIndexTree(repoRoot) {
  var result = childProcess.spawnSync('git', ['write-tree'], { cwd: repoRoot, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throwHttpError('Failed to prepare selected staged files: ' + ((result.stderr || result.stdout || '').trim()));
  }
  return String(result.stdout || '').trim();
}

function restoreIndexTree(repoRoot, tree) {
  var result = childProcess.spawnSync('git', ['read-tree', tree], { cwd: repoRoot, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throwHttpError('Failed to restore the staged files: ' + ((result.stderr || result.stdout || '').trim()));
  }
}

function writeCommitLanguage(root, language) {
  if (language && language !== 'en') {
    git.writeGitFile(root, 'gmc/commit-language', language);
  }
}

function applyTaskUpdatesAfterCommit(root, updates) {
  if (!updates || !updates.length) {
    return { updates: [], paths: [] };
  }
  try {
    return taskStatus.applyUpdates(root, updates);
  } catch (error) {
    return {
      updates: [],
      paths: [],
      error: error.message
    };
  }
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
    fs.writeFileSync(gitignorePath, existing + prefix + additions.join(String.fromCharCode(10)) + '\n');
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
  var selection = validateStatusSelection(repoRoot, selectedFiles, function (file) {
    return file.worktree !== ' ';
  }, 'modified file to restore');
  var tracked = [];
  var untracked = [];
  var changedFiles = parseStatusOutput(runGitOptional(repoRoot, ['status', '--porcelain=v1', '-b', '-z'])).files;
  var byPath = {};
  changedFiles.forEach(function (file) { byPath[file.path] = file; });
  selection.files.forEach(function (filePath) {
    if (byPath[filePath].code === '??') untracked.push(filePath);
    else appendStatusGitPaths(tracked, byPath[filePath]);
  });

  if (tracked.length) {
    var restoreRes = childProcess.spawnSync('git', ['restore', '--worktree', '--'].concat(tracked), { cwd: repoRoot, encoding: 'utf8' });
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

  return { status: 'ok', restored: selection.files };
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
    '  gmc <issue> [--agent codex|claude|antigravity|opencode] [--exec] [--no-branch]',
    '  gmc agent [codex|claude|antigravity|opencode]',
    '  gmc bind <issue> [--agent codex|claude|antigravity|opencode]',
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
    '  gmc install --all installs hooks.',
    '  gmc install-hooks sets up Git hooks for AI commit messages and task status updates.',
    '  gmc web serves the Git Web UI. If a server is already running, it will just',
    '    open the current repository in the browser.',
    '',
    'Examples:',
    '  git commit -m gmc',
    '  gmc agent antigravity',
    '  gmc GH-234 --agent codex',
    '  git add . && gmc message',
    '  git add . && gmc commit',
    '  gmc retry HEAD',
    '  gmc install --all',
    '  gmc install-hooks && git commit -m gmc',
    '  gmc web'
  ].join(String.fromCharCode(10));
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
  var address = 'http://127.0.0.1:' + port + '/?name=' + encodeURIComponent(repoName(repoRoot));
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
  ].join(String.fromCharCode(10)) + '\n';

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
<script>
(function() {
  var validThemes = ['default', 'dark', 'ocean', 'purple'];
  var theme = 'default';
  try {
    var saved = localStorage.getItem('gmc_theme');
    if (saved && validThemes.indexOf(saved) !== -1) theme = saved;
  } catch (e) {}
  document.documentElement.setAttribute('data-theme', theme);
})();
</script>
<style>
:root, html[data-theme="default"] {
  color-scheme: light;
  --bg: #f4f6f8;
  --bg-top: #ffffff;
  --panel: #ffffff;
  --panel-soft: #f8fafc;
  --text: #111827;
  --muted: #6b7280;
  --line: #dbe2ea;
  --line-soft: #edf1f5;
  --accent: #068d6d;
  --accent-soft: #eff6ff;
  --green: #0f9f6e;
  --rose: #dc2626;
  --amber: #b45309;
  --shadow: 0 18px 45px rgba(15, 23, 42, .12);
  --sidebar-w: 260px;
  --sidebar-bg: #f1f5f9;
  --sidebar-border: #e2e8f0;
  --sidebar-gradient: linear-gradient(180deg, rgba(255,255,255,.72), rgba(241,245,249,.92));
  --topbar-bg: rgba(255, 255, 255, 0.92);
  --topbar-border: rgba(219, 226, 234, 0.82);
  --hero-bg: linear-gradient(135deg, #ffffff 0%, #f0fdf4 44%, #eff6ff 100%);
  --input-bg: #f8fafc;
  --code-bg: #f8fafc;
  --code-text: #334155;
  --diff-add-bg: #dcfce7;
  --diff-add-text: #166534;
  --diff-del-bg: #fee2e2;
  --diff-del-text: #991b1b;
  --diff-hunk-bg: #eff6ff;
  --diff-hunk-text: #1d4ed8;
  --z-sidebar: 1000;
  --z-navbar: 900;
  --z-drawer: 1100;
  --z-modal: 1200;
}
html[data-theme="dark"] {
  color-scheme: dark;
  --bg: #0b0f17;
  --bg-top: #0f172a;
  --panel: #1e293b;
  --panel-soft: #141e2e;
  --text: #f8fafc;
  --muted: #94a3b8;
  --line: #334155;
  --line-soft: #273549;
  --accent: #38bdf8;
  --accent-soft: rgba(56, 189, 248, 0.15);
  --green: #34d399;
  --rose: #f87171;
  --amber: #fbbf24;
  --shadow: 0 18px 45px rgba(0, 0, 0, .45);
  --sidebar-bg: #0f172a;
  --sidebar-border: #1e293b;
  --sidebar-gradient: linear-gradient(180deg, rgba(30,41,59,.85), rgba(15,23,42,.95));
  --topbar-bg: rgba(15, 23, 42, 0.92);
  --topbar-border: rgba(51, 65, 85, 0.82);
  --hero-bg: linear-gradient(135deg, #1e293b 0%, #0f2b3c 44%, #182238 100%);
  --input-bg: #0f172a;
  --code-bg: #0f172a;
  --code-text: #e2e8f0;
  --diff-add-bg: rgba(22, 101, 52, 0.35);
  --diff-add-text: #4ade80;
  --diff-del-bg: rgba(153, 27, 27, 0.35);
  --diff-del-text: #f87171;
  --diff-hunk-bg: rgba(29, 78, 216, 0.35);
  --diff-hunk-text: #60a5fa;
}
html[data-theme="ocean"] {
  color-scheme: light;
  --bg: #f0f7ff;
  --bg-top: #ffffff;
  --panel: #ffffff;
  --panel-soft: #f4f9ff;
  --text: #0f172a;
  --muted: #64748b;
  --line: #cbd5e1;
  --line-soft: #e2e8f0;
  --accent: #2563eb;
  --accent-soft: #eff6ff;
  --green: #10b981;
  --rose: #ef4444;
  --amber: #f59e0b;
  --shadow: 0 18px 45px rgba(37, 99, 235, .12);
  --sidebar-bg: #e0f2fe;
  --sidebar-border: #bae6fd;
  --sidebar-gradient: linear-gradient(180deg, rgba(255,255,255,.8), rgba(224,242,254,.95));
  --topbar-bg: rgba(255, 255, 255, 0.92);
  --topbar-border: rgba(186, 230, 253, 0.82);
  --hero-bg: linear-gradient(135deg, #ffffff 0%, #e0f2fe 44%, #eff6ff 100%);
  --input-bg: #f4f9ff;
  --code-bg: #f4f9ff;
  --code-text: #1e293b;
  --diff-add-bg: #dcfce7;
  --diff-add-text: #166534;
  --diff-del-bg: #fee2e2;
  --diff-del-text: #991b1b;
  --diff-hunk-bg: #eff6ff;
  --diff-hunk-text: #1d4ed8;
}
html[data-theme="purple"] {
  color-scheme: dark;
  --bg: #130d24;
  --bg-top: #1a1033;
  --panel: #1d1536;
  --panel-soft: #17102b;
  --text: #f5f3ff;
  --muted: #a78bfa;
  --line: #37285a;
  --line-soft: #271c44;
  --accent: #a855f7;
  --accent-soft: rgba(168, 85, 247, 0.18);
  --green: #34d399;
  --rose: #f87171;
  --amber: #fbbf24;
  --shadow: 0 18px 45px rgba(0, 0, 0, .5);
  --sidebar-bg: #1a1033;
  --sidebar-border: #271c44;
  --sidebar-gradient: linear-gradient(180deg, rgba(29,21,54,.85), rgba(19,13,36,.95));
  --topbar-bg: rgba(26, 16, 51, 0.92);
  --topbar-border: rgba(55, 40, 90, 0.82);
  --hero-bg: linear-gradient(135deg, #1d1536 0%, #2e104d 44%, #180d30 100%);
  --input-bg: #17102b;
  --code-bg: #17102b;
  --code-text: #ede9fe;
  --diff-add-bg: rgba(22, 101, 52, 0.35);
  --diff-add-text: #4ade80;
  --diff-del-bg: rgba(153, 27, 27, 0.35);
  --diff-del-text: #f87171;
  --diff-hunk-bg: rgba(168, 85, 247, 0.35);
  --diff-hunk-text: #c084fc;
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text); font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; overflow-x: hidden; }
body { background: linear-gradient(180deg, var(--bg-top) 0, var(--bg) 280px); }
.app-container { min-width: 0; min-height: 100vh; }
.sidebar {
  width: var(--sidebar-w);
  background: var(--sidebar-gradient), var(--sidebar-bg);
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
.sidebar-header h2 { font-size: 11px; font-weight: 800; color: var(--muted); text-transform: uppercase; letter-spacing: 0.1em; margin: 0; }
.repo-list { flex: 1; overflow-y: auto; padding: 8px 12px 18px; }
.repo-empty {
  border: 1px dashed var(--line);
  border-radius: 8px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.45;
  padding: 14px;
  background: var(--panel-soft);
}
.repo-item {
  position: relative;
  display: block;
  width: 100%;
  min-width: 0;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  margin-bottom: 8px;
  transition: background .18s, border-color .18s, box-shadow .18s, transform .18s;
  color: inherit;
  background: var(--panel-soft);
  border: 1px solid var(--line-soft);
  box-shadow: 0 1px 2px rgba(15,23,42,.035);
  outline: none;
}
.repo-item:hover, .repo-item:focus-visible {
  border-color: var(--accent);
  background: var(--accent-soft);
  transform: translateY(-1px);
  box-shadow: 0 12px 26px rgba(15,23,42,.08);
}
.repo-item.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  box-shadow: inset 3px 0 0 var(--accent), 0 10px 24px rgba(15,23,42,.10);
}
.repo-item-body { width: 100%; min-width: 0; padding-right: 0; }
.repo-item-header { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding-right: 18px; }
.repo-item-name { font-weight: 750; font-size: 13.5px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.repo-branch-pill { display: inline-flex; align-items: center; gap: 3px; max-width: 90px; font-size: 10px; font-weight: 600; color: var(--muted); background: var(--panel); border: 1px solid var(--line-soft); border-radius: 999px; padding: 1px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; }
.repo-branch-icon { width: 10px; height: 10px; flex-shrink: 0; }
.repo-branch-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.repo-item-path { width: 100%; font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 3px; opacity: 0.86; }
.repo-item-footer { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-top: 6px; width: 100%; min-width: 0; }
.repo-item-time { font-size: 10.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; }
.repo-pills-wrap { display: inline-flex; align-items: center; gap: 4px; flex-wrap: nowrap; margin-left: auto; flex-shrink: 0; }
.repo-pill { display: inline-flex; align-items: center; font-size: 10px; font-weight: 700; line-height: 1; padding: 2px 5px; border-radius: 4px; font-family: ui-monospace, monospace; }
.repo-pill-unstaged { color: var(--amber); background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.28); }
.repo-pill-staged { color: var(--emerald); background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.28); }
.repo-pill-untracked { color: var(--muted); background: rgba(148, 163, 184, 0.12); border: 1px solid rgba(148, 163, 184, 0.28); }
.repo-pill-ahead { color: var(--accent); background: rgba(59, 130, 246, 0.12); border: 1px solid rgba(59, 130, 246, 0.28); }
.repo-pill-behind { color: var(--purple); background: rgba(168, 85, 247, 0.12); border: 1px solid rgba(168, 85, 247, 0.28); }
.repo-pill-clean { display: inline-flex; align-items: center; font-size: 10px; font-weight: 600; color: var(--muted); opacity: 0.75; }
.repo-item.active .repo-item-name { color: var(--accent); }
.repo-item.active .repo-item-path { color: var(--muted); opacity: 0.7; }
.repo-remove {
  position: absolute;
  top: 7px;
  right: 7px;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--line-soft);
  border-radius: 999px;
  color: var(--muted);
  background: var(--panel);
  opacity: 0;
  transform: scale(.92);
  cursor: pointer;
  transition: opacity .14s, transform .14s, color .14s, background .14s, border-color .14s;
  z-index: 2;
}
.repo-item:hover .repo-remove,
.repo-item:focus-within .repo-remove,
.repo-remove:focus-visible {
  opacity: 1;
  transform: scale(1);
}
.repo-remove:hover {
  color: var(--rose);
  background: rgba(248, 113, 113, 0.15);
  border-color: var(--rose);
}
.repo-remove svg { width: 14px; height: 14px; pointer-events: none; }

.shell { min-width: 0; min-height: 100vh; margin-left: var(--sidebar-w); padding: 82px 32px 32px; transition: margin-left 0.4s cubic-bezier(0.16, 1, 0.3, 1); pointer-events: none; }
.sidebar.collapsed + .shell { margin-left: 0; }
.shell-inner { width: min(1480px, 100%); margin: 0 auto; }
.shell-inner > *, .view-page, .task-page, .settings-page, .home-page, .topbar { pointer-events: auto; }
.topbar { position: fixed; left: var(--sidebar-w); right: 0; top: 0; z-index: var(--z-navbar); padding: 0 32px; background: var(--topbar-bg); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); border-bottom: 1px solid var(--topbar-border); box-shadow: 0 1px 2px rgba(15, 23, 42, .04); transition: left 0.4s cubic-bezier(0.16, 1, 0.3, 1); }
.sidebar.collapsed + .shell .topbar { left: 0; }
.topbar-inner { width: min(1480px, 100%); min-height: 64px; margin: 0 auto; display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 16px; }
.topbar-brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
.topbar-tools { display: contents; }
h1 { margin: 0; font-size: 22px; font-weight: 760; letter-spacing: 0; line-height: 1.1; }
h2 { margin: 0; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; }
.repo-line { display: block; margin-top: 2px; }
.repo { display: block; min-width: 0; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-decoration: none; }
.repo[href]:hover { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
.agent-bar { display: flex; align-items: center; gap: 4px; margin-top: 6px; flex-wrap: wrap; }
.agent-bar[hidden] { display: none; }
.agent-btn { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px 3px 6px; border: 1px solid var(--line); border-radius: 6px; color: var(--muted); background: transparent; cursor: pointer; font-size: 11px; font-weight: 500; white-space: nowrap; transition: color .16s, background .16s, border-color .16s; }
.agent-btn:hover { color: var(--accent); background: var(--accent-soft); border-color: var(--accent); }
.agent-btn svg { width: 14px; height: 14px; flex-shrink: 0; pointer-events: none; }
.agent-btn[hidden] { display: none; }
.actions { display: flex; gap: 8px; align-items: center; flex-wrap: nowrap; justify-content: flex-end; min-width: 0; }
.local-security-controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.local-security-controls[hidden] { display: none; }
.actions button, .commit-button, .ignore-button { border: 1px solid var(--line); background: var(--panel); color: var(--text); border-radius: 7px; min-height: 34px; padding: 7px 12px; cursor: pointer; font-weight: 650; }
.actions button:hover, .commit-button:hover:not(:disabled), .ignore-button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
.settings-button { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }
.settings-button svg { width: 16px; height: 16px; pointer-events: none; }
.view-tabs { display: inline-flex; align-items: center; justify-self: center; gap: 4px; margin: 0; padding: 4px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-soft); box-shadow: 0 1px 2px rgba(15,23,42,.04); }
.view-tab { display: inline-flex; align-items: center; gap: 7px; min-height: 34px; padding: 7px 12px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--muted); cursor: pointer; font-weight: 750; transition: background .16s, color .16s, border-color .16s, box-shadow .16s, transform .16s; }
.view-tab svg { width: 16px; height: 16px; }
.view-tab:hover { color: var(--accent); background: var(--accent-soft); }
.view-tab.active { color: #fff; background: linear-gradient(135deg, var(--accent), var(--green)); border-color: transparent; box-shadow: 0 10px 24px rgba(6,141,109,.22); }
.tab-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; font-size: 11px; font-weight: 700; line-height: 1; color: #fff; box-sizing: border-box; margin-left: 2px; }
.tab-badge-git { background-color: #ef4444; }
.tab-badge-task { background-color: #f97316; }
.view-tabs[hidden] { display: none !important; }
.view-page[hidden], .task-page[hidden], .settings-page[hidden], .home-page[hidden] { display: none !important; }
.language-wrap { position: relative; }
.language-button { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }
.language-button svg { width: 16px; height: 16px; pointer-events: none; }
.language-menu { position: absolute; right: 0; top: calc(100% + 8px); width: 188px; padding: 6px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); box-shadow: var(--shadow); z-index: var(--z-modal); display: none; }
.language-menu.open { display: grid; gap: 4px; }
.language-menu button { width: 100%; justify-content: flex-start; text-align: left; border-color: transparent; background: transparent; }
.language-menu button:hover, .language-menu button.active { border-color: var(--line); background: var(--accent-soft); color: var(--accent); }
.lan-access { display: none; align-items: center; gap: 8px; min-height: 34px; max-width: min(420px, 46vw); padding: 6px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); color: var(--text); font-size: 13px; font-weight: 650; }
.lan-access.visible { display: inline-flex; }
.lan-access svg { width: 17px; height: 17px; color: var(--accent); flex: 0 0 auto; }
.lan-access span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.toggle-control { display: inline-flex; align-items: center; gap: 8px; min-height: 34px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); color: var(--text); font-size: 13px; font-weight: 650; cursor: pointer; user-select: none; }
.toggle-control:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
.toggle-control input { position: absolute; opacity: 0; pointer-events: none; }
.toggle-track { width: 34px; height: 20px; border-radius: 999px; background: var(--line); position: relative; transition: background .15s; flex: 0 0 auto; }
.toggle-track::after { content: ""; position: absolute; width: 16px; height: 16px; left: 2px; top: 2px; border-radius: 50%; background: var(--panel); box-shadow: 0 1px 3px rgba(15,23,42,.24); transition: transform .15s; }
.toggle-control input:checked + .toggle-track { background: var(--accent); }
.toggle-control input:checked + .toggle-track::after { transform: translateX(14px); }
.toggle-control input:focus-visible + .toggle-track { outline: 2px solid #93c5fd; outline-offset: 2px; }
#rotateToken { opacity: 0; transform: translateY(-4px) scale(.98); pointer-events: none; max-width: 0; padding-left: 0; padding-right: 0; border-width: 0; overflow: hidden; transition: opacity .16s, transform .16s, max-width .2s, padding .2s, border-width .2s; white-space: nowrap; }
#rotateToken.visible { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; max-width: 120px; padding-left: 12px; padding-right: 12px; border-width: 1px; }
.settings-page #rotateToken { opacity: 1; transform: none; pointer-events: auto; max-width: none; padding-left: 12px; padding-right: 12px; border-width: 1px; }
.settings-page { display: grid; gap: 16px; }
.settings-page[hidden] { display: none; }
.settings-hero { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; margin-bottom: 2px; }
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
.access-address { display: inline-flex; max-width: 100%; margin-top: 10px; padding: 7px 9px; border-radius: 7px; background: var(--input-bg); border: 1px solid var(--line-soft); color: var(--text); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qr-shell { display: grid; gap: 12px; justify-items: center; }
.qr-box { display: grid; place-items: center; width: 244px; height: 244px; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
.qr-box svg { display: block; width: 224px; height: 224px; }
.qr-placeholder { display: grid; place-items: center; width: 100%; height: 100%; border-radius: 7px; background: var(--panel-soft); color: var(--muted); text-align: center; font-size: 13px; line-height: 1.5; padding: 20px; }
.access-url { width: 100%; min-height: 62px; padding: 10px; resize: none; border: 1px solid var(--line); border-radius: 7px; background: var(--input-bg); color: var(--text); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.45; }
.settings-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; width: 100%; }
.settings-warning { display: none; margin-top: 12px; padding: 10px 12px; border: 1px solid rgba(245, 158, 11, 0.35); border-radius: 7px; background: rgba(245, 158, 11, 0.12); color: var(--amber); font-size: 12px; line-height: 1.5; }
.settings-warning.visible { display: block; }
.settings-subsection { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--line-soft); }
.settings-subsection h4 { margin: 0 0 6px; font-size: 14px; }
.agent-selector { margin-top: 16px; }
.agent-selector + .agent-selector { padding-top: 16px; border-top: 1px solid var(--line-soft); }
.agent-selector h4 { margin: 0; font-size: 14px; }
.agent-selector p { margin: 4px 0 10px; font-size: 12px; }
.radio-group { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 10px; }
.radio-label { display: flex; align-items: center; gap: 6px; padding: 7px 12px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); cursor: pointer; font-size: 13px; color: var(--text); transition: border-color .15s, background .15s; }
.radio-label:hover { border-color: var(--accent); background: var(--accent-soft); }
.radio-label input[type="radio"] { display: none; }
.radio-label:has(input:checked) { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.radio-indicator { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--line); background: var(--panel); flex-shrink: 0; }
.radio-label input:checked + .radio-indicator { border-color: var(--accent); background: var(--accent); box-shadow: inset 0 0 0 3px var(--panel); }
.settings-card-full { grid-column: 1 / -1; }
.theme-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px; margin-top: 14px; }
.theme-card-option { position: relative; border: 2px solid var(--line); border-radius: 8px; padding: 14px; background: var(--panel); cursor: pointer; transition: border-color .16s, box-shadow .16s, transform .16s; display: flex; flex-direction: column; gap: 10px; user-select: none; }
.theme-card-option:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 6px 16px rgba(15, 23, 42, .08); }
.theme-card-option.active { border-color: var(--accent); background: var(--panel); box-shadow: 0 0 0 3px var(--accent-soft), 0 6px 16px rgba(15, 23, 42, .12); }
.theme-card-preview { height: 60px; border-radius: 6px; padding: 10px; display: flex; flex-direction: column; justify-content: space-between; border: 1px solid var(--line-soft); position: relative; overflow: hidden; }
.theme-card-preview-bar { display: flex; align-items: center; gap: 6px; }
.theme-card-preview-dot { width: 10px; height: 10px; border-radius: 50%; }
.theme-card-preview-pill { height: 6px; border-radius: 3px; flex: 1; }
.theme-card-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.theme-card-title { font-size: 13px; font-weight: 750; color: var(--text); }
.theme-card-badge { font-size: 11px; font-weight: 750; color: var(--accent); background: var(--accent-soft); padding: 2px 8px; border-radius: 999px; display: none; }
.theme-card-option.active .theme-card-badge { display: inline-flex; }
.commit-button { background: var(--accent); border-color: var(--accent); color: #fff; }
.commit-button:hover:not(:disabled) { color: #fff; background: #1d4ed8; }
.ignore-button { color: var(--rose); }
.ignore-button:hover:not(:disabled) { border-color: var(--rose); color: var(--rose); background: rgba(248, 113, 113, 0.15); }
.commit-button:disabled, .ignore-button:disabled { opacity: .45; cursor: not-allowed; }
.install-banner { display: none; background: #dc2626; color: #fff; padding: 10px 20px; border-radius: 8px; margin-bottom: 16px; font-size: 13px; font-weight: 600; align-items: center; justify-content: space-between; gap: 12px; }
.install-banner.visible { display: flex; }
.install-banner .install-text { flex: 1; }
.install-banner button { background: #fff; color: #dc2626; border: none; border-radius: 6px; padding: 6px 16px; font-weight: 700; cursor: pointer; white-space: nowrap; font-size: 13px; }
.install-banner button:hover { background: #fef2f2; }
.install-banner button:disabled { opacity: .6; cursor: not-allowed; }
.task-page { display: grid; gap: 16px; }
.task-hero { position: relative; display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; overflow: hidden; padding: 20px; border: 1px solid var(--line); border-radius: 8px; background: var(--hero-bg); box-shadow: 0 1px 2px rgba(15,23,42,.04); }
.task-hero::after { content: ""; position: absolute; width: 220px; height: 220px; right: -88px; top: -112px; border-radius: 50%; background: radial-gradient(circle, rgba(6,141,109,.16), rgba(6,141,109,0) 64%); pointer-events: none; }
.task-hero-main { position: relative; z-index: 1; min-width: 0; }
.task-hero h2 { margin: 0; color: var(--text); font-size: 24px; line-height: 1.1; text-transform: none; letter-spacing: 0; }
.task-hero p { margin: 7px 0 0; max-width: 720px; color: var(--muted); line-height: 1.58; }
.task-actions { position: relative; z-index: 1; display: grid; gap: 10px; justify-items: end; }
.task-action-buttons { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.task-repo-agent { display: grid; gap: 5px; justify-items: end; }
.task-repo-agent[hidden] { display: none; }
.task-repo-agent-label { color: var(--muted); font-size: 12px; font-weight: 750; }
.task-repo-agent .radio-group { gap: 6px; margin: 0; justify-content: flex-end; }
.task-repo-agent .radio-label { padding: 5px 8px; background: var(--panel-soft); font-size: 12px; }
.task-repo-agent .radio-indicator { width: 12px; height: 12px; }
.task-repo-agent .meta { min-height: 17px; }
.task-primary { display: inline-flex; align-items: center; gap: 8px; min-height: 36px; padding: 8px 13px; border: 1px solid transparent; border-radius: 7px; color: #fff; background: linear-gradient(135deg, var(--accent), #0f9f6e); cursor: pointer; font-weight: 780; box-shadow: 0 12px 26px rgba(6,141,109,.22); transition: transform .16s, box-shadow .16s; }
.task-primary:hover { transform: translateY(-1px); box-shadow: 0 16px 34px rgba(6,141,109,.25); }
.task-primary svg { width: 16px; height: 16px; }
.task-meta-line { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; color: var(--muted); font-size: 12px; }
.task-pill { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 5px 8px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel-soft); overflow: hidden; }
.task-pill strong { color: var(--accent); }
.task-error { display: none; padding: 10px 12px; border: 1px solid rgba(248, 113, 113, 0.35); border-radius: 7px; background: rgba(248, 113, 113, 0.12); color: var(--rose); font-size: 13px; }
.task-error.visible { display: block; }
.task-composer { display: grid; gap: 12px; padding: 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); box-shadow: var(--shadow); transform-origin: top right; animation: taskComposerIn .18s ease-out; }
.task-composer[hidden] { display: none; }
.task-form-grid { display: grid; grid-template-columns: 1fr; gap: 12px; align-items: start; }
.task-field { display: grid; gap: 6px; min-width: 0; }
.task-field label { color: var(--muted); font-size: 12px; font-weight: 750; }
.task-field input, .task-field textarea, .task-field select { width: 100%; border: 1px solid var(--line); border-radius: 7px; background: var(--input-bg); color: var(--text); font: inherit; padding: 9px 10px; outline: none; transition: border-color .16s, background .16s, box-shadow .16s; }
.task-field textarea { min-height: 132px; resize: vertical; line-height: 1.5; }
.task-field input:focus, .task-field textarea:focus, .task-field select:focus { border-color: var(--accent); background: var(--panel); box-shadow: 0 0 0 3px var(--accent-soft); }
.task-content-input { position: relative; min-width: 0; }
.task-content-input textarea { display: block; padding-right: 54px; }
.task-speech-button { position: absolute; right: 8px; bottom: 8px; display: grid; place-items: center; width: 38px; height: 38px; padding: 0; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); color: var(--accent); cursor: pointer; box-shadow: 0 5px 16px rgba(15,23,42,.12); transition: color .16s, background .16s, border-color .16s, box-shadow .16s, transform .16s; }
.task-speech-button:hover:not(:disabled) { border-color: var(--accent); background: var(--accent-soft); transform: translateY(-1px); }
.task-speech-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.task-speech-button:disabled { color: var(--muted); opacity: .48; cursor: not-allowed; box-shadow: none; }
.task-speech-button svg { width: 19px; height: 19px; pointer-events: none; }
.task-speech-button.listening { color: #fff; border-color: var(--rose); background: var(--rose); box-shadow: 0 0 0 5px color-mix(in srgb, var(--rose) 18%, transparent), 0 8px 20px rgba(220,38,38,.25); animation: taskSpeechPulse 1.35s ease-in-out infinite; }
.task-speech-meta { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 20px; color: var(--muted); font-size: 11.5px; }
.task-speech-status { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.task-speech-status.active { color: var(--rose); font-weight: 750; }
.task-speech-status.error { color: var(--rose); }
.task-speech-status.active::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 16%, transparent); }
.task-speech-hint { white-space: nowrap; }
.task-speech-hint kbd { display: inline-flex; align-items: center; min-height: 19px; padding: 1px 6px; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 5px; background: var(--panel-soft); color: var(--text); font: 10.5px ui-monospace, SFMono-Regular, Menlo, monospace; }
.task-form-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.task-board { display: grid; grid-template-columns: repeat(5, minmax(210px, 1fr)); gap: 14px; align-items: start; min-height: 360px; }
.task-column { position: relative; min-width: 0; min-height: 280px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-soft); box-shadow: 0 1px 2px rgba(15,23,42,.04); transition: border-color .16s, background .16s, box-shadow .16s, transform .16s; }
.task-column.drag-over { border-color: var(--accent); background: var(--accent-soft); box-shadow: 0 16px 34px rgba(6,141,109,.14); transform: translateY(-2px); }
.task-column-head { display: grid; gap: 9px; margin-bottom: 10px; }
.task-column-head-main { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.task-column-title { display: inline-flex; align-items: center; gap: 8px; min-width: 0; font-weight: 800; color: var(--text); }
.task-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--task-color, var(--accent)); box-shadow: 0 0 0 4px color-mix(in srgb, var(--task-color, var(--accent)) 14%, transparent); }
.task-dot.breathing { animation: taskDotBreathing 1.8s ease-in-out infinite; }
.task-count { display: grid; place-items: center; min-width: 26px; height: 24px; padding: 0 7px; border-radius: 999px; background: var(--input-bg); color: var(--muted); font-weight: 800; font-size: 12px; }
.task-agent-monitor { display: grid; gap: 7px; min-width: 0; padding: 9px; border: 1px solid var(--line-soft); border-radius: 7px; background: var(--panel); color: var(--muted); font-size: 11px; line-height: 1.35; }
.task-agent-monitor-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.task-agent-monitor-state { display: inline-flex; align-items: center; gap: 6px; min-width: 0; color: var(--muted); font-weight: 800; }
.task-agent-monitor-state::before { content: ""; flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 14%, transparent); }
.task-agent-monitor[data-monitor-state="working"] .task-agent-monitor-state { color: var(--green); }
.task-agent-monitor[data-monitor-state="working"] .task-agent-monitor-state::before { animation: taskDotBreathing 1.8s ease-in-out infinite; }
.task-agent-monitor[data-monitor-state="idle"] .task-agent-monitor-state { color: var(--amber); }
.task-agent-monitor[data-monitor-state="paused"] {
  border-color: color-mix(in srgb, var(--amber) 72%, var(--line));
  background: var(--panel);
  animation: agentMonitorPausedBreathing 1.4s ease-in-out infinite;
}
.task-agent-monitor[data-monitor-state="paused"] .task-agent-monitor-state { color: var(--amber); }
.task-agent-monitor[data-monitor-state="paused"] .task-agent-monitor-state::before {
  animation: taskDotBreathing 1.1s ease-in-out infinite;
}
.task-agent-monitor[data-monitor-state="stopped"] .task-agent-monitor-state { color: var(--muted); }
.task-agent-monitor[data-monitor-state="unavailable"] .task-agent-monitor-state,
.task-agent-monitor[data-monitor-state="timeout"] .task-agent-monitor-state,
.task-agent-monitor[data-monitor-state="unknown"] .task-agent-monitor-state { color: var(--rose); }
.task-agent-monitor-metrics { display: flex; flex-wrap: wrap; gap: 4px 8px; color: var(--muted); }
.task-agent-monitor-metrics span { white-space: nowrap; }
.task-agent-monitor-sources { display: grid; gap: 3px; padding-top: 6px; border-top: 1px solid var(--line-soft); }
.task-agent-monitor-source { display: flex; justify-content: space-between; gap: 8px; min-width: 0; }
.task-agent-monitor-source span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-agent-monitor-usage { display: grid; gap: 4px; padding-top: 6px; border-top: 1px solid var(--line-soft); }
.task-agent-usage-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.03em; color: var(--muted); font-weight: 700; }
.task-agent-usage-title { color: var(--text-muted, var(--muted)); }
.task-agent-usage-plan { padding: 1px 5px; border-radius: 4px; background: color-mix(in srgb, var(--task-color, var(--accent)) 12%, transparent); color: var(--task-color, var(--accent)); font-weight: 700; font-size: 10px; text-transform: none; }
.task-agent-usage-windows { display: grid; gap: 5px; }
.task-agent-usage-item { display: grid; gap: 3px; font-size: 11px; }
.task-agent-usage-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.task-agent-usage-label { color: var(--muted); white-space: nowrap; }
.task-agent-usage-val { font-weight: 700; color: var(--text); white-space: nowrap; }
.task-agent-usage-progress { width: 100%; height: 4px; background: color-mix(in srgb, var(--text) 10%, transparent); border-radius: 999px; overflow: hidden; }
.task-agent-usage-progress-bar { height: 100%; border-radius: 999px; transition: width 0.3s ease; }
.task-agent-usage-error { font-size: 10px; color: var(--rose); word-break: break-word; }
.task-column-body { display: grid; gap: 10px; min-height: 220px; align-content: start; align-items: start; grid-auto-rows: 132px; }
.task-empty { display: grid; place-items: center; min-height: 116px; border: 1px dashed var(--line); border-radius: 8px; color: var(--muted); font-size: 12px; text-align: center; padding: 14px; background: var(--panel); }
.task-card { position: relative; display: grid; grid-template-rows: 30px minmax(0, 1fr) auto; gap: 8px; height: 132px; padding: 0 12px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); box-shadow: 0 8px 22px rgba(15,23,42,.06); cursor: grab; overflow: hidden; transition: transform .16s, box-shadow .16s, border-color .16s; }
.task-card:hover { transform: translateY(-2px); border-color: color-mix(in srgb, var(--task-color, var(--accent)) 42%, var(--line)); box-shadow: 0 16px 36px rgba(15,23,42,.11); }
.task-card.dragging { opacity: .52; transform: rotate(1deg) scale(.98); }
.task-card-band { display: flex; align-items: center; min-height: 30px; margin: 0 -12px; padding: 0 42px 0 12px; background: linear-gradient(90deg, var(--task-color, var(--accent)), color-mix(in srgb, var(--task-color, var(--accent)) 60%, var(--panel))); }
.task-remove { position: absolute; top: 4px; right: 8px; display: grid; place-items: center; width: 22px; height: 22px; padding: 0; border: 1px solid rgba(255,255,255,.36); border-radius: 999px; color: #fff; background: rgba(255,255,255,.16); opacity: 0; transform: scale(.92); cursor: pointer; transition: opacity .14s, transform .14s, color .14s, background .14s, border-color .14s; }
.task-card:hover .task-remove, .task-card:focus-within .task-remove, .task-remove:focus-visible { opacity: 1; transform: scale(1); }
.task-remove:hover { color: #fff; background: rgba(220,38,38,.92); border-color: rgba(255,255,255,.58); }
.task-remove svg { width: 14px; height: 14px; pointer-events: none; }
.task-id { color: #fff; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; font-weight: 900; text-shadow: 0 1px 2px rgba(15,23,42,.18); }
.task-card-copy { display: grid; align-content: start; gap: 5px; min-width: 0; min-height: 0; margin: 0; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; overflow: hidden; }
.task-card-title { display: block; color: var(--text); font-size: 14px; line-height: 1.32; font-weight: 800; letter-spacing: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-card-summary { display: -webkit-box; color: var(--muted); font-size: 12.5px; line-height: 1.42; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.task-card-copy:not(.has-title) .task-card-summary { color: var(--text); font-size: 13.5px; line-height: 1.48; -webkit-line-clamp: 3; }
.task-card-copy:hover .task-card-title, .task-card-copy:hover .task-card-summary { color: var(--accent); }
.task-card-footer { display: flex; justify-content: space-between; align-items: center; gap: 8px; color: var(--muted); font-size: 11px; }
.task-card-actions { display: flex; gap: 5px; }
.task-mini-button { display: inline-grid; place-items: center; width: 28px; height: 26px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); color: var(--muted); cursor: pointer; }
.task-mini-button:hover { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
.task-mini-button:disabled { opacity: .32; cursor: default; }
.task-mini-button:disabled:hover { color: var(--muted); border-color: var(--line); background: var(--panel); }
.task-board-loading { grid-column: 1 / -1; display: grid; place-items: center; min-height: 260px; color: var(--muted); border: 1px dashed var(--line); border-radius: 8px; background: var(--panel-soft); }
@keyframes taskComposerIn { from { opacity: 0; transform: translateY(-8px) scale(.99); } to { opacity: 1; transform: translateY(0) scale(1); } }
@keyframes taskSpeechPulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.06); } }
.grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 440px); gap: 16px; align-items: start; min-width: 0; }
.grid > *, .summary-panel > *, .side, .panel { min-width: 0; }
.panel { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 16px; box-shadow: 0 1px 2px rgba(15, 23, 42, .04); }
.summary-panel { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 440px); gap: 16px; margin-bottom: 16px; align-items: stretch; min-width: 0; }
.branch-summary-panel { display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; }
.branch-summary-text { min-width: 0; flex: 1 1 auto; }
.branch-name { font-size: 32px; font-weight: 780; margin: 3px 0 2px; letter-spacing: 0; overflow-wrap: anywhere; }
.branch-selector-wrap-inline { position: relative; }
.branch-selector-wrap-inline .branch-selector-button {
  font-size: 32px; font-weight: 780; padding: 3px 10px 3px 6px; margin: 3px 0 2px;
  border: 1px solid transparent; background: transparent; color: var(--text);
  cursor: pointer; border-radius: 7px; min-height: auto; gap: 6px;
}
.branch-selector-wrap-inline .branch-selector-button:hover,
.branch-selector-wrap-inline .branch-selector-button.open {
  border-color: var(--accent); color: var(--accent); background: var(--accent-soft);
}
.branch-selector-wrap-inline .branch-selector-button svg { width: 22px; height: 22px; flex-shrink: 0; }
.branch-selector-wrap-inline .branch-selector-button .chevron { width: 20px; height: 20px; color: var(--muted); }
.branch-selector-wrap-inline .branch-selector-menu { left: 0; top: calc(100% + 4px); }
.action-panel { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.action-meters { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.action-meter { padding: 8px 10px; border-radius: 6px; background: var(--panel-soft); border: 1px solid var(--line-soft); position: relative; }
.action-meter strong { display: block; font-size: 18px; color: var(--accent); line-height: 1.15; }
.action-meter span { font-size: 11px; color: var(--muted); }
.action-meter .action-btn { position: absolute; right: 8px; top: 8px; font-size: 10px; padding: 2px 7px; border-radius: 4px; border: 1px solid var(--line); background: var(--panel); cursor: pointer; color: var(--text); font-weight: 600; }
.action-meter .action-btn:hover { border-color: var(--accent); color: var(--accent); }
.action-meter .action-btn:disabled { opacity: .62; cursor: progress; color: var(--muted); background: var(--panel-soft); }
.action-buttons { display: flex; gap: 8px; align-items: stretch; flex-wrap: wrap; }
.action-buttons[hidden] { display: none; }
.panel-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; }
.timeline-container { --graph-width: 30px; display: grid; grid-template-columns: var(--graph-width) minmax(0, 1fr); column-gap: 6px; align-items: flex-start; position: relative; height: min(66vh, 680px); min-height: 430px; min-width: 0; overflow-y: auto; overflow-x: hidden; border: 1px solid var(--line-soft); border-radius: 8px; background: var(--panel-soft); padding: 10px 10px 10px 4px; }
#graph { width: var(--graph-width); min-width: var(--graph-width); pointer-events: auto; overflow: visible; }
.timeline { display: grid; gap: 9px; min-width: 0; overflow: hidden; padding-right: 2px; }
.commit { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; padding: 8px 12px; border: 1px solid var(--line-soft); border-radius: 8px; background: var(--panel); cursor: pointer; touch-action: manipulation; transition: background .16s, border-color .16s, box-shadow .16s, transform .16s; }
.commit > div { min-width: 0; }
.commit:hover { background: var(--accent-soft); border-color: var(--accent); box-shadow: 0 8px 22px rgba(37, 99, 235, .10); transform: translateY(-1px); }
.hash { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 700; }
.subject { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { color: var(--muted); font-size: 12px; }
.commit .meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-status { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 16px; margin-left: 7px; vertical-align: -3px; color: var(--accent); position: relative; }
.ai-status svg { display: block; }
.ai-status-loader { width: 15px; height: 15px; animation: spin 1.05s linear infinite; opacity: .9; }
.ai-status-loader circle { opacity: .22; }
.ai-status-sparkles { position: absolute; right: -1px; top: -3px; width: 11px; height: 11px; color: #0f9f6e; animation: aiPulse 1.35s ease-in-out infinite; filter: drop-shadow(0 1px 2px rgba(15, 159, 110, .18)); }
.side { display: grid; gap: 16px; }
.file-section { display: grid; gap: 8px; }
.file-section + .file-section { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--line); }
.file-section-title { margin: 0; color: var(--text); font-size: 13px; font-weight: 750; }
.file-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.file-toolbar label { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; font-weight: 650; }
.file-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; min-width: 0; }
.files-list { display: grid; max-height: 310px; overflow: auto; border: 1px solid var(--line-soft); border-radius: 8px; }
.file-row { display: grid; grid-template-columns: 24px 42px minmax(0, 1fr); gap: 8px; align-items: center; min-height: 38px; padding: 7px 10px; border-bottom: 1px solid var(--line-soft); cursor: pointer; }
.file-row:last-child { border-bottom: none; }
.file-row:hover { background: var(--accent-soft); }
.file-row input { width: 15px; height: 15px; accent-color: var(--accent); }
.code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--amber); font-weight: 750; }
.file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-diff-link { min-width: 0; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.file-diff-link:hover { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
.commit-status { min-height: 17px; margin-top: 9px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.commit-status.error { color: var(--rose); }
.branch-block { display: inline-block; width: 10px; height: 10px; margin-right: 8px; border-radius: 2px; flex-shrink: 0; }
.branch-tree-row { display: flex; align-items: center; padding: 7px 10px; min-width: 0; border-bottom: 1px solid var(--line-soft); }
.branch-tree-row:hover { background: var(--accent-soft); }
.tree-lines { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre; margin-right: 4px; }
#branches { max-height: 330px; overflow: auto; border: 1px solid var(--line-soft); border-radius: 8px; }
.repo-browser-controls { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.branch-selector-wrap { position: relative; min-width: 0; }
.branch-selector-button { display: inline-flex; align-items: center; gap: 7px; max-width: 100%; min-height: 34px; padding: 7px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); color: var(--text); cursor: pointer; font-weight: 750; }
.branch-selector-button:hover, .branch-selector-button.open { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
.branch-selector-button svg { flex: 0 0 auto; width: 16px; height: 16px; pointer-events: none; }
.branch-selector-button .chevron { width: 14px; height: 14px; color: var(--muted); }
.branch-selector-button span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.branch-selector-menu { position: absolute; left: 0; top: calc(100% + 8px); z-index: var(--z-modal); display: none; width: min(320px, calc(100vw - 40px)); max-height: 360px; overflow: auto; padding: 6px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); box-shadow: var(--shadow); }
.branch-selector-menu.open { display: grid; gap: 3px; }
.branch-option { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; gap: 8px; align-items: center; width: 100%; min-height: 34px; padding: 7px 8px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--text); cursor: pointer; text-align: left; font: inherit; }
.branch-option:hover, .branch-option.current { border-color: var(--line-soft); background: var(--accent-soft); }
.branch-option.current { color: var(--accent); font-weight: 800; }
.branch-option-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.branch-option-type { color: var(--muted); font-size: 11px; font-weight: 700; }
.repo-breadcrumb { display: flex; align-items: center; gap: 4px; min-width: 0; margin: 8px 0 10px; color: var(--muted); font-size: 12px; overflow: hidden; }
.repo-breadcrumb button { min-width: 0; max-width: 180px; padding: 0; border: 0; background: transparent; color: var(--accent); cursor: pointer; font: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.repo-breadcrumb button:hover { text-decoration: underline; text-underline-offset: 3px; }
.repo-breadcrumb span { flex: 0 0 auto; color: var(--muted); }
.repo-browser { overflow: hidden; border: 1px solid var(--line-soft); border-radius: 8px; background: var(--panel); }
.repo-browser-empty, .repo-browser-loading, .file-tree-empty { padding: 18px; color: var(--muted); font-size: 13px; text-align: center; }
.repo-entry { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; align-items: center; gap: 9px; width: 100%; min-height: 39px; padding: 8px 10px; border: 0; border-bottom: 1px solid var(--line-soft); background: var(--panel); color: var(--text); cursor: pointer; text-align: left; font: inherit; }
.repo-entry:last-child { border-bottom: 0; }
.repo-entry:hover { background: var(--accent-soft); color: var(--accent); }
.repo-entry svg { width: 18px; height: 18px; color: var(--muted); }
.repo-entry[data-entry-type="tree"] svg { color: #d97706; }
.repo-entry-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 650; }
.repo-entry-meta { color: var(--muted); font-size: 12px; white-space: nowrap; }
.repo-browser-status { min-height: 18px; margin-top: 8px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.repo-browser-status.error { color: var(--rose); }
.file-detail-page { display: grid; gap: 14px; }
.file-detail-page[hidden] { display: none; }
.diff-detail-page { display: grid; gap: 14px; }
.diff-detail-page[hidden] { display: none; }
.file-detail-toolbar { display: grid; grid-template-columns: auto auto minmax(0, 1fr); align-items: center; gap: 10px; }
.file-detail-toolbar .copy-button { display: inline-flex; align-items: center; gap: 6px; height: 34px; }
.file-detail-toolbar .copy-button svg { width: 15px; height: 15px; }
.file-detail-layout { display: grid; grid-template-columns: minmax(240px, 300px) minmax(0, 1fr); gap: 14px; align-items: start; }
.file-tree-panel, .file-view-panel { min-width: 0; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); box-shadow: 0 1px 2px rgba(15,23,42,.04); }
.file-tree-panel { padding: 14px; max-height: calc(100vh - 166px); overflow: auto; position: sticky; top: 82px; }
.file-view-panel { overflow: hidden; }
.file-tree { display: grid; gap: 2px; font-size: 13px; }
.file-tree-group { display: grid; gap: 2px; }
.file-tree-row { display: grid; grid-template-columns: 18px 17px minmax(0, 1fr); gap: 5px; align-items: center; width: 100%; min-height: 28px; padding: 4px 6px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--text); cursor: pointer; text-align: left; font: inherit; }
.file-tree-row:hover, .file-tree-row.active { background: var(--accent-soft); border-color: var(--line-soft); color: var(--accent); }
.file-tree-row.active { font-weight: 800; }
.file-tree-row svg { width: 15px; height: 15px; color: var(--muted); }
.file-tree-row[data-entry-type="tree"] svg { color: #d97706; }
.file-tree-toggle { display: grid; place-items: center; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--muted); cursor: pointer; }
.file-tree-toggle:hover { background: var(--line-soft); color: var(--accent); }
.file-tree-toggle svg { width: 13px; height: 13px; transition: transform .14s; }
.file-tree-toggle.expanded svg { transform: rotate(90deg); }
.file-tree-toggle-placeholder { width: 18px; height: 18px; }
.file-tree-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-view-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--line-soft); background: var(--panel-soft); }
.file-view-title { margin: 0; color: var(--text); font-size: 16px; line-height: 1.25; letter-spacing: 0; text-transform: none; overflow-wrap: anywhere; }
.file-view-content { min-height: 440px; overflow: auto; background: var(--code-bg); }
.code-view { margin: 0; display: grid; grid-template-columns: auto minmax(0, 1fr); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; line-height: 1.55; }
.code-line-no { padding: 0 10px; color: var(--muted); background: var(--panel-soft); border-right: 1px solid var(--line-soft); text-align: right; user-select: none; }
.code-line-text { min-width: 0; padding: 0 14px; white-space: pre; overflow-wrap: normal; color: var(--code-text); }
.code-line-no, .code-line-text { min-height: 20px; }
.file-binary, .file-image-preview { display: grid; place-items: center; min-height: 360px; padding: 24px; color: var(--muted); text-align: center; }
.file-image-preview img { max-width: 100%; max-height: 70vh; border-radius: 8px; border: 1px solid var(--line-soft); box-shadow: 0 14px 34px rgba(15,23,42,.10); }
.diff-view-panel { min-width: 0; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); box-shadow: 0 1px 2px rgba(15,23,42,.04); overflow: hidden; }
.diff-view-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--line-soft); background: var(--panel-soft); }
.diff-view-title { margin: 0; color: var(--text); font-size: 16px; line-height: 1.25; letter-spacing: 0; text-transform: none; overflow-wrap: anywhere; }
.diff-view-content { min-height: 440px; overflow: auto; background: var(--code-bg); }
.diff-code { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; line-height: 1.55; }
.diff-line { display: block; min-height: 20px; padding: 0 14px; white-space: pre; }
.diff-line.add { background: var(--diff-add-bg); color: var(--diff-add-text); }
.diff-line.del { background: var(--diff-del-bg); color: var(--diff-del-text); }
.diff-line.hunk { background: var(--diff-hunk-bg); color: var(--diff-hunk-text); }
.diff-line.meta { background: var(--panel-soft); color: var(--muted); }
.readme-panel { margin-top: 0; }
.readme-panel .readme-body { padding: 4px 0 0; font-size: 14px; line-height: 1.65; overflow-wrap: break-word; word-break: break-word; }
.readme-body h1, .readme-body h2, .readme-body h3, .readme-body h4 { margin: 1.2em 0 .6em; font-weight: 700; color: var(--text); }
.readme-body h1 { font-size: 22px; border-bottom: 1px solid var(--line-soft); padding-bottom: 6px; }
.readme-body h2 { font-size: 18px; border-bottom: 1px solid var(--line-soft); padding-bottom: 4px; }
.readme-body h3 { font-size: 15px; }
.readme-body p { margin: .6em 0; color: var(--text); }
.readme-body ul, .readme-body ol { padding-left: 24px; margin: .5em 0; color: var(--text); }
.readme-body li { margin: .3em 0; }
.readme-body pre { background: var(--code-bg); border: 1px solid var(--line-soft); border-radius: 6px; padding: 12px; overflow-x: auto; font-size: 13px; line-height: 1.5; color: var(--code-text); }
.readme-body code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; background: var(--code-bg); color: var(--code-text); padding: 2px 5px; border-radius: 4px; }
.readme-body pre code { background: none; padding: 0; font-size: inherit; color: inherit; }
.readme-body blockquote { margin: .6em 0; padding: 4px 14px; border-left: 3px solid var(--accent); background: var(--accent-soft); border-radius: 0 6px 6px 0; color: var(--text); }
.readme-body table { border-collapse: collapse; margin: .8em 0; width: 100%; }
.readme-body th, .readme-body td { border: 1px solid var(--line-soft); padding: 6px 10px; text-align: left; }
.readme-body th { background: var(--panel-soft); font-weight: 700; color: var(--text); }
.readme-body td { color: var(--text); }
.readme-body img { max-width: 100%; border-radius: 6px; }
.readme-body a { color: var(--accent); text-decoration: none; }
.readme-body a:hover { text-decoration: underline; }
.readme-body .mermaid { margin: .8em 0; overflow-x: auto; }
.readme-help pre { white-space: pre-wrap; background: var(--code-bg); border: 1px solid var(--line-soft); padding: 14px; border-radius: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; line-height: 1.6; color: var(--code-text); }
.readme-link { display: inline-flex; align-items: center; min-height: 34px; padding: 7px 12px; border: 1px solid var(--line); border-radius: 7px; color: var(--accent); background: var(--panel); text-decoration: none; font-weight: 650; }
.readme-link:hover { border-color: var(--accent); background: var(--accent-soft); }
.drawer { position: fixed; left: 20px; top: 88px; width: min(520px, calc(100vw - 40px)); max-height: calc(100vh - 116px); background: var(--panel); border: 1px solid var(--line); box-shadow: var(--shadow); border-radius: 8px; padding: 16px; transform: translateY(8px) scale(.98); opacity: 0; pointer-events: none; transition: opacity .16s, transform .16s; z-index: var(--z-drawer); display: flex; flex-direction: column; }
.drawer.open { transform: translateY(0) scale(1); opacity: 1; pointer-events: auto; }
.drawer pre { overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--code-text); background: var(--code-bg); border: 1px solid var(--line-soft); padding: 12px; border-radius: 7px; flex: 1 1 auto; max-height: 240px; }
.drawer-head { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.drawer-actions { display: flex; gap: 8px; flex: 0 0 auto; }
.modal-backdrop { position: fixed; inset: 0; display: grid; place-items: center; padding: 20px; background: rgba(15,23,42,.32); opacity: 0; pointer-events: none; transition: opacity .16s; z-index: var(--z-modal); }
.modal-backdrop.visible { opacity: 1; pointer-events: auto; }
.modal { width: min(460px, 100%); background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); padding: 18px; transform: translateY(8px) scale(.98); transition: transform .16s; }
.modal-backdrop.visible .modal { transform: translateY(0) scale(1); }
.modal h2 { margin: 0 0 8px; color: var(--text); font-size: 16px; letter-spacing: 0; text-transform: none; }
.modal p { margin: 0; color: var(--muted); line-height: 1.55; font-size: 13px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
.task-detail-modal { width: min(680px, 100%); }
.task-detail-head { display: grid; gap: 7px; margin-bottom: 14px; }
.task-detail-meta { display: flex; flex-wrap: wrap; gap: 8px; color: var(--muted); font-size: 12px; }
.task-detail-chip { display: inline-flex; align-items: center; min-height: 24px; padding: 3px 8px; border-radius: 999px; background: var(--panel-soft); color: var(--muted); font-weight: 750; }
.task-detail-chip.status { color: #fff; background: var(--task-color, var(--accent)); }
.task-detail-body { max-height: min(54vh, 460px); overflow: auto; padding: 13px; border: 1px solid var(--line-soft); border-radius: 8px; background: var(--panel-soft); color: var(--text); font-size: 13px; line-height: 1.62; overflow-wrap: anywhere; }
.task-detail-body > :first-child { margin-top: 0; }
.task-detail-body > :last-child { margin-bottom: 0; }
.task-detail-body h1, .task-detail-body h2, .task-detail-body h3, .task-detail-body h4 { margin: 1em 0 .45em; color: var(--text); line-height: 1.25; }
.task-detail-body h1 { font-size: 20px; }
.task-detail-body h2 { font-size: 17px; }
.task-detail-body h3 { font-size: 15px; }
.task-detail-body p { margin: .55em 0; color: var(--text); }
.task-detail-body ul, .task-detail-body ol { margin: .55em 0; padding-left: 22px; color: var(--text); }
.task-detail-body li { margin: .25em 0; }
.task-detail-body code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code-bg); color: var(--code-text); padding: 2px 5px; border-radius: 4px; }
.task-detail-body pre { margin: .7em 0; padding: 11px; border: 1px solid var(--line); border-radius: 7px; background: var(--code-bg); color: var(--code-text); overflow: auto; }
.task-detail-body pre code { background: none; padding: 0; color: inherit; }
.task-detail-body blockquote { margin: .65em 0; padding: 5px 12px; border-left: 3px solid var(--accent); background: var(--accent-soft); border-radius: 0 6px 6px 0; color: var(--muted); }
.task-detail-body table { width: 100%; border-collapse: collapse; margin: .7em 0; }
.task-detail-body th, .task-detail-body td { border: 1px solid var(--line); padding: 6px 8px; text-align: left; color: var(--text); }
.task-detail-body th { background: var(--panel); }
.task-detail-body a { color: var(--accent); text-decoration: none; }
.task-detail-body a:hover { text-decoration: underline; }
.task-detail-edit { display: grid; gap: 12px; }
.task-detail-edit[hidden] { display: none; }
.task-detail-edit .task-field textarea { min-height: min(42vh, 360px); }
.copy-button { border: 1px solid var(--line); background: var(--panel); color: var(--text); border-radius: 7px; height: 30px; padding: 4px 10px; cursor: pointer; font-weight: 650; }
.copy-button:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
.close-button:hover { border-color: var(--rose); color: var(--rose); background: rgba(239, 68, 68, 0.15); }
#graph path { pointer-events: stroke; stroke-linecap: round; stroke-linejoin: round; transition: stroke-width 0.16s, opacity 0.16s; }
#graph path:hover { stroke-width: 3; opacity: 1 !important; }
#graph circle.node { transition: r 0.16s, stroke-width 0.16s; pointer-events: auto; }
#graph circle.node:hover { r: 4.8; stroke-width: 2.4; }
.calendar-grid { --calendar-cell: 10px; --calendar-gap: 3px; --calendar-label-width: 24px; display: grid; grid-template-columns: var(--calendar-label-width) minmax(0, 1fr); grid-template-rows: 13px auto; column-gap: 6px; row-gap: 4px; flex: 0 1 min(674px, 78%); width: min(674px, 78%); justify-content: flex-end; align-items: start; max-width: 100%; min-width: 0; }
.calendar-months { grid-column: 2; grid-row: 1; display: flex; gap: var(--calendar-gap); overflow: visible; min-width: 0; }
.calendar-month { flex: 0 0 var(--calendar-cell); width: var(--calendar-cell); min-width: 0; max-width: var(--calendar-cell); height: 13px; color: var(--muted); font-size: 10px; line-height: 12px; white-space: nowrap; overflow: visible; box-sizing: border-box; }
.calendar-weekdays { grid-column: 1; grid-row: 2; display: flex; flex-direction: column; gap: var(--calendar-gap); }
.calendar-weekday { height: var(--calendar-cell); color: var(--muted); font-size: 10px; line-height: var(--calendar-cell); text-align: right; white-space: nowrap; }
.calendar-weeks { grid-column: 2; grid-row: 2; display: flex; gap: var(--calendar-gap); align-items: flex-start; overflow: visible; min-width: 0; }
.calendar-col { display: flex; flex-direction: column; gap: var(--calendar-gap); flex: 0 0 var(--calendar-cell); width: var(--calendar-cell); min-width: 0; max-width: var(--calendar-cell); box-sizing: border-box; }
.calendar-cell { flex: 0 0 var(--calendar-cell); width: var(--calendar-cell); height: var(--calendar-cell); border-radius: 2px; background: var(--line-soft); }
.calendar-cell.empty { background: transparent; }
.calendar-cell[data-global-level="1"] { background: #dbe2ea; }
.calendar-cell[data-global-level="2"] { background: #cbd5e1; }
.calendar-cell[data-global-level="3"] { background: #94a3b8; }
.calendar-cell[data-global-level="4"] { background: #64748b; }
html[data-theme="dark"] .calendar-cell[data-global-level="1"],
html[data-theme="purple"] .calendar-cell[data-global-level="1"] { background: #334155; }
html[data-theme="dark"] .calendar-cell[data-global-level="2"],
html[data-theme="purple"] .calendar-cell[data-global-level="2"] { background: #475569; }
html[data-theme="dark"] .calendar-cell[data-global-level="3"],
html[data-theme="purple"] .calendar-cell[data-global-level="3"] { background: #64748b; }
html[data-theme="dark"] .calendar-cell[data-global-level="4"],
html[data-theme="purple"] .calendar-cell[data-global-level="4"] { background: #94a3b8; }
html[data-theme="ocean"] .calendar-cell[data-global-level="1"] { background: #cbd5e1; }
html[data-theme="ocean"] .calendar-cell[data-global-level="2"] { background: #94a3b8; }
html[data-theme="ocean"] .calendar-cell[data-global-level="3"] { background: #64748b; }
html[data-theme="ocean"] .calendar-cell[data-global-level="4"] { background: #475569; }
.calendar-cell[data-level="1"] { background: #9be9a8; }
.calendar-cell[data-level="2"] { background: #40c463; }
.calendar-cell[data-level="3"] { background: #30a14e; }
.calendar-cell[data-level="4"] { background: #216e39; }
@keyframes spin { 100% { transform: rotate(360deg); } }
@keyframes aiPulse { 0%, 100% { opacity: .52; transform: scale(.86); } 50% { opacity: 1; transform: scale(1.08); } }
@keyframes taskDotBreathing {
  0%, 100% { transform: scale(.92); box-shadow: 0 0 0 3px color-mix(in srgb, var(--task-color, var(--accent)) 12%, transparent); }
  50% { transform: scale(1.08); box-shadow: 0 0 0 7px color-mix(in srgb, var(--task-color, var(--accent)) 24%, transparent); }
}
@keyframes agentMonitorPausedBreathing {
  0%, 100% {
    background: var(--panel);
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--amber) 5%, transparent);
  }
  50% {
    background: color-mix(in srgb, var(--amber) 48%, var(--panel));
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--amber) 24%, transparent);
  }
}
@media (prefers-reduced-motion: reduce) {
  .ai-status-loader, .ai-status-sparkles, .task-dot.breathing,
  .task-agent-monitor, .task-agent-monitor-state::before,
  .task-speech-button.listening { animation: none; }
}
@media (max-width: 1280px) { 
  .grid, .summary-panel { grid-template-columns: 1fr; } 
  .task-board { grid-template-columns: repeat(2, minmax(240px, 1fr)); }
  .repo-line { max-width: 70vw; } 
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
  .topbar-inner { grid-template-columns: 1fr; align-items: stretch; gap: 10px; min-height: auto; padding: 12px 0; }
  .topbar-brand { width: 100%; }
  .topbar-tools { display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr); gap: 8px; align-items: center; width: 100%; }
  .actions { width: 100%; justify-content: flex-end; gap: 6px; }
  .actions button, .view-tab { min-height: 30px; padding: 5px 9px; }
  .language-menu { right: 0; left: auto; max-width: calc(100vw - 32px); }
  .view-tabs { grid-column: 1; justify-self: start; }
  .topbar-tools .actions { grid-column: 2; justify-self: end; }
  .view-tab { justify-content: center; }
  .task-hero { flex-direction: column; }
  .task-actions { width: 100%; justify-items: start; }
  .task-action-buttons, .task-repo-agent .radio-group { justify-content: flex-start; }
  .task-repo-agent { justify-items: start; }
  .task-form-grid { grid-template-columns: 1fr; }
  .task-speech-meta { align-items: flex-start; flex-direction: column; gap: 4px; }
  .task-speech-hint { display: none; }
  .task-board { grid-template-columns: 1fr; }
  .commit { grid-template-columns: 1fr; } 
  .hash { display: none; } 
  .action-meters { grid-template-columns: 1fr; } 
  .timeline-container { height: 520px; } 
  .branch-summary-panel { flex-direction: column; align-items: stretch; gap: 12px; }
  .branch-summary-text { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .branch-summary-text h2 { flex: 0 0 auto; }
  .branch-name { font-size: 20px; margin: 0; min-width: 0; flex: 0 1 auto; }
  .branch-summary-text .meta { flex: 0 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .calendar-grid { --calendar-cell: 9px; --calendar-gap: 2px; --calendar-label-width: 24px; flex: 0 0 auto; width: 100%; justify-content: flex-start; }
  .file-detail-toolbar { grid-template-columns: 1fr; align-items: stretch; }
  .file-detail-layout { grid-template-columns: 1fr; }
  .file-tree-panel { position: static; max-height: 260px; }
  .repo-entry { grid-template-columns: 22px minmax(0, 1fr); }
  .repo-entry-meta { display: none; }
  .code-view { font-size: 12px; }
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
#addRepoBtn { gap: 2px; font-weight: 800; }
.repo-add-plus { font-size: 19px; line-height: 1; }
#sidebarToggle { margin-left: -12px; margin-right: 8px; }
#sidebarClose { margin-right: -8px; display: none; }

.qa-btn { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; width: 62px; height: 56px; padding: 6px 3px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--muted); cursor: pointer; transition: color .16s, background .16s, border-color .16s, transform .16s, box-shadow .16s; box-shadow: 0 1px 2px rgba(15,23,42,.03); }
.qa-btn:hover { color: var(--accent); background: var(--accent-soft); border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 8px 22px rgba(6,141,109,.12); }
.qa-btn:active { transform: translateY(0); }
.qa-btn svg, .qa-icon { width: 20px; height: 20px; flex-shrink: 0; pointer-events: none; }
.qa-icon { display: block; object-fit: contain; }
.qa-btn span { font-size: 9px; font-weight: 650; line-height: 1.1; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.qa-ide-btn:hover { color: #7c3aed; border-color: #7c3aed; background: #f5f3ff; }

/* Close Repository Button in Topbar (matches repo-remove style) */
.topbar-close-btn, .close-repo-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border-radius: 7px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--muted);
  cursor: pointer;
  opacity: 1;
  transition: color .15s, background .15s, border-color .15s, transform .15s;
  flex: 0 0 auto;
}
.topbar-close-btn:hover, .close-repo-button:hover {
  color: var(--rose);
  background: rgba(248, 113, 113, 0.15);
  border-color: var(--rose);
  transform: scale(1.06);
}
.topbar-close-btn svg, .close-repo-button svg {
  width: 14px;
  height: 14px;
  pointer-events: none;
}
.topbar-close-btn[hidden], .close-repo-button[hidden] {
  display: none !important;
}

/* Home Overview Page */
.home-page {
  display: flex;
  flex-direction: column;
  gap: 22px;
  padding-bottom: 40px;
  animation: fadeIn .22s ease-out;
}
.home-page[hidden] { display: none !important; }

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

.home-hero {
  position: relative;
  padding: 22px 26px;
  background: var(--hero-bg);
  border: 1px solid var(--line);
  border-radius: 16px;
  box-shadow: var(--shadow);
  overflow: hidden;
}
.home-hero-glow {
  position: absolute;
  top: -40px;
  right: -40px;
  width: 260px;
  height: 260px;
  background: radial-gradient(circle, var(--accent) 0%, transparent 70%);
  opacity: 0.15;
  pointer-events: none;
  filter: blur(40px);
}
.home-hero-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 24px;
  align-items: center;
}
@media (max-width: 1080px) {
  .home-hero-layout {
    grid-template-columns: 1fr;
    gap: 18px;
  }
}
.home-hero-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.home-hero-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 3px 10px;
  border-radius: 20px;
  background: var(--accent-soft);
  border: 1px solid var(--accent);
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .5px;
  text-transform: uppercase;
  margin-bottom: 6px;
  align-self: flex-start;
}
.pulse-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
  animation: pulseGlow 2s infinite;
}
@keyframes pulseGlow {
  0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
  70% { transform: scale(1); box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); }
  100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
}
.home-hero-title {
  margin: 0 0 14px;
  font-size: 21px;
  font-weight: 750;
  letter-spacing: -0.4px;
  color: var(--text);
  line-height: 1.2;
}
.home-meta-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: auto auto;
  gap: 8px 12px;
}
.home-meta-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  background: var(--panel-soft);
  border: 1px solid var(--line-soft);
  border-radius: 9px;
  min-width: 0;
  transition: border-color .15s;
}
.home-meta-item:hover {
  border-color: var(--line);
}
.home-meta-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: var(--panel);
  border: 1px solid var(--line-soft);
  color: var(--accent);
  flex-shrink: 0;
}
.home-meta-icon svg {
  width: 14px;
  height: 14px;
  min-width: 14px;
  min-height: 14px;
  max-width: 14px;
  max-height: 14px;
}
.home-meta-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}
.home-meta-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: .3px;
  line-height: 1.1;
}
.home-meta-val {
  font-size: 12px;
  font-weight: 650;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 1px;
  line-height: 1.2;
}

/* Right Column: Calendar Card */
.home-hero-calendar-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  width: 100%;
  background: var(--panel-soft);
  border: 1px solid var(--line-soft);
  border-radius: 12px;
  padding: 10px 14px 8px;
  backdrop-filter: blur(10px);
}
.home-hero-cal-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 6px;
  flex-wrap: wrap;
}
.home-hero-cal-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
  color: var(--text);
}
.home-hero-cal-title svg {
  width: 14px;
  height: 14px;
  min-width: 14px;
  min-height: 14px;
  color: var(--accent);
  flex-shrink: 0;
}
.home-calendar-wrap {
  overflow-x: auto;
  padding: 2px 0;
  width: 100%;
}
.home-calendar-grid {
  --calendar-cell: 10px;
  --calendar-gap: 3px;
  --calendar-label-width: 22px;
  width: 100% !important;
  max-width: 100% !important;
  justify-content: flex-start !important;
}
.home-calendar-meta {
  display: flex;
  gap: 10px;
  font-size: 11px;
  color: var(--muted);
}
.home-calendar-meta strong {
  color: var(--text);
}

/* Home Page Sections */
.home-section {
  padding: 22px 26px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 16px;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.03);
}
.home-section-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 16px;
}
.home-section-title-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
}
.home-section-icon {
  width: 20px;
  height: 20px;
  min-width: 20px;
  min-height: 20px;
  max-width: 20px;
  max-height: 20px;
  color: var(--accent);
  flex-shrink: 0;
}
.home-section-head h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--text);
}
.home-section-desc {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--muted);
}
.home-calendar-wrap {
  overflow-x: auto;
  padding: 10px 0 4px;
}
.home-calendar-grid {
  width: 100% !important;
  max-width: 100% !important;
  flex: 1 1 100% !important;
  justify-content: flex-start !important;
}
.home-calendar-meta {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: var(--muted);
}
.home-calendar-meta strong {
  color: var(--text);
}

/* Home Needs Attention Matrix Section */
.home-matrix-header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.home-matrix-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 700;
  background: rgba(245, 158, 11, 0.14);
  color: var(--amber);
  border: 1px solid rgba(245, 158, 11, 0.35);
}
.home-matrix-refresh-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: var(--panel-soft);
  color: var(--text);
  border: 1px solid var(--line-soft);
  border-radius: 8px;
  padding: 6px 11px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background .15s, border-color .15s, color .15s;
}
.home-matrix-refresh-btn:hover {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}
.home-matrix-refresh-btn.spinning svg {
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  100% { transform: rotate(360deg); }
}
.home-repo-matrix-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
  margin-top: 4px;
}
.home-matrix-card {
  background: var(--panel-soft);
  border: 1px solid var(--line-soft);
  border-radius: 12px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: transform .18s, border-color .18s, box-shadow .18s;
  cursor: pointer;
  position: relative;
}
.home-matrix-card:hover {
  transform: translateY(-2px);
  border-color: var(--accent);
  box-shadow: 0 10px 25px rgba(15, 23, 42, .08);
}
.home-matrix-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.home-matrix-card-title {
  font-size: 14.5px;
  font-weight: 750;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.home-matrix-card-title svg {
  color: var(--accent);
  flex-shrink: 0;
}
.home-matrix-card-title span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.home-matrix-card-path {
  font-size: 11px;
  color: var(--muted);
  font-family: ui-monospace, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.85;
}
.home-matrix-stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  background: var(--panel);
  padding: 10px;
  border-radius: 8px;
  border: 1px solid var(--line-soft);
}
.home-matrix-stat-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
  font-weight: 500;
  font-family: ui-monospace, monospace;
}
.home-matrix-stat-item.active-amber {
  color: var(--amber);
  font-weight: 700;
}
.home-matrix-stat-item.active-emerald {
  color: var(--emerald);
  font-weight: 700;
}
.home-matrix-stat-item.active-blue {
  color: var(--accent);
  font-weight: 700;
}
.home-matrix-stat-item.active-purple {
  color: var(--purple);
  font-weight: 700;
}
.home-matrix-card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: auto;
  padding-top: 4px;
}
.home-matrix-time {
  font-size: 11px;
  color: var(--muted);
}
.home-matrix-open-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  font-weight: 650;
  color: var(--accent);
  background: transparent;
  border: none;
  padding: 4px 6px;
  border-radius: 6px;
  cursor: pointer;
  transition: background .15s;
}
.home-matrix-card:hover .home-matrix-open-btn {
  background: var(--accent-soft);
}

/* Developer Tools Grid */
.home-tools-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 14px;
}
.home-tool-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 18px 14px 14px;
  background: var(--panel-soft);
  border: 1px solid var(--line-soft);
  border-radius: 14px;
  transition: transform .18s, border-color .18s, box-shadow .18s, background .18s;
}
.home-tool-card:hover {
  transform: translateY(-2px);
  border-color: var(--line);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.06);
  background: var(--panel);
}
.home-tool-icon-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 46px;
  border-radius: 12px;
  background: var(--panel);
  border: 1px solid var(--line-soft);
  margin-bottom: 10px;
  transition: transform .18s;
}
.home-tool-card:hover .home-tool-icon-wrap {
  transform: scale(1.08);
}
.home-tool-icon {
  width: 26px;
  height: 26px;
  object-fit: contain;
}
.home-tool-name {
  font-size: 13px;
  font-weight: 650;
  color: var(--text);
  margin-bottom: 2px;
}
.home-tool-desc {
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 12px;
  min-height: 16px;
}
.home-tool-launch-btn {
  width: 100%;
  height: 30px;
  border-radius: 7px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  transition: background .15s, border-color .15s, color .15s;
}
.home-tool-launch-btn svg {
  width: 12px;
  height: 12px;
}
.home-tool-launch-btn:hover {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.home-tool-launch-btn.working {
  opacity: 0.7;
  pointer-events: none;
}
.home-tool-launch-btn.success {
  background: var(--green) !important;
  border-color: var(--green) !important;
  color: #fff !important;
}

/* Global Config Form & Table */
.home-config-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.home-config-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 14px;
}
.home-config-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.home-config-field label {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
}
.home-config-input, .home-config-select {
  height: 36px;
  padding: 0 12px;
  background: var(--input-bg);
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--text);
  font-size: 13px;
  outline: none;
  font-family: inherit;
  transition: border-color .15s, box-shadow .15s;
}
.home-config-input:focus, .home-config-select:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.home-config-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
}
.home-status-pill {
  font-size: 12px;
  font-weight: 600;
  color: var(--green);
  min-height: 18px;
}
.home-all-configs-details {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--line-soft);
}
.home-all-configs-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  font-weight: 650;
  color: var(--muted);
  cursor: pointer;
  user-select: none;
}
.home-all-configs-summary:hover {
  color: var(--text);
}
.home-all-configs-summary .chevron {
  width: 16px;
  height: 16px;
  min-width: 16px;
  min-height: 16px;
  max-width: 16px;
  max-height: 16px;
  color: var(--muted);
  flex-shrink: 0;
  transition: transform .16s;
}
details[open] > .home-all-configs-summary .chevron {
  transform: rotate(180deg);
}
.home-all-configs-body {
  margin-top: 14px;
}
.home-configs-table {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 280px;
  overflow-y: auto;
  margin-bottom: 14px;
}
.home-config-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 12px;
  background: var(--panel-soft);
  border: 1px solid var(--line-soft);
  border-radius: 7px;
  font-size: 12px;
}
.home-config-row-key {
  font-family: ui-monospace, monospace;
  font-weight: 600;
  color: var(--accent);
  flex-shrink: 0;
}
.home-config-row-val {
  font-family: ui-monospace, monospace;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-grow: 1;
  text-align: right;
}
.home-config-del-btn {
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 12px;
  transition: color .15s, background .15s;
}
.home-config-del-btn:hover {
  color: var(--rose);
  background: var(--diff-del-bg);
}
.home-add-config-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.home-add-config-row input {
  flex: 1;
  height: 32px;
  font-size: 12px;
}
.home-add-config-row button {
  height: 32px;
  padding: 0 14px;
  font-size: 12px;
  flex-shrink: 0;
}

/* 3D City Background Scene */
.city-3d-container {
  position: fixed;
  top: 0;
  left: var(--sidebar-w);
  right: 0;
  bottom: 0;
  z-index: 1;
  overflow: hidden;
  pointer-events: auto;
  transition: left 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity .35s ease;
}
.sidebar.collapsed ~ .city-3d-container,
body.sidebar-collapsed .city-3d-container {
  left: 0;
}
@media (max-width: 960px) {
  .city-3d-container {
    left: 0;
  }
}
.city-3d-canvas {
  width: 100%;
  height: 100%;
  display: block;
  cursor: grab;
  outline: none;
}
.city-3d-canvas:active {
  cursor: grabbing;
}
.city-3d-hud {
  pointer-events: none;
}
.city-3d-hud-left {
  position: fixed;
  top: 76px;
  left: calc(var(--sidebar-w) + 24px);
  display: flex;
  align-items: center;
  gap: 10px;
  z-index: 100;
  pointer-events: auto;
  transition: left 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}
.sidebar.collapsed + .shell .city-3d-hud-left,
body.sidebar-collapsed .city-3d-hud-left {
  left: 24px;
}
@media (max-width: 960px) {
  .city-3d-hud-left {
    left: 24px;
  }
}
.city-3d-hud-right {
  position: fixed;
  top: 76px;
  right: 24px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  z-index: 100;
  pointer-events: auto;
}
@media (max-width: 960px) {
  .city-3d-hud-right {
    right: 14px;
  }
}
.city-3d-status-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  background: var(--topbar-bg);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  border: 1px solid var(--line);
  border-radius: 20px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.city-3d-pulse-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 10px var(--green);
  animation: pulseDot 2s infinite ease-in-out;
}
.city-3d-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 16px;
  background: var(--topbar-bg);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  border: 1px solid var(--line);
  border-radius: 18px;
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  transition: all .18s ease;
  white-space: nowrap;
}
.city-3d-btn:hover {
  background: var(--panel-soft);
  border-color: var(--accent);
  color: var(--accent);
  transform: translateX(-4px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
}
.city-3d-btn-highlight {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}
.city-3d-btn-highlight:hover {
  background: var(--accent);
  color: #ffffff;
}
.city-3d-repo-card {
  position: fixed;
  bottom: 24px;
  right: 24px;
  width: 300px;
  background: var(--topbar-bg);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid var(--line);
  border-radius: 16px;
  box-shadow: var(--shadow);
  padding: 16px 18px;
  pointer-events: auto;
  z-index: 120;
  animation: slideUp .2s ease-out;
}
.city-3d-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line-soft);
}
.city-3d-card-title-wrap {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--accent);
  min-width: 0;
}
.city-3d-card-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 210px;
}
.city-3d-card-close {
  background: none;
  border: none;
  font-size: 18px;
  line-height: 1;
  color: var(--muted);
  cursor: pointer;
  padding: 0 4px;
}
.city-3d-card-close:hover {
  color: var(--text);
}
.city-3d-card-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
}
.city-3d-card-stat {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
}
.city-3d-card-label {
  color: var(--muted);
}
.city-3d-card-val {
  font-weight: 600;
  color: var(--text);
}
.city-3d-enter-btn {
  width: 100%;
  height: 34px;
  background: var(--accent);
  color: #ffffff;
  border: none;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: opacity .15s ease, transform .15s ease;
}
.city-3d-enter-btn:hover {
  opacity: 0.92;
  transform: translateY(-1px);
}
.home-page {
  position: relative;
  z-index: 5;
  margin-top: 400px;
  transition: opacity .3s ease, transform .3s ease;
}
.home-page.zen-mode {
  opacity: 0 !important;
  pointer-events: none !important;
  transform: scale(0.98);
}
.city-3d-container.zen-mode {
  pointer-events: auto;
}
.home-hero {
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
}
.home-section {
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}
</style>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
</head>
<body>
<div class="app-container">
  <aside id="sidebar" class="sidebar">
    <div class="sidebar-header">
      <h2 data-i18n="recentRepos">Recent Repos</h2>
      <div style="display:flex;gap:6px;align-items:center;">
        <button id="addRepoBtn" class="sidebar-toggle" type="button" title="Add or Create Git Repository" aria-label="Add or Create Git Repository" style="display:none;">
          <svg width="800px" height="800px" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMinYMin meet"><path d="M251.172 116.594L139.4 4.828c-6.433-6.437-16.873-6.437-23.314 0l-23.21 23.21 29.443 29.443c6.842-2.312 14.688-.761 20.142 4.693 5.48 5.489 7.02 13.402 4.652 20.266l28.375 28.376c6.865-2.365 14.786-.835 20.269 4.657 7.663 7.66 7.663 20.075 0 27.74-7.665 7.666-20.08 7.666-27.749 0-5.764-5.77-7.188-14.235-4.27-21.336l-26.462-26.462-.003 69.637a19.82 19.82 0 0 1 5.188 3.71c7.663 7.66 7.663 20.076 0 27.747-7.665 7.662-20.086 7.662-27.74 0-7.663-7.671-7.663-20.086 0-27.746a19.654 19.654 0 0 1 6.421-4.281V94.196a19.378 19.378 0 0 1-6.421-4.281c-5.806-5.798-7.202-14.317-4.227-21.446L81.47 39.442l-76.64 76.635c-6.44 6.443-6.44 16.884 0 23.322l111.774 111.768c6.435 6.438 16.873 6.438 23.316 0l111.251-111.249c6.438-6.44 6.438-16.887 0-23.324" fill="#DE4C36"/></svg>
          <span class="repo-add-plus" aria-hidden="true">+</span>
        </button>
        <button id="sidebarClose" class="sidebar-toggle" title="Close Sidebar" data-i18n-title="closeSidebar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
    </div>
    <div id="repoList" class="repo-list"></div>
  </aside>

  <div id="city3dContainer" class="city-3d-container">
    <canvas id="city3dCanvas" class="city-3d-canvas"></canvas>
    <div class="city-3d-hud">
      <div class="city-3d-hud-left">
        <div class="city-3d-status-pill">
          <span class="city-3d-pulse-dot"></span>
          <span id="city3dCurrentRepoBadge" class="city-3d-repo-badge">City 3D Tour</span>
        </div>
      </div>
      <div class="city-3d-hud-right">
        <button id="city3dFlightBtn" class="city-3d-btn" type="button" title="暂停/继续巡航" data-i18n-title="city3dCruise">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
          <span id="city3dFlightText">巡航中</span>
        </button>
        <button id="city3dDayNightBtn" class="city-3d-btn" type="button" title="昼夜切换" data-i18n-title="city3dDay">
          <span id="city3dDayNightIcon">☀️</span>
          <span id="city3dDayNightText">白天</span>
        </button>
        <button id="city3dWeatherBtn" class="city-3d-btn" type="button" title="天气切换 (晴空 / 赛博雨夜)" data-i18n-title="city3dWeather">
          <span id="city3dWeatherIcon">🌧️</span>
          <span id="city3dWeatherText">雨夜</span>
        </button>
        <button id="city3dZenBtn" class="city-3d-btn city-3d-btn-highlight" type="button" title="全屏沉浸/显示概览" data-i18n-title="city3dZenMode">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>
          <span id="city3dZenText">全景沉浸</span>
        </button>
      </div>
    </div>
    <div id="city3dRepoCard" class="city-3d-repo-card" hidden>
      <div class="city-3d-card-header">
        <div class="city-3d-card-title-wrap">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
          <span id="city3dCardRepoName" class="city-3d-card-title">repo</span>
        </div>
        <button id="city3dCardCloseBtn" class="city-3d-card-close" type="button">×</button>
      </div>
      <div class="city-3d-card-body">
        <div class="city-3d-card-stat">
          <span class="city-3d-card-label" data-i18n="city3dBuildings">建筑数量 (文本文件)</span>
          <span id="city3dCardBuildings" class="city-3d-card-val">-</span>
        </div>
        <div class="city-3d-card-stat">
          <span class="city-3d-card-label" data-i18n="city3dGreenSpace">绿化区域 (非文本文件)</span>
          <span id="city3dCardGreens" class="city-3d-card-val">-</span>
        </div>
        <div class="city-3d-card-stat">
          <span class="city-3d-card-label" data-i18n="city3dTallest">最高建筑 (最大文件)</span>
          <span id="city3dCardTallest" class="city-3d-card-val">-</span>
        </div>
      </div>
      <div class="city-3d-card-foot">
        <button id="city3dCardEnterBtn" class="city-3d-enter-btn" type="button">
          <span data-i18n="city3dEnterRepo">进入此仓库</span> →
        </button>
      </div>
    </div>
  </div>

  <main class="shell">
    <header class="topbar">
      <div class="topbar-inner">
        <div class="topbar-brand">
          <button id="sidebarToggle" class="sidebar-toggle" title="Toggle Sidebar" data-i18n-title="toggleSidebar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg>
          </button>
          <div>
            <h1 id="appTitle">GMC GitWeb</h1>
            <div class="repo-line">
              <a id="repo" class="repo" data-i18n="loading">Loading...</a>
            </div>

          </div>
        </div>
        <div class="topbar-tools">
          <nav class="view-tabs" aria-label="GMC views" hidden>
            <button id="gitViewTab" class="view-tab active" type="button" data-view-tab="git">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="18" r="3"></circle><circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M8.6 7.8 15.4 16.2"></path><path d="M6 9v6"></path></svg>
              <span data-i18n="gitView">Git</span>
              <span id="gitTabBadge" class="tab-badge tab-badge-git" style="display:none;">0</span>
            </button>
            <button id="taskViewTab" class="view-tab" type="button" data-view-tab="tasks">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M7 8h10"></path><path d="M7 12h5"></path><path d="m14 16 1.5 1.5L18 15"></path></svg>
              <span data-i18n="taskView">Task</span>
              <span id="taskTabBadge" class="tab-badge tab-badge-task" style="display:none;">0</span>
            </button>
          </nav>
          <div class="actions">
            <button id="openSettings" class="settings-button" type="button" title="打开设置" data-i18n-title="settings" data-i18n-aria-label="settings">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.08a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.08a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.08a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.18.63.77 1 1.43 1H21a2 2 0 1 1 0 4h-.08a1.7 1.7 0 0 0-1.52 1Z"></path></svg>
              <span data-i18n="settings">设置</span>
            </button>
            <div class="language-wrap">
              <button id="openLanguageMenu" class="language-button" type="button" title="Language" data-i18n-title="language">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M2 12h20"></path><path d="M12 2a15.3 15.3 0 0 1 0 20"></path><path d="M12 2a15.3 15.3 0 0 0 0 20"></path></svg>
                <span id="languageButtonLabel">中文</span>
              </button>
              <div id="languageMenu" class="language-menu" role="menu">
                <button type="button" data-lang-option="zh-CN">中文</button>
                <button type="button" data-lang-option="en">English</button>
                <button type="button" data-lang-option="ja">日本語</button>
                <button type="button" data-lang-option="ko">한국어</button>
                <button type="button" data-lang-option="es">Español</button>
                <button type="button" data-lang-option="fr">Français</button>
              </div>
            </div>
            <button id="closeRepoBtn" class="topbar-close-btn" type="button" title="退出仓库回到主页" data-i18n-title="closeRepoTitle" aria-label="Close Repository" hidden>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </header>
    <div class="shell-inner">
      <div id="homePage" class="home-page" hidden>
        <div class="home-hero">
          <div class="home-hero-glow" aria-hidden="true"></div>
          <div class="home-hero-content">
            <div class="home-hero-layout">
              <div class="home-hero-info">
                <div class="home-hero-badge">
                  <span class="pulse-dot" aria-hidden="true"></span>
                  <span data-i18n="homeBadge">Git System Hub</span>
                </div>
                <h2 class="home-hero-title" data-i18n="homeHeroTitle">全局 Git 概览与工作台</h2>

                <div class="home-meta-grid">
                  <div class="home-meta-item">
                    <span class="home-meta-icon">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2"></path></svg>
                    </span>
                    <div class="home-meta-text">
                      <span class="home-meta-label" data-i18n="gitVersion">Git 版本</span>
                      <span id="homeGitVersion" class="home-meta-val">Loading...</span>
                    </div>
                  </div>

                  <div class="home-meta-item">
                    <span class="home-meta-icon">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                    </span>
                    <div class="home-meta-text">
                      <span class="home-meta-label" data-i18n="gitPath">Git 路径</span>
                      <span id="homeGitPath" class="home-meta-val" title="...">Loading...</span>
                    </div>
                  </div>

                  <div class="home-meta-item">
                    <span class="home-meta-icon">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
                    </span>
                    <div class="home-meta-text">
                      <span class="home-meta-label" data-i18n="globalIdentity">全局身份</span>
                      <span id="homeGlobalIdentity" class="home-meta-val">-</span>
                    </div>
                  </div>

                  <div class="home-meta-item">
                    <span class="home-meta-icon">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M3 9h18"></path><path d="M9 21V9"></path></svg>
                    </span>
                    <div class="home-meta-text">
                      <span class="home-meta-label" data-i18n="trackedRepos">已追踪仓库</span>
                      <span id="homeTrackedCount" class="home-meta-val">0</span>
                    </div>
                  </div>
                </div>
              </div>

              <div class="home-hero-calendar-card">
                <div class="home-hero-cal-head">
                  <div class="home-hero-cal-title">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
                    <span data-i18n="globalCalendar">全局提交贡献日历</span>
                  </div>
                  <div id="homeCalendarMeta" class="home-calendar-meta"></div>
                </div>
                <div class="home-calendar-wrap">
                  <div id="homeCalendar" class="calendar-grid home-calendar-grid"></div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Needs Attention / Repo Health Board Section -->
        <section id="homeRepoMatrixSection" class="home-section" style="margin-bottom:24px;" hidden>
          <div class="home-section-head">
            <div class="home-section-title-wrap">
              <svg class="home-section-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--amber);"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
              <div>
                <div style="display:flex;align-items:center;gap:8px;">
                  <h3 data-i18n="needsAttentionTitle">待处理与变动仓库</h3>
                  <span id="homeRepoMatrixBadge" class="home-matrix-badge"></span>
                </div>
                <p class="home-section-desc" data-i18n="needsAttentionDesc">包含未暂存代码、待提交修改或未与远程分支同步的本地项目</p>
              </div>
            </div>
            <div class="home-matrix-header-actions">
              <button id="btnRefreshRepoMatrix" class="home-matrix-refresh-btn" type="button" title="刷新所有仓库状态">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path></svg>
                <span data-i18n="refreshStatus">刷新状态</span>
              </button>
            </div>
          </div>
          <div id="homeRepoMatrixGrid" class="home-repo-matrix-grid"></div>
        </section>

        <!-- Developer Tools Section -->
        <section class="home-section">
          <div class="home-section-head">
            <div class="home-section-title-wrap">
              <svg class="home-section-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>
              <div>
                <h3 data-i18n="devTools">常用开发工具</h3>
                <p class="home-section-desc" data-i18n="devToolsDesc">一键启动本地安装的常用开发环境与编辑器</p>
              </div>
            </div>
          </div>
          <div class="home-tools-grid">
            <div class="home-tool-card" data-tool="vscode">
              <div class="home-tool-icon-wrap">
                <img class="home-tool-icon" src="/icons/vscode.svg" alt="VS Code">
              </div>
              <div class="home-tool-name">VS Code</div>
              <div class="home-tool-desc">Visual Studio Code</div>
              <button class="home-tool-launch-btn" type="button" data-launch-app="vscode">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                <span data-i18n="launchApp">启动</span>
              </button>
            </div>

            <div class="home-tool-card" data-tool="xcode">
              <div class="home-tool-icon-wrap">
                <img class="home-tool-icon" src="/icons/xcode.svg" alt="Xcode">
              </div>
              <div class="home-tool-name">Xcode</div>
              <div class="home-tool-desc">Apple Developer IDE</div>
              <button class="home-tool-launch-btn" type="button" data-launch-app="xcode">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                <span data-i18n="launchApp">启动</span>
              </button>
            </div>

            <div class="home-tool-card" data-tool="android-studio">
              <div class="home-tool-icon-wrap">
                <img class="home-tool-icon" src="/icons/android-studio.svg" alt="Android Studio">
              </div>
              <div class="home-tool-name">Android Studio</div>
              <div class="home-tool-desc">Google Android IDE</div>
              <button class="home-tool-launch-btn" type="button" data-launch-app="android-studio">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                <span data-i18n="launchApp">启动</span>
              </button>
            </div>

            <div class="home-tool-card" data-tool="sublime">
              <div class="home-tool-icon-wrap">
                <img class="home-tool-icon" src="/icons/sublime.svg" alt="Sublime Text">
              </div>
              <div class="home-tool-name">Sublime Text</div>
              <div class="home-tool-desc">Text &amp; Code Editor</div>
              <button class="home-tool-launch-btn" type="button" data-launch-app="sublime">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                <span data-i18n="launchApp">启动</span>
              </button>
            </div>

            <div class="home-tool-card" data-tool="cursor">
              <div class="home-tool-icon-wrap">
                <img class="home-tool-icon" src="/icons/cursor.svg" alt="Cursor">
              </div>
              <div class="home-tool-name">Cursor</div>
              <div class="home-tool-desc">AI Code Editor</div>
              <button class="home-tool-launch-btn" type="button" data-launch-app="cursor">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                <span data-i18n="launchApp">启动</span>
              </button>
            </div>

            <div class="home-tool-card" data-tool="terminal">
              <div class="home-tool-icon-wrap">
                <img class="home-tool-icon" src="/icons/terminal.svg" alt="Terminal">
              </div>
              <div class="home-tool-name">Terminal</div>
              <div class="home-tool-desc">Command Line</div>
              <button class="home-tool-launch-btn" type="button" data-launch-app="terminal">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                <span data-i18n="launchApp">启动</span>
              </button>
            </div>
          </div>
        </section>

        <!-- Git Global Configuration Section -->
        <section class="home-section">
          <div class="home-section-head">
            <div class="home-section-title-wrap">
              <svg class="home-section-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>
              <div>
                <h3 data-i18n="gitSystemInfo">全局 Git 配置管理</h3>
                <p class="home-section-desc" data-i18n="gitSystemInfoDesc">查看与修改 ~/.gitconfig 中的系统全局配置</p>
              </div>
            </div>
          </div>
          <div class="home-config-card">
            <form id="globalConfigForm" class="home-config-form">
              <div class="home-config-grid">
                <div class="home-config-field">
                  <label for="cfgUserName" data-i18n="userName">用户名 (user.name)</label>
                  <input type="text" id="cfgUserName" class="home-config-input" placeholder="例如：John Doe">
                </div>
                <div class="home-config-field">
                  <label for="cfgUserEmail" data-i18n="userEmail">邮箱 (user.email)</label>
                  <input type="email" id="cfgUserEmail" class="home-config-input" placeholder="例如：john@example.com">
                </div>
                <div class="home-config-field">
                  <label for="cfgCoreEditor" data-i18n="coreEditor">默认编辑器 (core.editor)</label>
                  <input type="text" id="cfgCoreEditor" class="home-config-input" placeholder="例如：code --wait, vim">
                </div>
                <div class="home-config-field">
                  <label for="cfgDefaultBranch" data-i18n="defaultBranch">新建分支默认名 (init.defaultBranch)</label>
                  <input type="text" id="cfgDefaultBranch" class="home-config-input" placeholder="例如：main">
                </div>
                <div class="home-config-field">
                  <label for="cfgPullRebase" data-i18n="pullRebase">Pull 策略 (pull.rebase)</label>
                  <select id="cfgPullRebase" class="home-config-select">
                    <option value="">默认 (false)</option>
                    <option value="true">true (Rebase)</option>
                    <option value="false">false (Merge)</option>
                    <option value="merges">merges</option>
                  </select>
                </div>
              </div>
              <div class="home-config-actions">
                <button id="btnSaveConfig" class="commit-button" type="submit">
                  <span data-i18n="saveConfig">保存全局配置</span>
                </button>
                <span id="configSaveStatus" class="home-status-pill"></span>
              </div>
            </form>

            <details class="home-all-configs-details">
              <summary class="home-all-configs-summary">
                <span data-i18n="allGlobalConfigs">所有全局配置项 (全量列表)</span>
                <svg class="chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"></path></svg>
              </summary>
              <div class="home-all-configs-body">
                <div id="homeAllConfigsTable" class="home-configs-table"></div>
                <div class="home-add-config-row">
                  <input type="text" id="newConfigKey" class="home-config-input" placeholder="配置键名 (如 core.autocrlf)">
                  <input type="text" id="newConfigVal" class="home-config-input" placeholder="配置值 (如 input)">
                  <button id="btnAddConfigKey" class="copy-button" type="button" data-i18n="addConfigKey">+ 添加</button>
                </div>
              </div>
            </details>
          </div>
        </section>
      </div>

      <div id="gitPage" class="view-page">
        <div id="installBanner" class="install-banner">
          <span class="install-text" data-i18n="installBanner"> ⚠️ GMC Hooks is not installed - Installing git hooks can automatically generate commit messages. Git commit is available anywhere.</span>
          <button id="btnInstall" type="button" data-i18n="installHooks">Install Hooks</button>
        </div>
        <div id="dashboardPage">
  <section class="summary-panel">
    <div class="panel branch-summary-panel">
      <div class="branch-summary-text">
        <h2 data-i18n="currentBranch">Current Branch</h2>
        <div class="branch-selector-wrap branch-selector-wrap-inline">
          <button id="branch" class="branch-selector-button" type="button" aria-haspopup="true" aria-expanded="false">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="3" x2="6" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg>
            <span id="branchText">...</span>
            <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>
          </button>
          <div id="branchMenu" class="branch-selector-menu" role="menu"></div>
        </div>
        <div id="upstream" class="meta"></div>
      </div>
      <div id="calendar" class="calendar-grid"></div>
    </div>
    <div class="panel action-panel">
      <div class="action-meters">
        <div class="action-meter"><strong id="ahead">0</strong><span data-i18n="ahead">ahead</span> <button id="btnPush" class="action-btn" style="display:none" data-i18n="push">Push</button></div>
        <div class="action-meter"><strong id="behind">0</strong><span data-i18n="behind">behind</span> <button id="btnPull" class="action-btn" data-i18n="pull">Pull</button></div>
        <div class="action-meter"><strong id="dirty">0</strong><span data-i18n="changedFiles">changed files</span></div>
      </div>
      <div id="quickActions" class="action-buttons" hidden>
        <button id="qaTerminal" class="qa-btn" type="button" data-agent="terminal" title="在终端中打开">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>
          <span>Terminal</span>
        </button>
        <button class="qa-btn" type="button" data-agent="opencode" title="OpenCode">
          <img class="qa-icon" src="/icons/opencode.svg" alt="" width="20" height="20">
          <span>OpenCode</span>
        </button>
        <button class="qa-btn" type="button" data-agent="claude" title="Claude Code">
          <img class="qa-icon" src="/icons/claude.svg" alt="" width="20" height="20">
          <span>Claude</span>
        </button>
        <button class="qa-btn" type="button" data-agent="codex" title="Codex CLI">
          <img class="qa-icon" src="/icons/codex.svg" alt="" width="20" height="20">
          <span>Codex</span>
        </button>
        <button class="qa-btn" type="button" data-agent="antigravity" title="Antigravity CLI">
          <img class="qa-icon" src="/icons/antigravity.svg" alt="" width="20" height="20">
          <span>Antigravity</span>
        </button>
        <button id="qaOpenIde" class="qa-btn qa-ide-btn" type="button" data-agent="open-ide" title="在 IDE 中打开项目" hidden>
          <img id="qaIdeIcon" class="qa-icon" src="/icons/vscode.svg" alt="" width="20" height="20">
          <span id="qaIdeLabel">VS Code</span>
        </button>
      </div>
    </div>
  </section>

  <section class="grid">
    <aside class="side">
      <div class="panel">
        <div class="panel-head">
          <h2 data-i18n="workingTree">Working Tree</h2>
          <div id="selectedCount" class="meta">0 selected</div>
        </div>
        <div id="files"></div>
      </div>
      <div class="panel">
        <div class="panel-head">
          <h2 data-i18n="repositoryFiles">Repository Files</h2>
          <div id="repoBrowserMeta" class="meta"></div>
        </div>
        <nav id="repoBreadcrumb" class="repo-breadcrumb" aria-label="Repository path"></nav>
        <div id="repoBrowser" class="repo-browser"></div>
        <div id="repoBrowserStatus" class="repo-browser-status"></div>
      </div>
      <div class="panel readme-panel">
        <div class="panel-head">
          <h2>README</h2>
        </div>
        <a id="readmeLink" class="readme-link" href="#" data-i18n="openReadme">Open README</a>
      </div>
    </aside>
    <div class="panel">
      <div class="panel-head">
        <h2 data-i18n="commitGraph">Commit Graph</h2>
        <div class="meta" data-i18n="recentHistory">Recent repository history</div>
      </div>
      <div class="timeline-container">
        <svg id="graph"></svg>
        <div id="commits" class="timeline"></div>
      </div>
    </div>
  </section>
        </div>
        <section id="fileDetailPage" class="file-detail-page" hidden>
          <div class="file-detail-toolbar">
            <button id="backToDashboard" class="copy-button" type="button">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg>
              <span data-i18n="back">Back</span>
            </button>
            <div class="branch-selector-wrap">
              <button id="detailBranchButton" class="branch-selector-button" type="button" aria-haspopup="true" aria-expanded="false">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="3" x2="6" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg>
                <span id="detailBranchButtonText">...</span>
                <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>
              </button>
              <div id="detailBranchMenu" class="branch-selector-menu" role="menu"></div>
            </div>
            <nav id="fileDetailBreadcrumb" class="repo-breadcrumb" aria-label="Repository file path"></nav>
          </div>
          <div class="file-detail-layout">
            <aside class="file-tree-panel">
              <div class="panel-head">
                <h2 data-i18n="fileTree">File Tree</h2>
              </div>
              <div id="fileTree" class="file-tree"></div>
            </aside>
            <section class="file-view-panel">
              <div class="file-view-head">
                <div>
                  <h2 id="fileViewTitle" class="file-view-title">...</h2>
                  <div id="fileViewMeta" class="meta"></div>
                </div>
              </div>
              <div id="fileViewContent" class="file-view-content"></div>
            </section>
          </div>
        </section>
        <section id="diffDetailPage" class="diff-detail-page" hidden>
          <div class="file-detail-toolbar">
            <button id="backFromDiff" class="copy-button" type="button">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg>
              <span data-i18n="back">Back</span>
            </button>
            <nav id="diffBreadcrumb" class="repo-breadcrumb" aria-label="Diff file path"></nav>
          </div>
          <section id="conflictInfo" class="diff-view-panel" style="margin-bottom:14px;border-left:4px solid var(--amber);background:rgba(217,119,6,0.12);" hidden>
            <div class="diff-view-head" style="background:transparent;border-bottom:0;">
              <div>
                <h2 class="diff-view-title" style="color:var(--amber);font-size:15px;">
                  <span data-i18n="mergeConflict">🔀 Merge Conflict</span>
                </h2>
                <div id="conflictMergeInfo" class="meta" style="color:var(--amber);"></div>
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <button id="btnResolveConflict" class="commit-button" type="button" data-i18n="resolveConflict" style="background:#d97706;border-color:#d97706;">🤖 AI Resolve</button>
                <button id="btnManualEdit" class="copy-button" type="button" data-i18n="manualEdit">Manual Edit</button>
              </div>
            </div>
            <div id="conflictStatus" class="meta" style="padding:0 16px 12px;color:var(--amber);"></div>
          </section>
          <section class="diff-view-panel">
            <div class="diff-view-head">
              <div>
                <h2 id="diffViewTitle" class="diff-view-title">...</h2>
                <div id="diffViewMeta" class="meta"></div>
              </div>
            </div>
            <div id="diffViewContent" class="diff-view-content"></div>
          </section>
        </section>
      </div>
      <section id="taskPage" class="task-page" hidden>
        <div class="task-hero">
          <div class="task-hero-main">
            <h2 data-i18n="taskBoardTitle">仓库任务看板</h2>
            <p data-i18n="taskBoardIntro">任务保存在当前仓库的 .gmc/tasks 目录中。把待办任务移到 Agent 列即可启动对应 Agent。</p>
            <div class="task-meta-line">
              <span class="task-pill"><strong id="taskTotalCount">0</strong><span data-i18n="tasksCount">个任务</span></span>
              <span class="task-pill"><span data-i18n="taskStorage">存储</span><strong id="taskStoragePath">.gmc/tasks</strong></span>
            </div>
          </div>
          <div class="task-actions">
            <div id="repositoryTaskAgentSelector" class="task-repo-agent">
              <span class="task-repo-agent-label" data-i18n="repositoryTaskAgentSetting">任务分解 Agent</span>
              <div id="repositoryTaskAgentOptions" class="radio-group"></div>
              <div id="repositoryTaskAgentStatus" class="meta"></div>
            </div>
            <div class="task-action-buttons">
              <button id="refreshTasks" class="copy-button" type="button" data-i18n="refreshTasks">刷新</button>
              <button id="openTaskComposer" class="task-primary" type="button">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>
                <span data-i18n="newTask">新建任务</span>
              </button>
            </div>
          </div>
        </div>
        <div id="taskError" class="task-error"></div>
        <form id="taskComposer" class="task-composer" hidden>
          <div class="task-form-grid">
            <div class="task-field">
              <label for="taskContentInput" data-i18n="taskContent">内容</label>
              <div class="task-content-input">
                <textarea id="taskContentInput" maxlength="12000" data-i18n-placeholder="taskContentPlaceholder" placeholder="写下任务内容、背景或验收标准。支持 Markdown。"></textarea>
                <button id="taskSpeechButton" class="task-speech-button" type="button" aria-pressed="false" data-i18n-title="startSpeechInput" data-i18n-aria-label="startSpeechInput" title="开始语音输入">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2.5" width="6" height="12" rx="3"></rect><path d="M5.5 10.5a6.5 6.5 0 0 0 13 0"></path><path d="M12 17v4"></path><path d="M8.5 21h7"></path></svg>
                </button>
              </div>
              <div class="task-speech-meta">
                <span id="taskSpeechStatus" class="task-speech-status" role="status" aria-live="polite" data-i18n="speechReady">点击麦克风开始语音输入。音频不会保存。</span>
                <span class="task-speech-hint"><kbd>Ctrl</kbd> <span data-i18n="holdToTalk">长按 0.4 秒说话</span></span>
              </div>
            </div>
          </div>
          <div class="task-form-actions">
            <button id="cancelTaskComposer" class="copy-button" type="button" data-i18n="cancel">取消</button>
            <button id="decomposeTaskButton" class="copy-button" type="button" data-i18n="decomposeTask">AI 自动分解</button>
            <button id="createTaskButton" class="commit-button" type="submit" data-i18n="createTask">创建任务</button>
          </div>
        </form>
        <div id="taskBoard" class="task-board">
          <div class="task-board-loading" data-i18n="loadingTasks">正在加载任务...</div>
        </div>
      </section>
      <section id="settingsPage" class="settings-page" hidden>
        <div class="settings-hero">
          <button id="closeSettings" class="copy-button" type="button" data-i18n="back">Back</button>
          <div>
            <h2 data-i18n="settings">设置</h2>
            <p data-i18n="settingsIntro">管理 GitWeb 的访问控制、AI agent 偏好等全局设置。</p>
          </div>
        </div>
        <div class="settings-grid">
          <div class="settings-card">
            <h3 data-i18n="accessSettings">访问设置</h3>
            <div class="settings-row">
              <div class="settings-row-main">
                <strong data-i18n="allowExternalAccess">允许外部访问</strong>
                <span data-i18n="allowExternalAccessHelp">开启后，局域网内已认证设备可以访问当前 GitWeb 服务。这个开关只能在运行 GMC 的主机上修改。</span>
              </div>
              <label class="toggle-control" title="Allow authenticated devices on the local network to access GitWeb" data-i18n-title="allowExternalAccessHelp">
                <input id="allowExternalAccess" type="checkbox">
                <span class="toggle-track" aria-hidden="true"></span>
                <span data-i18n="externalAccess">External Access</span>
              </label>
            </div>
            <div class="settings-row">
              <div class="settings-row-main">
                <strong data-i18n="refreshTokenTitle">刷新 token</strong>
                <span data-i18n="refreshTokenHelp">刷新后旧 token 会立即失效，已经接入的设备需要重新扫码或使用新链接访问。</span>
              </div>
              <button id="rotateToken" class="copy-button" type="button" data-i18n="refreshToken">Refresh Token</button>
            </div>
            <div id="settingsHostOnlyWarning" class="settings-warning" data-i18n="hostOnlyWarning">当前页面不是从主机本机打开的，访问设置只能查看，不能修改。</div>
            <div id="settingAccessAddress" class="access-address"></div>
            <div class="settings-subsection">
              <h4 data-i18n="scanCurrentPage">扫码访问当前页面</h4>
              <p data-i18n="qrHelp">二维码内容是当前页面 URL，并自动附带访问 token。建议只给可信设备扫码。</p>
              <div class="qr-shell">
                <div id="accessQrCode" class="qr-box"><div class="qr-placeholder" data-i18n="qrEnableExternal">开启外部访问后生成二维码</div></div>
                <textarea id="accessUrlValue" class="access-url" readonly></textarea>
                <div class="settings-actions">
                  <button id="copyAccessUrl" class="copy-button" type="button" data-i18n="copyUrl">Copy URL</button>
                </div>
                <div id="qrStatus" class="meta"></div>
              </div>
            </div>
          </div>
          <div class="settings-card">
            <h3 data-i18n="agentSettings">Agent 设置</h3>
            <p data-i18n="agentSettingsHelp">分别选择生成 commit message 和执行任务时使用的 AI agent。</p>
            <div class="agent-selector" id="commitAgentSelector">
              <h4 data-i18n="commitAgentSetting">Commit agent</h4>
              <p data-i18n="commitAgentSettingHelp">用于生成 commit message。</p>
              <div id="commitAgentOptions" class="radio-group"></div>
              <div id="commitAgentStatus" class="meta"></div>
            </div>
            <div class="agent-selector" id="taskAgentSelector">
              <h4 data-i18n="taskAgentSetting">Task agent</h4>
              <p data-i18n="taskAgentSettingHelp">用于任务进入进行中状态时启动开发。</p>
              <div id="taskAgentOptions" class="radio-group"></div>
              <div id="taskAgentStatus" class="meta"></div>
            </div>
          </div>
          <div class="settings-card settings-card-full">
            <h3 data-i18n="themeSettings">主题设置</h3>
            <p data-i18n="themeSettingsHelp">选择你喜欢的 Web 仪表盘主题风格，实时应用到整个页面。</p>
            <div id="themeOptions" class="theme-grid"></div>
          </div>
        </div>
      </section>
    </div>
  </main>
</div>

<aside id="drawer" class="drawer">
  <div class="drawer-head">
    <div>
      <h2 id="drawerTitle" style="margin: 0;" data-i18n="commit">Commit</h2>
      <div id="drawerMeta" class="meta"></div>
    </div>
    <div class="drawer-actions">
      <button id="copyDetail" class="copy-button" type="button" data-i18n="copy">Copy</button>
      <button id="closeDetail" class="copy-button close-button" type="button" data-i18n="close">Close</button>
    </div>
  </div>
  <pre id="message"></pre>
  <pre id="stat"></pre>
</aside>

<div id="tokenConfirmModal" class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="tokenConfirmTitle">
  <div class="modal">
    <h2 id="tokenConfirmTitle" data-i18n="refreshTokenConfirmTitle">刷新访问 token</h2>
    <p data-i18n="refreshTokenConfirmBody">刷新后旧 token 会立即失效，所有外部设备都必须重新扫描新二维码，或复制新链接打开。确认要继续吗？</p>
    <div class="modal-actions">
      <button id="cancelRotateToken" class="copy-button" type="button" data-i18n="cancel">取消</button>
      <button id="confirmRotateToken" class="commit-button" type="button" data-i18n="confirmRefresh">确认刷新</button>
    </div>
  </div>
</div>

<div id="taskDetailModal" class="modal-backdrop" role="dialog" aria-modal="true" data-i18n-aria-label="taskDetails" aria-label="任务详情">
  <div class="modal task-detail-modal">
    <div class="task-detail-head">
      <div class="task-detail-meta">
        <span id="taskDetailId" class="task-detail-chip"></span>
        <span id="taskDetailStatus" class="task-detail-chip status"></span>
        <span id="taskDetailUpdated" class="task-detail-chip"></span>
      </div>
      <h2 id="taskDetailTitle"></h2>
    </div>
    <div id="taskDetailBody" class="task-detail-body"></div>
    <form id="taskDetailEdit" class="task-detail-edit" hidden>
      <div class="task-field">
        <label for="taskDetailContentInput" data-i18n="taskContent">内容</label>
        <textarea id="taskDetailContentInput"></textarea>
      </div>
    </form>
    <div class="modal-actions">
      <button id="decomposeTaskDetail" class="copy-button" type="button" data-i18n="decomposeTask">AI 自动分解</button>
      <button id="editTaskDetail" class="copy-button" type="button" data-i18n="editTask">编辑</button>
      <button id="cancelTaskEdit" class="copy-button" type="button" data-i18n="cancel" hidden>取消</button>
      <button id="saveTaskDetail" class="commit-button" type="button" data-i18n="saveTask" hidden>保存</button>
      <button id="closeTaskDetail" class="copy-button" type="button" data-i18n="close">关闭</button>
    </div>
  </div>
</div>

<script>
var GMC_AUTH_TOKEN = ${JSON.stringify(clientAuthToken || '')};
var REQUEST_CONTEXT = ${JSON.stringify(publicSecuritySettings(null, req))};
var AUTH_QUERY_PARAM = ${JSON.stringify(AUTH_QUERY_PARAM)};
(function() {
  var nativeFetch = window.fetch.bind(window);
  var FETCH_TIMEOUT_MS = 30000;
  window.fetch = function(input, init) {
    init = init || {};
    var timeoutMs = Number(init.gmcTimeoutMs) > 0 ? Number(init.gmcTimeoutMs) : FETCH_TIMEOUT_MS;
    delete init.gmcTimeoutMs;
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
    if (init.signal) {
      init.signal.addEventListener('abort', function() { controller.abort(); });
    }
    init.signal = controller.signal;
    var headers = new Headers(init.headers || {});
    var fetchUrl = new URL(typeof input === 'string' ? input : input.url, window.location.href);
    if (GMC_AUTH_TOKEN && fetchUrl.origin === window.location.origin) headers.set('X-GMC-Auth', GMC_AUTH_TOKEN);
    init.headers = headers;
    return nativeFetch(input, init).finally(function() { clearTimeout(timer); });
  };
})();
var urlParams = new URLSearchParams(window.location.search);
var targetRepo = urlParams.get('repo') || '';
var initialReloadToken = ${JSON.stringify(RELOAD_TOKEN)};
var AUTO_STATUS_INTERVAL_MS = 10000;
var HIDDEN_STATUS_INTERVAL_MS = 60000;
var AGENT_MONITOR_POLL_INTERVAL_MS = 5000;
var AGENT_MONITOR_RECONNECT_INTERVAL_MS = 2000;
var TASK_DECOMPOSITION_TIMEOUT_MS = ${JSON.stringify(agent.codexTimeoutMs() + 60 * 1000)};
var TASK_SPEECH_CTRL_HOLD_MS = 400;
var state = { auto: true, timer: null, loading: false, pendingForceLoad: false, graphTimer: null, statusSignature: null, commits: [], files: [], tasks: [], repoTasks: [], tasksLoaded: false, taskLoading: false, pendingTaskReload: false, taskEvents: null, agentMonitor: { status: 'loading', available: false, reason: '', agents: [], usage: null }, agentMonitorLoading: false, agentMonitorTimer: null, agentMonitorRequest: null, agentMonitorSocket: null, agentMonitorReconnectTimer: null, activeView: 'git', previousViewBeforeSettings: 'git', draggedTaskId: '', activeTaskId: '', taskDetailEditing: false, commitBranch: {}, branchParent: {}, sortedBranches: [], currentBranch: '', repoBrowserPath: '', repoBrowserEntries: [], repoBrowserLoading: false, repoBrowserLoaded: false, fileTree: null, fileTreeLoading: false, fileTreeExpanded: {}, fileViewPath: '', fileViewType: '', fileViewLoading: false, diffViewPath: '', diffViewLoading: false, branchSwitching: false, selectedModified: {}, selectedStaged: {}, committing: false, ignoring: false, restoring: false, staging: false, unstaging: false, detailToken: 0, detailPinned: false, hideTimer: null, readmeLoaded: false, install: { hooks: true }, sidebarCollapsed: false, repoHistory: [], repoHistoryNeedsRefresh: true, contributions: null, globalContributions: null, gitOverview: null, gitOverviewLoading: false, settingsOpen: false, qrUrl: '', qrLoading: false, commitAgent: 'codex', taskAgent: 'codex', repositoryTaskAgent: 'codex', security: { allowExternalAccess: REQUEST_CONTEXT.allowExternalAccess === true, localAccess: REQUEST_CONTEXT.localAccess !== false, accessAddress: REQUEST_CONTEXT.accessAddress || '', lanAddress: REQUEST_CONTEXT.lanAddress || '' } };
var taskSpeech = {
  recognition: null,
  supported: false,
  requested: false,
  listening: false,
  stopping: false,
  heldByShortcut: false,
  shortcutPressed: false,
  shortcutTimer: null,
  baseValue: '',
  insertStart: 0,
  insertEnd: 0,
  finalTranscript: '',
  interimTranscript: '',
  statusKey: 'speechReady',
  statusClass: ''
};
var I18N = {
  'zh-CN': {
    language: '语言',
    languageButton: '中文',
    recentRepos: '最近仓库',
    closeSidebar: '关闭侧边栏',
    toggleSidebar: '切换侧边栏',
    loading: '加载中...',
    settings: '设置',
    settingsIntro: '管理 GitWeb 的访问控制、AI agent 偏好等全局设置。',
    accessSettings: '访问设置',
    themeSettings: '主题设置',
    themeSettingsHelp: '选择你喜欢的 Web 仪表盘主题风格，实时应用到整个页面。',
    activeTheme: '当前主题',
    themeDefault: '经典翡翠',
    themeDark: '深邃夜空',
    themeOcean: '湛蓝海洋',
    themePurple: '魅紫风暴',
    installBanner: '⚠️ GMC Hooks 尚未安装。安装 Git hooks 后可以自动生成 commit message，git commit 可在任意位置使用。',
    installHooks: '安装 Hooks',
    currentBranch: '当前分支',
    ahead: 'ahead',
    behind: 'behind',
    changedFiles: 'changed files',
    push: 'Push',
    pull: 'Pull',
    workingTree: '工作区',
    branchesTree: '分支树',
    repositoryFiles: '仓库文件',
    fileTree: '文件树',
    filesCount: '项',
    noRepositoryFiles: '当前分支没有可显示的文件。',
    loadingFiles: '正在加载文件...',
    loadingFile: '正在加载文件内容...',
    fileLoadFailed: '文件加载失败：',
    branchSwitchFailed: '切换分支失败：',
    switchingBranch: '正在切换分支...',
    localBranch: '本地',
    remoteBranch: '远程',
    binaryFile: '二进制文件无法直接预览。',
    largeFile: '文件过大，已停止直接预览。',
    truncatedFile: '内容已截断',
    directory: '目录',
    file: '文件',
    diffView: 'Diff 视图',
    loadingDiff: '正在加载 Diff...',
    diffLoadFailed: 'Diff 加载失败：',
    noDiff: '没有可显示的 diff。',
    openReadme: '打开 README',
    commitGraph: '提交图',
    recentHistory: '最近仓库历史',
    accessSettingsIntro: '管理局域网访问、刷新访问 token，并生成当前页面的扫码入口。移动设备扫码后会自动带上访问凭证，不需要手动输入长 token。',
    back: '返回',
    allowExternalAccess: '允许外部访问',
    allowExternalAccessHelp: '开启后，局域网内已认证设备可以访问当前 GitWeb 服务。这个开关只能在运行 GMC 的主机上修改。',
    externalAccess: '外部访问',
    refreshTokenTitle: '刷新 token',
    refreshTokenHelp: '刷新后旧 token 会立即失效，已经接入的设备需要重新扫码或使用新链接访问。',
    refreshToken: '刷新 Token',
    hostOnlyWarning: '当前页面不是从主机本机打开的，访问设置只能查看，不能修改。',
    scanCurrentPage: '扫码访问当前页面',
    qrHelp: '二维码内容是当前页面 URL，并自动附带访问 token。建议只给可信设备扫码。',
    qrEnableExternal: '开启外部访问后生成二维码',
    copyUrl: '复制链接',
    commit: '提交',
    copy: '复制',
    close: '关闭',
    refreshTokenConfirmTitle: '刷新访问 token',
    refreshTokenConfirmBody: '刷新后旧 token 会立即失效，所有外部设备都必须重新扫描新二维码，或复制新链接打开。确认要继续吗？',
    cancel: '取消',
    confirmRefresh: '确认刷新',
    selectRepositoryFirst: '请先选择仓库',
    noRecentRepos: '还没有最近仓库。',
    recentlyVisited: '最近访问',
    justNow: '刚刚',
    agoMinute: '分钟前',
    agoHour: '小时前',
    agoDay: '天前',
    noRepositorySelected: '未选择仓库',
    noUpstream: '没有 upstream',
    lanAddress: '局域网地址：',
    qrNeedExternal: '移动设备访问前，需要先允许外部访问。',
    qrGenerating: '正在生成二维码...',
    qrReady: '二维码包含当前页面 URL 和一次访问所需 token。',
    qrFailed: '二维码生成失败',
    copyLinkFallback: '请复制下方链接发送到移动设备。',
    linkCopied: '访问链接已复制。',
    refreshInProgress: '正在刷新访问 token...',
    refreshDone: '旧 token 已失效。使用新 token 需设备扫描新二维码，或复制下方新链接打开。',
    refreshFailed: 'token 刷新失败：',
    refreshButtonWorking: '刷新中...',
    disableExternalConfirm: '确定要关闭外部访问吗？\\n\\n关闭后，只能从运行 GitWeb 服务的主机重新开启。',
    updateExternalFailed: '更新外部访问设置失败：',
    openFinderFailed: '在 Finder 中打开失败：',
    finderLocalOnly: '仅从 127.0.0.1 访问时可以在 Finder 中打开。',
    openTerminal: '在终端中打开',
    openTerminalPrefix: '在终端中打开：',
    terminalLocalOnly: '仅从 127.0.0.1 访问时可以打开终端。',
    openTerminalFailed: '打开终端失败：',
    cleanWorkingTree: '工作区干净。',
    modifiedFiles: '已修改',
    stagedFiles: '暂存区',
    noModifiedFiles: '没有未暂存的修改。',
    noStagedFiles: '暂存区为空。',
    all: '全部',
    restore: '还原',
    ignore: '忽略',
    stage: '暂存',
    staging: '暂存中...',
    unstage: '移除暂存',
    unstaging: '移除中...',
    stagingSelected: '正在暂存选中的文件...',
    unstagingSelected: '正在移除选中文件的暂存状态...',
    stagedPrefix: '已暂存 ',
    stagedSuffix: ' 个文件。',
    unstagedPrefix: '已移除 ',
    unstagedSuffix: ' 个文件的暂存状态。',
    selected: '已选择',
    committing: '提交中...',
    ignoring: '忽略中...',
    restoring: '还原中...',
    commitSelected: '提交',
    installing: '安装中...',
    installed: '已安装',
    installFailed: '安装失败',
    installFailedPrefix: '安装失败：',
    working: '处理中...',
    successPrefix: '成功：',
    errorPrefix: '错误：',
    noBranches: '没有分支。',
    noCommits: '还没有提交。',
    noSubject: '无标题',
    aiGenerating: 'AI 正在生成 commit message',
    commitDetail: '提交详情',
    copied: '已复制',
    selectTextAndCopy: '请选中文本后复制',
    repoRunning: 'GMC GitWeb 正在运行。请在 git 仓库中执行 "gmc web" 查看状态。',
    openInFinderPrefix: '在 Finder 中打开：',
    removeFromRecent: '从最近仓库中移除',
    removeFromRecentAriaSuffix: '从最近仓库中移除',
    loadingStatusErrorPrefix: '加载状态失败：',
    pushing: 'Push 中...',
    pulling: 'Pull 中...',
    commitsOn: '次提交于',
    commitsGlobalOnly: '全部项目共 {global} 次提交于 {date}',
    commitsCurrentAndGlobal: '当前项目 {current} 次提交（全部项目共 {global} 次）于 {date}',
    installHooksConfirm: 'GMC Git Hooks 尚未安装！\\n\\n安装 hooks 后，每次 git commit -m gmc 都会自动触发 AI 辅助生成 commit message。\\n\\n点击“确定”安装 hooks 后提交\\n点击“取消”则本次直接使用 AI 生成 commit message（较慢）',
    installingHooks: '正在安装 hooks...',
    hookInstallFailedPrefix: 'Hook 安装失败：',
    commitWithHooksStatus: '正在提交已选择文件...',
    commitWithAiStatus: '正在生成 AI commit message 并提交...',
    committedSelected: '已提交选择的文件。',
    ignoringSelected: '正在忽略已选择文件...',
    ignoreRulesAddedSuffix: ' 条 ignore 规则已添加到 .gitignore。',
    restoreConfirmPrefix: '确定要丢弃 ',
    restoreConfirmSuffix: ' 个文件中的更改吗？',
    restoringSelected: '正在还原已选择文件...',
    restoredPrefix: '已还原 ',
    restoredSuffix: ' 个文件。',
    gitView: 'Git',
    taskView: 'Task',
    taskBoardTitle: '仓库任务看板',
    taskBoardIntro: '任务保存在当前仓库的 .gmc/tasks 目录中。把待办任务移到 Codex、Claude 或 Antigravity 列，就会启动对应 Agent。',
    tasksCount: '个任务',
    taskStorage: '存储',
    refreshTasks: '刷新',
    newTask: '新建任务',
    taskContent: '内容',
    taskDetails: '任务详情',
    taskContentPlaceholder: '写下任务内容、背景或验收标准。支持 Markdown。',
    startSpeechInput: '开始语音输入',
    stopSpeechInput: '停止语音输入',
    speechReady: '点击麦克风开始语音输入。音频不会保存。',
    speechUnsupported: '当前浏览器不支持网页语音识别，请改用键盘输入。',
    speechStarting: '正在请求麦克风权限...',
    speechListening: '正在聆听并实时识别...',
    speechStopping: '正在结束识别...',
    speechPermissionDenied: '无法使用麦克风，请允许浏览器访问麦克风。',
    speechMicrophoneUnavailable: '没有找到可用的麦克风。',
    speechNoSpeech: '没有识别到语音，请重试。',
    speechNetworkError: '语音识别网络不可用，请稍后重试。',
    speechLanguageUnsupported: '当前语言暂不支持语音识别。',
    speechFailed: '语音识别失败，请重试。',
    speechContentLimit: '已达到任务内容长度上限。',
    holdToTalk: '长按 0.4 秒说话',
    createTask: '创建任务',
    creatingTask: '创建中...',
    decomposeTask: 'AI 自动分解',
    decomposingTask: '正在分解...',
    loadingTasks: '正在加载任务...',
    taskLoadFailed: '任务加载失败：',
    taskCreateFailed: '任务创建失败：',
    taskDecomposeFailed: '任务分解失败：',
    deleteDecomposedTaskConfirm: 'AI 已将 {id} 分解为 {count} 个新任务。是否删除原任务？',
    taskUpdateFailed: '任务更新失败：',
    noTasksInColumn: '这一列还没有任务',
    noRepoForTasks: '请先选择一个 Git 仓库来使用任务看板。',
    taskStatusTodo: '待办',
    taskStatusCodex: 'Codex',
    taskStatusClaude: 'Claude',
    taskStatusAntigravity: 'Antigravity',
    taskStatusDoing: '进行中',
    taskStatusReview: '待确认',
    taskStatusDone: '已完成',
    agentMonitorLoading: '正在加载运行状态...',
    agentMonitorWorking: '运行中',
    agentMonitorIdle: '空闲',
    agentMonitorPaused: '需要交互',
    agentMonitorStopped: '未运行',
    agentMonitorUnavailable: '监控不可用',
    agentMonitorTimeout: '监控超时',
    agentMonitorUnknown: '状态未知',
    agentMonitorProcesses: '进程',
    agentMonitorMemory: '内存',
    agentMonitorUptime: '最长运行',
    agentMonitorDays: '天',
    agentMonitorHours: '小时',
    agentMonitorMinutes: '分钟',
    agentMonitorSeconds: '秒',
    agentUsageTitle: '用量信息',
    agentUsage5h: '5小时用量',
    agentUsage7d: '7日用量',
    agentUsage24h: '24小时用量',
    agentUsage30d: '30日用量',
    agentUsageToday: '今日用量',
    agentUsageMonth: '本月用量',
    agentUsageTotal: '累计用量',
    agentUsageLastSession: '最近会话',
    agentUsageProjectLastSessions: '各项目最近会话',
    agentUsageSessions: '次会话',
    agentUsageNoData: '暂无用量',
    moveTaskLeft: '前移',
    moveTaskRight: '后移',
    taskUpdatedJustNow: '刚刚更新',
    taskContentEmpty: '没有内容。点击新建任务时可以写下背景或验收标准。',
    deleteTask: '删除任务',
    deleteTaskConfirmPrefix: '确定要删除任务 ',
    deleteTaskConfirmSuffix: ' 吗？\\n\\n这会删除仓库中的任务文件。',
    taskDeleteFailed: '任务删除失败：',
    taskDetail: '任务详情',
    editTask: '编辑',
    saveTask: '保存',
    savingTask: '保存中...',
    taskSaveFailed: '任务保存失败：',
    mergeConflict: '🔀 合并冲突',
    resolveConflict: '🤖 AI 解决',
    manualEdit: '手动编辑',
    resolvingConflict: '正在调用 AI 分析冲突...',
    conflictResolveFailed: 'AI 合并失败：',
    conflictResolved: 'AI 合并完成！文件已暂存。',
    conflictAcceptFailed: '合并方案写入失败：',
    editSaveAndAccept: '保存并接受',
    agentSettings: 'Agent 设置',
    agentSettingsHelp: '分别选择生成 commit message 和执行任务时使用的 AI agent。',
    commitAgentSetting: 'Commit message Agent',
    commitAgentSettingHelp: '用于生成 commit message。',
    taskAgentSetting: 'Task Agent',
    taskAgentSettingHelp: '作为仓库任务自动分解时的默认 Agent。',
    repositoryTaskAgentSetting: '任务分解 Agent',
    agentSettingSaved: 'Agent 设置已保存',
    agentSettingSaveFailed: 'Agent 设置保存失败：',
    homeTitle: '全局 Git 概览',
    homeBadge: 'Git 全局工作台',
    homeHeroTitle: '全局 Git 概览与工作台',
    homeHeroSubtitle: '查看全局代码提交热力图、管理系统 Git 配置，并一键启动常用开发工具。',
    closeRepo: '关闭仓库',
    closeRepoTitle: '退出当前仓库，回到全局概览主页',
    globalCalendar: '全局提交贡献日历',
    globalCalendarDesc: '已追踪的所有本地仓库在过去一年的全景提交热力图',
    devTools: '常用开发工具',
    devToolsDesc: '一键启动本地安装的常用开发环境与编辑器',
    gitSystemInfo: '全局 Git 配置管理',
    gitSystemInfoDesc: '查看与修改 ~/.gitconfig 中的系统全局配置',
    gitVersion: 'Git 版本',
    gitPath: 'Git 路径',
    globalIdentity: '全局身份',
    trackedRepos: '已追踪仓库',
    userName: '用户名 (user.name)',
    userEmail: '邮箱 (user.email)',
    coreEditor: '默认编辑器 (core.editor)',
    defaultBranch: '新建分支默认名 (init.defaultBranch)',
    pullRebase: 'Pull 策略 (pull.rebase)',
    saveConfig: '保存全局配置',
    configSaved: '全局配置已保存',
    launchApp: '启动',
    appLaunched: '已启动',
    allGlobalConfigs: '所有全局配置项 (全量列表)',
    addConfigKey: '添加配置',
    notSet: '未设置',
    needsAttentionTitle: '待处理与变动仓库',
    needsAttentionDesc: '包含未暂存代码、待提交修改或未与远程分支同步的本地项目',
    reposNeedingAttentionCount: '个项目需关注',
    refreshStatus: '刷新状态',
    enterRepo: '进入工作台',
    clean: '干净',
    unstaged: '未暂存',
    staged: '待提交',
    aheadLabel: '待推送',
    behindLabel: '待拉取',
    repoCleanTooltip: '工作区干净，已与远程同步',
    unstagedFilesTooltip: '个文件已修改 (未暂存)',
    stagedFilesTooltip: '个文件已暂存 (待提交)',
    untrackedFilesTooltip: '个未跟踪新文件',
    aheadCommitsTooltip: '个本地领先提交 (待推送)',
    behindCommitsTooltip: '个远程落后提交 (待拉取)',
    city3dTitle: '3D 城市视角',
    city3dCruise: '巡航飞行',
    city3dCruisePaused: '已暂停飞行',
    city3dDay: '白天模式',
    city3dNight: '夜间模式',
    city3dZenMode: '全景沉浸',
    city3dOverviewMode: '恢复概览',
    city3dEnterRepo: '进入此仓库',
    city3dBuildings: '建筑数量 (文本文件)',
    city3dGreenSpace: '绿化区域 (非文本文件)',
    city3dTallest: '最高建筑 (最大文件)',
    city3dWeather: '天气切换 (晴空/雨夜)',
    city3dRain: '赛博雨夜',
    city3dClear: '晴朗晴空'
  },
  en: {
    language: 'Language',
    languageButton: 'EN',
    recentRepos: 'Recent Repos',
    closeSidebar: 'Close Sidebar',
    toggleSidebar: 'Toggle Sidebar',
    loading: 'Loading...',
    settings: 'Settings',
    settingsIntro: 'Manage GitWeb access control, AI agent preferences, and other global settings.',
    accessSettings: 'Access Settings',
    installBanner: '⚠️ GMC Hooks is not installed. Installing Git hooks can automatically generate commit messages, and git commit is available anywhere.',
    installHooks: 'Install Hooks',
    currentBranch: 'Current Branch',
    ahead: 'ahead',
    behind: 'behind',
    changedFiles: 'changed files',
    push: 'Push',
    pull: 'Pull',
    workingTree: 'Working Tree',
    branchesTree: 'Branches Tree',
    repositoryFiles: 'Repository Files',
    fileTree: 'File Tree',
    filesCount: 'items',
    noRepositoryFiles: 'No files to show on this branch.',
    loadingFiles: 'Loading files...',
    loadingFile: 'Loading file...',
    fileLoadFailed: 'Failed to load file: ',
    branchSwitchFailed: 'Failed to switch branch: ',
    switchingBranch: 'Switching branch...',
    localBranch: 'local',
    remoteBranch: 'remote',
    binaryFile: 'Binary file preview is unavailable.',
    largeFile: 'This file is too large to preview directly.',
    truncatedFile: 'Content truncated',
    directory: 'Directory',
    file: 'File',
    diffView: 'Diff View',
    loadingDiff: 'Loading diff...',
    diffLoadFailed: 'Failed to load diff: ',
    noDiff: 'No diff to show.',
    openReadme: 'Open README',
    commitGraph: 'Commit Graph',
    recentHistory: 'Recent repository history',
    accessSettingsIntro: 'Manage LAN access, refresh the access token, and generate a QR entry for the current page. Mobile devices can scan it for first access without typing a long token.',
    back: 'Back',
    allowExternalAccess: 'Allow External Access',
    allowExternalAccessHelp: 'When enabled, authenticated devices on your local network can access this GitWeb service. This can only be changed from the host machine running GMC.',
    externalAccess: 'External Access',
    refreshTokenTitle: 'Refresh token',
    refreshTokenHelp: 'Refreshing immediately invalidates the old token. Connected devices must scan again or open the new link.',
    refreshToken: 'Refresh Token',
    hostOnlyWarning: 'This page was not opened from the host machine, so access settings are read-only.',
    scanCurrentPage: 'Scan to open this page',
    qrHelp: 'The QR code contains the current page URL and access token. Share it only with trusted devices.',
    qrEnableExternal: 'Enable external access to generate a QR code',
    copyUrl: 'Copy URL',
    commit: 'Commit',
    copy: 'Copy',
    close: 'Close',
    refreshTokenConfirmTitle: 'Refresh access token',
    refreshTokenConfirmBody: 'Refreshing immediately invalidates the old token. All external devices must scan the new QR code or open the copied new link. Continue?',
    cancel: 'Cancel',
    confirmRefresh: 'Refresh',
    selectRepositoryFirst: 'Select a repository first',
    noRecentRepos: 'No recent repositories yet.',
    recentlyVisited: 'Recently visited',
    justNow: 'Just now',
    agoMinute: 'm ago',
    agoHour: 'h ago',
    agoDay: 'd ago',
    noRepositorySelected: 'No repository selected',
    noUpstream: 'No upstream',
    lanAddress: 'LAN address: ',
    qrNeedExternal: 'Enable external access before opening this page from a mobile device.',
    qrGenerating: 'Generating QR code...',
    qrReady: 'The QR code contains the current page URL and one access token.',
    qrFailed: 'QR code generation failed',
    copyLinkFallback: 'Copy the link below and send it to the mobile device.',
    linkCopied: 'Access link copied.',
    refreshInProgress: 'Refreshing access token...',
    refreshDone: 'The old token is invalid. Use the new token by scanning the new QR code or opening the copied new link.',
    refreshFailed: 'Token refresh failed: ',
    refreshButtonWorking: 'Updating...',
    disableExternalConfirm: 'Are you sure you want to disable External Access?\\n\\nOnce disabled, this setting can only be re-enabled from the machine where the GitWeb service is running.',
    updateExternalFailed: 'Failed to update External Access settings: ',
    openFinderFailed: 'Open in Finder failed: ',
    finderLocalOnly: 'Finder opening is available only from 127.0.0.1.',
    openTerminal: 'Open in Terminal',
    openTerminalPrefix: 'Open in Terminal: ',
    terminalLocalOnly: 'Terminal opening is available only from 127.0.0.1.',
    openTerminalFailed: 'Open in Terminal failed: ',
    cleanWorkingTree: 'Clean working tree.',
    modifiedFiles: 'Modified',
    stagedFiles: 'Staged',
    noModifiedFiles: 'No unstaged changes.',
    noStagedFiles: 'No staged changes.',
    all: 'All',
    restore: 'Restore',
    ignore: 'Ignore',
    stage: 'Stage',
    staging: 'Staging...',
    unstage: 'Unstage',
    unstaging: 'Unstaging...',
    stagingSelected: 'Staging selected files...',
    unstagingSelected: 'Unstaging selected files...',
    stagedPrefix: 'Staged ',
    stagedSuffix: ' file(s).',
    unstagedPrefix: 'Unstaged ',
    unstagedSuffix: ' file(s).',
    selected: 'selected',
    committing: 'Committing...',
    ignoring: 'Ignoring...',
    restoring: 'Restoring...',
    commitSelected: 'Commit',
    installing: 'Installing...',
    installed: 'Installed',
    installFailed: 'Install Failed',
    installFailedPrefix: 'Install failed: ',
    working: 'Working...',
    successPrefix: 'Success: ',
    errorPrefix: 'Error: ',
    noBranches: 'No branches.',
    noCommits: 'No commits yet.',
    noSubject: 'no subject',
    aiGenerating: 'AI is generating a commit message',
    commitDetail: 'Commit detail',
    copied: 'Copied',
    selectTextAndCopy: 'Select text and copy',
    repoRunning: 'GMC GitWeb is running. Use "gmc web" in a git repository to view its status.',
    openInFinderPrefix: 'Open in Finder: ',
    removeFromRecent: 'Remove from recent',
    removeFromRecentAriaSuffix: 'from recent repositories',
    loadingStatusErrorPrefix: 'Error loading status: ',
    pushing: 'Pushing...',
    pulling: 'Pulling...',
    commitsOn: 'commits on',
    commitsGlobalOnly: '{global} commits across all repos on {date}',
    commitsCurrentAndGlobal: '{current} commits in current repo ({global} in all repos) on {date}',
    installHooksConfirm: 'GMC Git Hooks is not installed!\\n\\nAfter installing hooks, each git commit -m gmc will automatically trigger AI-assisted commit message generation.\\n\\nClick "OK" to install hooks and commit\\nClick "Cancel" to use AI to generate a commit message directly this time (slower)',
    installingHooks: 'Installing hooks...',
    hookInstallFailedPrefix: 'Hook install failed: ',
    commitWithHooksStatus: 'Committing selected files...',
    commitWithAiStatus: 'Generating AI commit message and committing...',
    committedSelected: 'Committed selected files.',
    ignoringSelected: 'Ignoring selected files...',
    ignoreRulesAddedSuffix: ' ignore rule(s) added to .gitignore.',
    restoreConfirmPrefix: 'Are you sure you want to discard changes in ',
    restoreConfirmSuffix: ' file(s)?',
    restoringSelected: 'Restoring selected files...',
    restoredPrefix: 'Restored ',
    restoredSuffix: ' file(s).',
    gitView: 'Git',
    taskView: 'Tasks',
    taskBoardTitle: 'Repository Task Board',
    taskBoardIntro: 'Tasks are stored in .gmc/tasks. Move a todo task to the Codex, Claude, or Antigravity lane to start that agent.',
    tasksCount: 'tasks',
    taskStorage: 'Storage',
    refreshTasks: 'Refresh',
    newTask: 'New Task',
    taskContent: 'Content',
    taskDetails: 'Task details',
    taskContentPlaceholder: 'Describe the task, context, or acceptance criteria. Markdown is supported.',
    startSpeechInput: 'Start voice input',
    stopSpeechInput: 'Stop voice input',
    speechReady: 'Click the microphone to start voice input. Audio is not saved.',
    speechUnsupported: 'This browser does not support web speech recognition. Use the keyboard instead.',
    speechStarting: 'Requesting microphone access...',
    speechListening: 'Listening and transcribing live...',
    speechStopping: 'Finishing transcription...',
    speechPermissionDenied: 'Microphone access is unavailable. Allow microphone permission in the browser.',
    speechMicrophoneUnavailable: 'No available microphone was found.',
    speechNoSpeech: 'No speech was recognized. Try again.',
    speechNetworkError: 'The speech recognition service is unavailable. Try again later.',
    speechLanguageUnsupported: 'Speech recognition is unavailable for the current language.',
    speechFailed: 'Speech recognition failed. Try again.',
    speechContentLimit: 'The task content limit has been reached.',
    holdToTalk: 'hold for 0.4s to talk',
    createTask: 'Create Task',
    creatingTask: 'Creating...',
    decomposeTask: 'Decompose with AI',
    decomposingTask: 'Decomposing...',
    loadingTasks: 'Loading tasks...',
    taskLoadFailed: 'Failed to load tasks: ',
    taskCreateFailed: 'Failed to create task: ',
    taskDecomposeFailed: 'Failed to decompose task: ',
    deleteDecomposedTaskConfirm: 'AI decomposed {id} into {count} new tasks. Delete the original task?',
    taskUpdateFailed: 'Failed to update task: ',
    noTasksInColumn: 'No tasks in this lane yet',
    noRepoForTasks: 'Select a Git repository before using the task board.',
    taskStatusTodo: 'Todo',
    taskStatusCodex: 'Codex',
    taskStatusClaude: 'Claude',
    taskStatusAntigravity: 'Antigravity',
    taskStatusDoing: 'Doing',
    taskStatusReview: 'Review',
    taskStatusDone: 'Done',
    agentMonitorLoading: 'Loading runtime status...',
    agentMonitorWorking: 'Working',
    agentMonitorIdle: 'Idle',
    agentMonitorPaused: 'Needs interaction',
    agentMonitorStopped: 'Not running',
    agentMonitorUnavailable: 'Monitor unavailable',
    agentMonitorTimeout: 'Monitor timed out',
    agentMonitorUnknown: 'Unknown status',
    agentMonitorProcesses: 'Processes',
    agentMonitorMemory: 'Memory',
    agentMonitorUptime: 'Longest runtime',
    agentMonitorDays: 'd',
    agentMonitorHours: 'h',
    agentMonitorMinutes: 'm',
    agentMonitorSeconds: 's',
    agentUsageTitle: 'Usage',
    agentUsage5h: '5h Usage',
    agentUsage7d: '7d Usage',
    agentUsage24h: '24h Usage',
    agentUsage30d: '30d Usage',
    agentUsageToday: 'Today',
    agentUsageMonth: 'This Month',
    agentUsageTotal: 'Total',
    agentUsageLastSession: 'Last Session',
    agentUsageProjectLastSessions: 'Latest Project Sessions',
    agentUsageSessions: 'sessions',
    agentUsageNoData: 'No usage data',
    moveTaskLeft: 'Move left',
    moveTaskRight: 'Move right',
    taskUpdatedJustNow: 'Updated just now',
    taskContentEmpty: 'No content yet. Add context or acceptance criteria when creating a task.',
    deleteTask: 'Delete task',
    deleteTaskConfirmPrefix: 'Delete task ',
    deleteTaskConfirmSuffix: '?\\n\\nThis removes the task file from the repository.',
    taskDeleteFailed: 'Failed to delete task: ',
    taskDetail: 'Task detail',
    editTask: 'Edit',
    saveTask: 'Save',
    savingTask: 'Saving...',
    taskSaveFailed: 'Failed to save task: ',
    mergeConflict: '🔀 Merge Conflict',
    resolveConflict: '🤖 AI Resolve',
    manualEdit: 'Manual Edit',
    resolvingConflict: 'Resolving conflict with AI...',
    conflictResolveFailed: 'AI resolution failed: ',
    conflictResolved: 'AI resolved! File staged.',
    conflictAcceptFailed: 'Failed to apply resolution: ',
    editSaveAndAccept: 'Save & Accept',
    agentSettings: 'Agent Settings',
    agentSettingsHelp: 'Choose separate AI agents for commit message generation and task development.',
    commitAgentSetting: 'Commit message agent',
    commitAgentSettingHelp: 'Used to generate commit messages.',
    taskAgentSetting: 'Task agent',
    taskAgentSettingHelp: 'Used as the default agent for repository task decomposition.',
    repositoryTaskAgentSetting: 'Task decomposition agent',
    agentSettingSaved: 'Agent setting saved',
    agentSettingSaveFailed: 'Failed to save agent setting: ',
    themeSettings: 'Theme Settings',
    themeSettingsHelp: 'Choose your preferred dashboard theme style, applied instantly to the entire page.',
    activeTheme: 'Active',
    themeDefault: 'Classic Emerald',
    themeDark: 'Dark Slate',
    themeOcean: 'Ocean Blue',
    themePurple: 'Midnight Violet',
    homeTitle: 'Git Overview',
    homeBadge: 'Git System Hub',
    homeHeroTitle: 'Git Overview & Developer Hub',
    homeHeroSubtitle: 'View global commit heatmaps, manage system Git config, and launch developer tools with one click.',
    closeRepo: 'Close Repo',
    closeRepoTitle: 'Close current repository and return to overview',
    globalCalendar: 'Global Contributions Calendar',
    globalCalendarDesc: 'Aggregated commit heatmap across all tracked repositories over the past year',
    devTools: 'Developer Tools',
    devToolsDesc: 'Quick launch local code editors and IDEs',
    gitSystemInfo: 'Global Git Configuration',
    gitSystemInfoDesc: 'View and edit global configuration entries in ~/.gitconfig',
    gitVersion: 'Git Version',
    gitPath: 'Git Path',
    globalIdentity: 'Global Identity',
    trackedRepos: 'Tracked Repos',
    userName: 'User Name (user.name)',
    userEmail: 'Email (user.email)',
    coreEditor: 'Default Editor (core.editor)',
    defaultBranch: 'Default Branch (init.defaultBranch)',
    pullRebase: 'Pull Strategy (pull.rebase)',
    saveConfig: 'Save Global Config',
    configSaved: 'Global config saved',
    launchApp: 'Launch',
    appLaunched: 'Launched',
    allGlobalConfigs: 'All Global Configurations (Full List)',
    addConfigKey: 'Add Config',
    notSet: 'Not set',
    needsAttentionTitle: 'Repositories Needing Attention',
    needsAttentionDesc: 'Local repositories with unstaged changes, uncommitted files, or unsynced commits',
    reposNeedingAttentionCount: 'need attention',
    refreshStatus: 'Refresh',
    enterRepo: 'Open',
    clean: 'Clean',
    unstaged: 'Unstaged',
    staged: 'Staged',
    aheadLabel: 'Ahead',
    behindLabel: 'Behind',
    repoCleanTooltip: 'Working tree clean, in sync with upstream',
    unstagedFilesTooltip: 'modified files (unstaged)',
    stagedFilesTooltip: 'staged files (ready to commit)',
    untrackedFilesTooltip: 'untracked files',
    aheadCommitsTooltip: 'commits ahead (ready to push)',
    behindCommitsTooltip: 'commits behind (ready to pull)',
    city3dTitle: '3D City Aerial Tour',
    city3dCruise: 'Auto Cruise',
    city3dCruisePaused: 'Flight Paused',
    city3dDay: 'Day Mode',
    city3dNight: 'Night Mode',
    city3dZenMode: 'Zen 3D View',
    city3dOverviewMode: 'Show Overview',
    city3dEnterRepo: 'Enter Repository',
    city3dBuildings: 'Buildings (Text Files)',
    city3dGreenSpace: 'Green Space (Assets)',
    city3dTallest: 'Tallest Building (Largest File)',
    city3dWeather: 'Toggle Weather',
    city3dRain: 'Cyber Rain',
    city3dClear: 'Clear Sky'
  }
};
I18N.ja = Object.assign({}, I18N.en, {
  language: '言語',
  languageButton: '日本語',
  recentRepos: '最近のリポジトリ',
  closeSidebar: 'サイドバーを閉じる',
  toggleSidebar: 'サイドバーを切り替え',
  loading: '読み込み中...',
  settings: '設定',
  settingsIntro: 'GitWeb のアクセス制御、AI エージェントの設定など全般設定を管理します。',
  accessSettings: 'アクセス設定',
  installBanner: '⚠️ GMC Hooks がインストールされていません。Git hooks をインストールすると commit message を自動生成でき、git commit をどこからでも使えます。',
  installHooks: 'Hooks をインストール',
  currentBranch: '現在のブランチ',
  changedFiles: '変更されたファイル',
  workingTree: '作業ツリー',
  branchesTree: 'ブランチツリー',
  repositoryFiles: 'リポジトリファイル',
  fileTree: 'ファイルツリー',
  filesCount: '項目',
  noRepositoryFiles: 'このブランチに表示できるファイルはありません。',
  loadingFiles: 'ファイルを読み込み中...',
  loadingFile: 'ファイルを読み込み中...',
  fileLoadFailed: 'ファイルの読み込みに失敗しました: ',
  branchSwitchFailed: 'ブランチの切り替えに失敗しました: ',
  switchingBranch: 'ブランチを切り替え中...',
  localBranch: 'ローカル',
  remoteBranch: 'リモート',
  binaryFile: 'バイナリファイルはプレビューできません。',
  largeFile: 'このファイルは大きすぎるため直接プレビューを停止しました。',
  truncatedFile: '内容は切り詰められています',
  directory: 'ディレクトリ',
  file: 'ファイル',
  diffView: 'Diff ビュー',
  loadingDiff: 'Diff を読み込み中...',
  diffLoadFailed: 'Diff の読み込みに失敗しました: ',
  noDiff: '表示できる diff はありません。',
  openReadme: 'README を開く',
  commitGraph: 'コミットグラフ',
  recentHistory: '最近のリポジトリ履歴',
  accessSettingsIntro: 'LAN アクセス、アクセストークンの更新、現在ページ用 QR 入口を管理します。モバイル端末は長い token を入力せずにスキャンして初回アクセスできます。',
  back: '戻る',
  allowExternalAccess: '外部アクセスを許可',
  allowExternalAccessHelp: '有効にすると、ローカルネットワーク上の認証済み端末がこの GitWeb サービスにアクセスできます。この設定は GMC を実行しているホストでのみ変更できます。',
  externalAccess: '外部アクセス',
  refreshTokenTitle: 'Token を更新',
  refreshTokenHelp: '更新すると古い token は直ちに無効になります。接続済み端末は再スキャンまたは新しいリンクでアクセスする必要があります。',
  refreshToken: 'Token を更新',
  hostOnlyWarning: 'このページはホストマシンから開かれていないため、アクセス設定は読み取り専用です。',
  scanCurrentPage: 'スキャンしてこのページを開く',
  qrHelp: 'QR コードには現在ページの URL とアクセストークンが含まれます。信頼できる端末にのみ共有してください。',
  qrEnableExternal: '外部アクセスを有効にして QR コードを生成',
  copyUrl: 'URL をコピー',
  commit: 'コミット',
  copy: 'コピー',
  close: '閉じる',
  refreshTokenConfirmTitle: 'アクセストークンを更新',
  refreshTokenConfirmBody: '更新すると古い token は直ちに無効になります。すべての外部端末は新しい QR コードをスキャンするか、新しいリンクを開く必要があります。続行しますか？',
  cancel: 'キャンセル',
  confirmRefresh: '更新',
  selectRepositoryFirst: '先にリポジトリを選択してください',
  noRecentRepos: '最近のリポジトリはまだありません。',
  recentlyVisited: '最近アクセス',
  justNow: 'たった今',
  agoMinute: '分前',
  agoHour: '時間前',
  agoDay: '日前',
  noRepositorySelected: 'リポジトリが選択されていません',
  noUpstream: 'upstream なし',
  lanAddress: 'LAN アドレス: ',
  qrNeedExternal: 'モバイル端末から開く前に外部アクセスを有効にしてください。',
  qrGenerating: 'QR コードを生成中...',
  qrReady: 'QR コードには現在ページの URL と 1 回分のアクセストークンが含まれています。',
  qrFailed: 'QR コード生成に失敗しました',
  copyLinkFallback: '下のリンクをコピーしてモバイル端末へ送信してください。',
  linkCopied: 'アクセスリンクをコピーしました。',
  refreshInProgress: 'アクセストークンを更新中...',
  refreshDone: '古い token は無効になりました。新しい token は新しい QR コードをスキャンするか、新しいリンクを開いて使用してください。',
  refreshFailed: 'Token の更新に失敗しました: ',
  refreshButtonWorking: '更新中...',
  disableExternalConfirm: '外部アクセスを無効にしますか？\\n\\n無効にすると、GitWeb サービスを実行しているマシンからのみ再度有効にできます。',
  updateExternalFailed: '外部アクセス設定の更新に失敗しました: ',
  openFinderFailed: 'Finder で開けませんでした: ',
  finderLocalOnly: 'Finder で開く操作は 127.0.0.1 からのアクセス時のみ利用できます。',
  openTerminal: 'ターミナルで開く',
  openTerminalPrefix: 'ターミナルで開く: ',
  terminalLocalOnly: 'ターミナルを開く操作は 127.0.0.1 からのアクセス時のみ利用できます。',
  openTerminalFailed: 'ターミナルを開けませんでした: ',
  cleanWorkingTree: '作業ツリーはクリーンです。',
  modifiedFiles: '変更済み',
  stagedFiles: 'ステージ済み',
  noModifiedFiles: '未ステージの変更はありません。',
  noStagedFiles: 'ステージ済みの変更はありません。',
  all: 'すべて',
  restore: '復元',
  ignore: '無視',
  stage: 'ステージ',
  staging: 'ステージ中...',
  unstage: 'ステージ解除',
  unstaging: '解除中...',
  stagingSelected: '選択したファイルをステージしています...',
  unstagingSelected: '選択したファイルのステージを解除しています...',
  stagedPrefix: '',
  stagedSuffix: ' 件をステージしました。',
  unstagedPrefix: '',
  unstagedSuffix: ' 件のステージを解除しました。',
  selected: '選択済み',
  committing: 'コミット中...',
  ignoring: '無視中...',
  restoring: '復元中...',
  commitSelected: 'コミット',
  installing: 'インストール中...',
  installed: 'インストール済み',
  installFailed: 'インストール失敗',
  installFailedPrefix: 'インストールに失敗しました: ',
  working: '処理中...',
  successPrefix: '成功: ',
  errorPrefix: 'エラー: ',
  noBranches: 'ブランチがありません。',
  noCommits: 'まだコミットがありません。',
  noSubject: '件名なし',
  aiGenerating: 'AI が commit message を生成中',
  commitDetail: 'コミット詳細',
  copied: 'コピーしました',
  selectTextAndCopy: 'テキストを選択してコピーしてください',
  repoRunning: 'GMC GitWeb は実行中です。状態を表示するには git リポジトリで "gmc web" を実行してください。',
  openInFinderPrefix: 'Finder で開く: ',
  removeFromRecent: '最近の一覧から削除',
  removeFromRecentAriaSuffix: '最近のリポジトリから削除',
  loadingStatusErrorPrefix: '状態の読み込みエラー: ',
  pushing: 'Push 中...',
  pulling: 'Pull 中...',
  commitsOn: '回のコミット:',
  commitsGlobalOnly: '全リポジトリで {global} 回のコミット: {date}',
  commitsCurrentAndGlobal: '当プロジェクトで {current} 回（全体で {global} 回）のコミット: {date}',
  installHooksConfirm: 'GMC Git Hooks がインストールされていません！\\n\\nHooks をインストールすると、git commit -m gmc ごとに AI 支援の commit message 生成が自動で実行されます。\\n\\n「OK」で hooks をインストールしてコミットします\\n「キャンセル」で今回は AI による直接生成を使います（遅め）',
  installingHooks: 'Hooks をインストール中...',
  hookInstallFailedPrefix: 'Hook のインストールに失敗しました: ',
  commitWithHooksStatus: '選択したファイルをコミット中...',
  commitWithAiStatus: 'AI commit message を生成してコミット中...',
  committedSelected: '選択したファイルをコミットしました。',
  ignoringSelected: '選択したファイルを無視中...',
  ignoreRulesAddedSuffix: ' 件の ignore ルールを .gitignore に追加しました。',
  restoreConfirmPrefix: '変更を破棄しますか？対象ファイル数: ',
  restoreConfirmSuffix: ' 件',
  restoringSelected: '選択したファイルを復元中...',
  restoredPrefix: '復元しました: ',
  restoredSuffix: ' 件。',
  taskView: 'タスク',
  taskBoardTitle: 'リポジトリタスクボード',
  taskBoardIntro: 'タスクは .gmc/tasks に保存されます。未着手のタスクを Codex、Claude、Antigravity の列に移すと、対応する Agent が起動します。',
  tasksCount: '件のタスク',
  taskStorage: '保存先',
  refreshTasks: '更新',
  newTask: '新規タスク',
  taskContent: '内容',
  taskDetails: 'タスクの詳細',
  taskContentPlaceholder: 'タスク内容、背景、受け入れ条件を書いてください。Markdown に対応しています。',
  startSpeechInput: '音声入力を開始',
  stopSpeechInput: '音声入力を停止',
  speechReady: 'マイクをクリックして音声入力を開始します。音声は保存されません。',
  speechUnsupported: 'このブラウザーは音声認識に対応していません。キーボード入力を使用してください。',
  speechStarting: 'マイクへのアクセスを要求しています...',
  speechListening: '音声をリアルタイムで認識しています...',
  speechStopping: '音声認識を終了しています...',
  speechPermissionDenied: 'マイクを使用できません。ブラウザーでマイクへのアクセスを許可してください。',
  speechMicrophoneUnavailable: '利用可能なマイクが見つかりません。',
  speechNoSpeech: '音声を認識できませんでした。もう一度お試しください。',
  speechNetworkError: '音声認識サービスを利用できません。後でもう一度お試しください。',
  speechLanguageUnsupported: '現在の言語では音声認識を利用できません。',
  speechFailed: '音声認識に失敗しました。もう一度お試しください。',
  speechContentLimit: 'タスク内容の文字数上限に達しました。',
  holdToTalk: '0.4秒長押しして話す',
  createTask: 'タスクを作成',
  creatingTask: '作成中...',
  decomposeTask: 'AI で自動分解',
  decomposingTask: '分解中...',
  loadingTasks: 'タスクを読み込み中...',
  taskLoadFailed: 'タスクの読み込みに失敗しました: ',
  taskCreateFailed: 'タスクの作成に失敗しました: ',
  taskDecomposeFailed: 'タスクの分解に失敗しました: ',
  taskUpdateFailed: 'タスクの更新に失敗しました: ',
  noTasksInColumn: 'この列にはまだタスクがありません',
  noRepoForTasks: 'タスクボードを使う前に Git リポジトリを選択してください。',
  taskStatusTodo: '未着手',
  taskStatusCodex: 'Codex',
  taskStatusClaude: 'Claude',
  taskStatusAntigravity: 'Antigravity',
  taskStatusDoing: '進行中',
  taskStatusReview: 'レビュー',
  taskStatusDone: '完了',
  agentMonitorLoading: '実行状態を読み込み中...',
  agentMonitorWorking: '実行中',
  agentMonitorIdle: '待機中',
  agentMonitorPaused: '操作が必要',
  agentMonitorStopped: '未実行',
  agentMonitorUnavailable: 'モニターを利用できません',
  agentMonitorTimeout: 'モニターがタイムアウトしました',
  agentMonitorUnknown: '状態不明',
  agentMonitorProcesses: 'プロセス',
  agentMonitorMemory: 'メモリ',
  agentMonitorUptime: '最長実行時間',
  agentMonitorDays: '日',
  agentMonitorHours: '時間',
  agentMonitorMinutes: '分',
  agentMonitorSeconds: '秒',
  moveTaskLeft: '左へ移動',
  moveTaskRight: '右へ移動',
  taskUpdatedJustNow: 'たった今更新',
  taskContentEmpty: '内容はまだありません。タスク作成時に背景や受け入れ条件を追加できます。',
  deleteTask: 'タスクを削除',
  deleteTaskConfirmPrefix: 'タスクを削除しますか: ',
  deleteTaskConfirmSuffix: '?\\n\\nリポジトリ内のタスクファイルが削除されます。',
  taskDeleteFailed: 'タスクの削除に失敗しました: ',
  taskDetail: 'タスク詳細',
  editTask: '編集',
  saveTask: '保存',
  savingTask: '保存中...',
  taskSaveFailed: 'タスクの保存に失敗しました: ',
  agentSettings: 'Agent 設定',
  agentSettingsHelp: 'コミットメッセージ生成とタスク開発に使用する AI エージェントを個別に選択します。',
  commitAgentSetting: 'コミットメッセージ Agent',
  commitAgentSettingHelp: 'コミットメッセージの生成に使用します。',
  taskAgentSetting: 'タスク Agent',
  taskAgentSettingHelp: 'リポジトリタスクの自動分解に使う既定の Agent です。',
  repositoryTaskAgentSetting: 'タスク分解 Agent',
  agentSettingSaved: 'Agent 設定を保存しました',
  agentSettingSaveFailed: 'Agent 設定の保存に失敗しました: ',
  needsAttentionTitle: '対応が必要なリポジトリ',
  needsAttentionDesc: '未ステージの変更、未コミット、または未同期のローカルリポジトリ',
  reposNeedingAttentionCount: '件の要確認',
  refreshStatus: '状態更新',
  enterRepo: 'ワークスペースへ',
  clean: 'クリーン',
  unstaged: '未ステージ',
  staged: 'ステージ済',
  aheadLabel: '先行',
  behindLabel: '遅延',
  repoCleanTooltip: '作業ツリーはクリーンでリモートと同期済み',
  unstagedFilesTooltip: '個の変更ファイル (未ステージ)',
  stagedFilesTooltip: '個のステージ済みファイル',
  untrackedFilesTooltip: '個の未追跡ファイル',
  aheadCommitsTooltip: 'コミット先行 (プッシュ可能)',
  behindCommitsTooltip: 'コミット遅延 (プル可能)'
});
I18N.ko = Object.assign({}, I18N.en, {
  language: '언어',
  languageButton: '한국어',
  recentRepos: '최근 저장소',
  closeSidebar: '사이드바 닫기',
  toggleSidebar: '사이드바 전환',
  loading: '불러오는 중...',
  settings: '설정',
  settingsIntro: 'GitWeb 접근 제어, AI 에이전트 설정 등 전역 설정을 관리합니다.',
  accessSettings: '접근 설정',
  installBanner: '⚠️ GMC Hooks가 설치되어 있지 않습니다. Git hooks를 설치하면 commit message를 자동으로 생성할 수 있고 git commit을 어디서나 사용할 수 있습니다.',
  installHooks: 'Hooks 설치',
  currentBranch: '현재 브랜치',
  changedFiles: '변경된 파일',
  workingTree: '작업 트리',
  branchesTree: '브랜치 트리',
  repositoryFiles: '저장소 파일',
  fileTree: '파일 트리',
  filesCount: '항목',
  noRepositoryFiles: '이 브랜치에 표시할 파일이 없습니다.',
  loadingFiles: '파일을 불러오는 중...',
  loadingFile: '파일을 불러오는 중...',
  fileLoadFailed: '파일을 불러오지 못했습니다: ',
  branchSwitchFailed: '브랜치 전환 실패: ',
  switchingBranch: '브랜치 전환 중...',
  localBranch: '로컬',
  remoteBranch: '원격',
  binaryFile: '바이너리 파일은 미리 볼 수 없습니다.',
  largeFile: '파일이 너무 커서 직접 미리보기를 중단했습니다.',
  truncatedFile: '내용이 잘렸습니다',
  directory: '디렉터리',
  file: '파일',
  diffView: 'Diff 보기',
  loadingDiff: 'Diff를 불러오는 중...',
  diffLoadFailed: 'Diff를 불러오지 못했습니다: ',
  noDiff: '표시할 diff가 없습니다.',
  openReadme: 'README 열기',
  commitGraph: '커밋 그래프',
  recentHistory: '최근 저장소 기록',
  accessSettingsIntro: 'LAN 접근, 접근 token 갱신, 현재 페이지용 QR 진입점을 관리합니다. 모바일 기기는 긴 token을 입력하지 않고 스캔해서 첫 접근할 수 있습니다.',
  back: '뒤로',
  allowExternalAccess: '외부 접근 허용',
  allowExternalAccessHelp: '활성화하면 로컬 네트워크의 인증된 기기가 이 GitWeb 서비스에 접근할 수 있습니다. 이 설정은 GMC를 실행 중인 호스트에서만 변경할 수 있습니다.',
  externalAccess: '외부 접근',
  refreshTokenTitle: 'Token 갱신',
  refreshTokenHelp: '갱신하면 이전 token은 즉시 만료됩니다. 연결된 기기는 다시 스캔하거나 새 링크로 접속해야 합니다.',
  refreshToken: 'Token 갱신',
  hostOnlyWarning: '이 페이지는 호스트 컴퓨터에서 열리지 않았으므로 접근 설정은 읽기 전용입니다.',
  scanCurrentPage: '스캔하여 이 페이지 열기',
  qrHelp: 'QR 코드에는 현재 페이지 URL과 접근 token이 포함됩니다. 신뢰할 수 있는 기기에만 공유하세요.',
  qrEnableExternal: '외부 접근을 켜서 QR 코드 생성',
  copyUrl: 'URL 복사',
  commit: '커밋',
  copy: '복사',
  close: '닫기',
  refreshTokenConfirmTitle: '접근 token 갱신',
  refreshTokenConfirmBody: '갱신하면 이전 token은 즉시 만료됩니다. 모든 외부 기기는 새 QR 코드를 스캔하거나 복사된 새 링크를 열어야 합니다. 계속할까요?',
  cancel: '취소',
  confirmRefresh: '갱신',
  selectRepositoryFirst: '먼저 저장소를 선택하세요',
  noRecentRepos: '최근 저장소가 아직 없습니다.',
  recentlyVisited: '최근 방문',
  justNow: '방금',
  agoMinute: '분 전',
  agoHour: '시간 전',
  agoDay: '일 전',
  noRepositorySelected: '선택된 저장소 없음',
  noUpstream: 'upstream 없음',
  lanAddress: 'LAN 주소: ',
  qrNeedExternal: '모바일 기기에서 열기 전에 외부 접근을 활성화하세요.',
  qrGenerating: 'QR 코드 생성 중...',
  qrReady: 'QR 코드에는 현재 페이지 URL과 1회 접근 token이 포함됩니다.',
  qrFailed: 'QR 코드 생성 실패',
  copyLinkFallback: '아래 링크를 복사해 모바일 기기로 보내세요.',
  linkCopied: '접근 링크가 복사되었습니다.',
  refreshInProgress: '접근 token 갱신 중...',
  refreshDone: '이전 token은 만료되었습니다. 새 QR 코드를 스캔하거나 새 링크를 열어 새 token을 사용하세요.',
  refreshFailed: 'Token 갱신 실패: ',
  refreshButtonWorking: '갱신 중...',
  disableExternalConfirm: '외부 접근을 비활성화할까요?\\n\\n비활성화하면 GitWeb 서비스를 실행 중인 컴퓨터에서만 다시 활성화할 수 있습니다.',
  updateExternalFailed: '외부 접근 설정 업데이트 실패: ',
  openFinderFailed: 'Finder에서 열기 실패: ',
  finderLocalOnly: 'Finder에서 열기는 127.0.0.1에서 접속한 경우에만 사용할 수 있습니다.',
  openTerminal: '터미널에서 열기',
  openTerminalPrefix: '터미널에서 열기: ',
  terminalLocalOnly: '터미널 열기는 127.0.0.1에서 접속한 경우에만 사용할 수 있습니다.',
  openTerminalFailed: '터미널 열기 실패: ',
  cleanWorkingTree: '작업 트리가 깨끗합니다.',
  modifiedFiles: '수정됨',
  stagedFiles: '스테이지됨',
  noModifiedFiles: '스테이지되지 않은 변경 사항이 없습니다.',
  noStagedFiles: '스테이지된 변경 사항이 없습니다.',
  all: '전체',
  restore: '복원',
  ignore: '무시',
  stage: '스테이지',
  staging: '스테이지 중...',
  unstage: '스테이지 해제',
  unstaging: '해제 중...',
  stagingSelected: '선택한 파일을 스테이지하는 중...',
  unstagingSelected: '선택한 파일의 스테이지를 해제하는 중...',
  stagedPrefix: '',
  stagedSuffix: '개 파일을 스테이지했습니다.',
  unstagedPrefix: '',
  unstagedSuffix: '개 파일의 스테이지를 해제했습니다.',
  selected: '선택됨',
  committing: '커밋 중...',
  ignoring: '무시 중...',
  restoring: '복원 중...',
  commitSelected: '커밋',
  installing: '설치 중...',
  installed: '설치됨',
  installFailed: '설치 실패',
  installFailedPrefix: '설치 실패: ',
  working: '처리 중...',
  successPrefix: '성공: ',
  errorPrefix: '오류: ',
  noBranches: '브랜치가 없습니다.',
  noCommits: '아직 커밋이 없습니다.',
  noSubject: '제목 없음',
  aiGenerating: 'AI가 commit message를 생성 중입니다',
  commitDetail: '커밋 상세',
  copied: '복사됨',
  selectTextAndCopy: '텍스트를 선택한 뒤 복사하세요',
  repoRunning: 'GMC GitWeb이 실행 중입니다. 상태를 보려면 git 저장소에서 "gmc web"을 실행하세요.',
  openInFinderPrefix: 'Finder에서 열기: ',
  removeFromRecent: '최근 목록에서 제거',
  removeFromRecentAriaSuffix: '최근 저장소에서 제거',
  loadingStatusErrorPrefix: '상태 불러오기 오류: ',
  pushing: 'Push 중...',
  pulling: 'Pull 중...',
  commitsOn: '커밋:',
  commitsGlobalOnly: '전체 저장소 총 {global}회 커밋: {date}',
  commitsCurrentAndGlobal: '현재 프로젝트 {current}회 (전체 {global}회) 커밋: {date}',
  installHooksConfirm: 'GMC Git Hooks가 설치되어 있지 않습니다!\\n\\nHooks를 설치하면 git commit -m gmc마다 AI 지원 commit message 생성이 자동으로 실행됩니다.\\n\\n"확인"을 누르면 hooks를 설치하고 커밋합니다\\n"취소"를 누르면 이번에는 AI가 직접 commit message를 생성합니다(느림)',
  installingHooks: 'Hooks 설치 중...',
  hookInstallFailedPrefix: 'Hook 설치 실패: ',
  commitWithHooksStatus: '선택한 파일 커밋 중...',
  commitWithAiStatus: 'AI commit message를 생성하고 커밋 중...',
  committedSelected: '선택한 파일을 커밋했습니다.',
  ignoringSelected: '선택한 파일 무시 중...',
  ignoreRulesAddedSuffix: '개의 ignore 규칙이 .gitignore에 추가되었습니다.',
  restoreConfirmPrefix: '변경 사항을 버릴까요? 파일 수: ',
  restoreConfirmSuffix: '개',
  restoringSelected: '선택한 파일 복원 중...',
  restoredPrefix: '복원됨: ',
  restoredSuffix: '개.',
  taskView: '작업',
  taskBoardTitle: '저장소 작업 보드',
  taskBoardIntro: '작업은 .gmc/tasks에 저장됩니다. 할 일 작업을 Codex, Claude 또는 Antigravity 열로 옮기면 해당 Agent가 시작됩니다.',
  tasksCount: '개 작업',
  taskStorage: '저장 위치',
  refreshTasks: '새로고침',
  newTask: '새 작업',
  taskContent: '내용',
  taskDetails: '작업 상세',
  taskContentPlaceholder: '작업 내용, 배경 또는 인수 조건을 적으세요. Markdown을 지원합니다.',
  startSpeechInput: '음성 입력 시작',
  stopSpeechInput: '음성 입력 중지',
  speechReady: '마이크를 클릭해 음성 입력을 시작하세요. 오디오는 저장되지 않습니다.',
  speechUnsupported: '이 브라우저는 웹 음성 인식을 지원하지 않습니다. 키보드를 사용하세요.',
  speechStarting: '마이크 권한 요청 중...',
  speechListening: '음성을 실시간으로 인식 중...',
  speechStopping: '음성 인식 종료 중...',
  speechPermissionDenied: '마이크를 사용할 수 없습니다. 브라우저에서 마이크 권한을 허용하세요.',
  speechMicrophoneUnavailable: '사용 가능한 마이크를 찾을 수 없습니다.',
  speechNoSpeech: '음성이 인식되지 않았습니다. 다시 시도하세요.',
  speechNetworkError: '음성 인식 서비스를 사용할 수 없습니다. 나중에 다시 시도하세요.',
  speechLanguageUnsupported: '현재 언어에서는 음성 인식을 사용할 수 없습니다.',
  speechFailed: '음성 인식에 실패했습니다. 다시 시도하세요.',
  speechContentLimit: '작업 내용 길이 제한에 도달했습니다.',
  holdToTalk: '0.4초 길게 눌러 말하기',
  createTask: '작업 만들기',
  creatingTask: '만드는 중...',
  decomposeTask: 'AI 자동 분해',
  decomposingTask: '분해 중...',
  loadingTasks: '작업 불러오는 중...',
  taskLoadFailed: '작업을 불러오지 못했습니다: ',
  taskCreateFailed: '작업을 만들지 못했습니다: ',
  taskDecomposeFailed: '작업 분해 실패: ',
  taskUpdateFailed: '작업을 업데이트하지 못했습니다: ',
  noTasksInColumn: '이 열에는 아직 작업이 없습니다',
  noRepoForTasks: '작업 보드를 사용하기 전에 Git 저장소를 선택하세요.',
  taskStatusTodo: '할 일',
  taskStatusCodex: 'Codex',
  taskStatusClaude: 'Claude',
  taskStatusAntigravity: 'Antigravity',
  taskStatusDoing: '진행 중',
  taskStatusReview: '검토',
  taskStatusDone: '완료',
  agentMonitorLoading: '실행 상태 불러오는 중...',
  agentMonitorWorking: '작업 중',
  agentMonitorIdle: '대기 중',
  agentMonitorPaused: '사용자 작업 필요',
  agentMonitorStopped: '실행 안 됨',
  agentMonitorUnavailable: '모니터를 사용할 수 없음',
  agentMonitorTimeout: '모니터 시간 초과',
  agentMonitorUnknown: '알 수 없는 상태',
  agentMonitorProcesses: '프로세스',
  agentMonitorMemory: '메모리',
  agentMonitorUptime: '최장 실행 시간',
  agentMonitorDays: '일',
  agentMonitorHours: '시간',
  agentMonitorMinutes: '분',
  agentMonitorSeconds: '초',
  moveTaskLeft: '왼쪽으로 이동',
  moveTaskRight: '오른쪽으로 이동',
  taskUpdatedJustNow: '방금 업데이트됨',
  taskContentEmpty: '아직 내용이 없습니다. 작업을 만들 때 배경이나 인수 조건을 추가할 수 있습니다.',
  deleteTask: '작업 삭제',
  deleteTaskConfirmPrefix: '작업을 삭제할까요: ',
  deleteTaskConfirmSuffix: '?\\n\\n저장소의 작업 파일이 제거됩니다.',
  taskDeleteFailed: '작업 삭제 실패: ',
  taskDetail: '작업 상세',
  editTask: '편집',
  saveTask: '저장',
  savingTask: '저장 중...',
  taskSaveFailed: '작업 저장 실패: ',
  agentSettings: 'Agent 설정',
  agentSettingsHelp: '커밋 메시지 생성과 작업 개발에 사용할 AI 에이전트를 각각 선택합니다.',
  commitAgentSetting: '커밋 메시지 Agent',
  commitAgentSettingHelp: '커밋 메시지를 생성할 때 사용합니다.',
  taskAgentSetting: '작업 Agent',
  taskAgentSettingHelp: '저장소 작업 자동 분해의 기본 Agent로 사용합니다.',
  repositoryTaskAgentSetting: '작업 분해 Agent',
  agentSettingSaved: 'Agent 설정이 저장되었습니다',
  agentSettingSaveFailed: 'Agent 설정 저장 실패: ',
  needsAttentionTitle: '확인이 필요한 저장소',
  needsAttentionDesc: '미스테이징 변경, 미커밋 또는 동기화되지 않은 로컬 저장소',
  reposNeedingAttentionCount: '개 확인 필요',
  refreshStatus: '상태 새로고침',
  enterRepo: '작업 공간 열기',
  clean: '정상',
  unstaged: '미스테이징',
  staged: '스테이징됨',
  aheadLabel: '앞섬',
  behindLabel: '뒤처짐',
  repoCleanTooltip: '작업 공간이 깨끗하고 원격과 동기화됨',
  unstagedFilesTooltip: '개 파일 수정됨 (미스테이징)',
  stagedFilesTooltip: '개 파일 스테이징됨',
  untrackedFilesTooltip: '개 추적 안 된 파일',
  aheadCommitsTooltip: '개 커밋 앞섬 (푸시 필요)',
  behindCommitsTooltip: '개 커밋 뒤처짐 (풀 필요)'
});
I18N.es = Object.assign({}, I18N.en, {
  language: 'Idioma',
  languageButton: 'ES',
  recentRepos: 'Repositorios recientes',
  closeSidebar: 'Cerrar barra lateral',
  toggleSidebar: 'Alternar barra lateral',
  loading: 'Cargando...',
  settings: 'Ajustes',
  settingsIntro: 'Gestiona el control de acceso de GitWeb, preferencias del agente de IA y otros ajustes globales.',
  accessSettings: 'Ajustes de acceso',
  installBanner: '⚠️ GMC Hooks no está instalado. Instalar Git hooks permite generar commit messages automáticamente y usar git commit desde cualquier lugar.',
  installHooks: 'Instalar Hooks',
  currentBranch: 'Rama actual',
  changedFiles: 'archivos cambiados',
  workingTree: 'Árbol de trabajo',
  branchesTree: 'Árbol de ramas',
  repositoryFiles: 'Archivos del repositorio',
  fileTree: 'Árbol de archivos',
  filesCount: 'elementos',
  noRepositoryFiles: 'No hay archivos para mostrar en esta rama.',
  loadingFiles: 'Cargando archivos...',
  loadingFile: 'Cargando archivo...',
  fileLoadFailed: 'Error al cargar el archivo: ',
  branchSwitchFailed: 'Error al cambiar de rama: ',
  switchingBranch: 'Cambiando de rama...',
  localBranch: 'local',
  remoteBranch: 'remota',
  binaryFile: 'La vista previa de archivos binarios no está disponible.',
  largeFile: 'Este archivo es demasiado grande para previsualizarlo directamente.',
  truncatedFile: 'Contenido truncado',
  directory: 'Directorio',
  file: 'Archivo',
  diffView: 'Vista Diff',
  loadingDiff: 'Cargando diff...',
  diffLoadFailed: 'Error al cargar diff: ',
  noDiff: 'No hay diff para mostrar.',
  openReadme: 'Abrir README',
  commitGraph: 'Grafo de commits',
  recentHistory: 'Historial reciente del repositorio',
  accessSettingsIntro: 'Gestiona el acceso LAN, actualiza el token de acceso y genera una entrada QR para la página actual. Los dispositivos móviles pueden escanearla para entrar sin escribir un token largo.',
  back: 'Atrás',
  allowExternalAccess: 'Permitir acceso externo',
  allowExternalAccessHelp: 'Cuando está activado, los dispositivos autenticados de tu red local pueden acceder a este servicio GitWeb. Solo puede cambiarse desde el equipo host que ejecuta GMC.',
  externalAccess: 'Acceso externo',
  refreshTokenTitle: 'Actualizar token',
  refreshTokenHelp: 'Actualizar invalida inmediatamente el token anterior. Los dispositivos conectados deben escanear de nuevo o abrir el nuevo enlace.',
  refreshToken: 'Actualizar token',
  hostOnlyWarning: 'Esta página no se abrió desde el equipo host, por lo que los ajustes de acceso son de solo lectura.',
  scanCurrentPage: 'Escanear para abrir esta página',
  qrHelp: 'El código QR contiene la URL de la página actual y el token de acceso. Compártelo solo con dispositivos de confianza.',
  qrEnableExternal: 'Activa el acceso externo para generar un QR',
  copyUrl: 'Copiar URL',
  commit: 'Commit',
  copy: 'Copiar',
  close: 'Cerrar',
  refreshTokenConfirmTitle: 'Actualizar token de acceso',
  refreshTokenConfirmBody: 'Actualizar invalida inmediatamente el token anterior. Todos los dispositivos externos deben escanear el nuevo QR o abrir el nuevo enlace copiado. ¿Continuar?',
  cancel: 'Cancelar',
  confirmRefresh: 'Actualizar',
  selectRepositoryFirst: 'Selecciona primero un repositorio',
  noRecentRepos: 'Aún no hay repositorios recientes.',
  recentlyVisited: 'Visitado recientemente',
  justNow: 'Ahora mismo',
  agoMinute: 'min atrás',
  agoHour: 'h atrás',
  agoDay: 'd atrás',
  noRepositorySelected: 'No hay repositorio seleccionado',
  noUpstream: 'Sin upstream',
  lanAddress: 'Dirección LAN: ',
  qrNeedExternal: 'Activa el acceso externo antes de abrir esta página desde un dispositivo móvil.',
  qrGenerating: 'Generando código QR...',
  qrReady: 'El código QR contiene la URL actual y un token de acceso.',
  qrFailed: 'Error al generar el código QR',
  copyLinkFallback: 'Copia el enlace siguiente y envíalo al dispositivo móvil.',
  linkCopied: 'Enlace de acceso copiado.',
  refreshInProgress: 'Actualizando token de acceso...',
  refreshDone: 'El token anterior ya no es válido. Usa el nuevo token escaneando el nuevo QR o abriendo el nuevo enlace copiado.',
  refreshFailed: 'Error al actualizar token: ',
  refreshButtonWorking: 'Actualizando...',
  disableExternalConfirm: '¿Seguro que quieres desactivar el acceso externo?\\n\\nUna vez desactivado, solo podrá reactivarse desde el equipo donde se ejecuta GitWeb.',
  updateExternalFailed: 'Error al actualizar los ajustes de acceso externo: ',
  openFinderFailed: 'Error al abrir en Finder: ',
  finderLocalOnly: 'Abrir en Finder solo está disponible desde 127.0.0.1.',
  openTerminal: 'Abrir en Terminal',
  openTerminalPrefix: 'Abrir en Terminal: ',
  terminalLocalOnly: 'Abrir Terminal solo está disponible desde 127.0.0.1.',
  openTerminalFailed: 'Error al abrir Terminal: ',
  cleanWorkingTree: 'Árbol de trabajo limpio.',
  modifiedFiles: 'Modificados',
  stagedFiles: 'Preparados',
  noModifiedFiles: 'No hay cambios sin preparar.',
  noStagedFiles: 'No hay cambios preparados.',
  all: 'Todo',
  restore: 'Restaurar',
  ignore: 'Ignorar',
  stage: 'Preparar',
  staging: 'Preparando...',
  unstage: 'Quitar de preparados',
  unstaging: 'Quitando...',
  stagingSelected: 'Preparando archivos seleccionados...',
  unstagingSelected: 'Quitando archivos seleccionados de preparados...',
  stagedPrefix: 'Se prepararon ',
  stagedSuffix: ' archivo(s).',
  unstagedPrefix: 'Se quitaron ',
  unstagedSuffix: ' archivo(s) de preparados.',
  selected: 'seleccionado',
  committing: 'Haciendo commit...',
  ignoring: 'Ignorando...',
  restoring: 'Restaurando...',
  commitSelected: 'Commit',
  installing: 'Instalando...',
  installed: 'Instalado',
  installFailed: 'Instalación fallida',
  installFailedPrefix: 'Instalación fallida: ',
  working: 'Procesando...',
  successPrefix: 'Éxito: ',
  errorPrefix: 'Error: ',
  noBranches: 'No hay ramas.',
  noCommits: 'Aún no hay commits.',
  noSubject: 'sin asunto',
  aiGenerating: 'La IA está generando un commit message',
  commitDetail: 'Detalle del commit',
  copied: 'Copiado',
  selectTextAndCopy: 'Selecciona el texto y copia',
  repoRunning: 'GMC GitWeb está en ejecución. Usa "gmc web" en un repositorio git para ver su estado.',
  openInFinderPrefix: 'Abrir en Finder: ',
  removeFromRecent: 'Eliminar de recientes',
  removeFromRecentAriaSuffix: 'de repositorios recientes',
  loadingStatusErrorPrefix: 'Error al cargar estado: ',
  pushing: 'Haciendo push...',
  pulling: 'Haciendo pull...',
  commitsOn: 'commits el',
  commitsGlobalOnly: '{global} commits en todos los repositorios el {date}',
  commitsCurrentAndGlobal: '{current} commits en el repo actual ({global} en total) el {date}',
  installHooksConfirm: '¡GMC Git Hooks no está instalado!\\n\\nDespués de instalar hooks, cada git commit -m gmc activará automáticamente la generación asistida por IA del commit message.\\n\\nPulsa "Aceptar" para instalar hooks y hacer commit\\nPulsa "Cancelar" para generar el commit message directamente con IA esta vez (más lento)',
  installingHooks: 'Instalando hooks...',
  hookInstallFailedPrefix: 'Error al instalar hook: ',
  commitWithHooksStatus: 'Haciendo commit de los archivos seleccionados...',
  commitWithAiStatus: 'Generando commit message con IA y haciendo commit...',
  committedSelected: 'Archivos seleccionados confirmados.',
  ignoringSelected: 'Ignorando archivos seleccionados...',
  ignoreRulesAddedSuffix: ' regla(s) ignore añadidas a .gitignore.',
  restoreConfirmPrefix: '¿Seguro que quieres descartar cambios en ',
  restoreConfirmSuffix: ' archivo(s)?',
  restoringSelected: 'Restaurando archivos seleccionados...',
  restoredPrefix: 'Restaurados ',
  restoredSuffix: ' archivo(s).',
  taskView: 'Tareas',
  taskBoardTitle: 'Tablero de tareas del repositorio',
  taskBoardIntro: 'Las tareas se guardan en .gmc/tasks. Mueve una tarea pendiente a Codex, Claude o Antigravity para iniciar ese agente.',
  tasksCount: 'tareas',
  taskStorage: 'Almacenamiento',
  refreshTasks: 'Actualizar',
  newTask: 'Nueva tarea',
  taskContent: 'Contenido',
  taskDetails: 'Detalles de la tarea',
  taskContentPlaceholder: 'Describe la tarea, el contexto o los criterios de aceptación. Se admite Markdown.',
  startSpeechInput: 'Iniciar entrada de voz',
  stopSpeechInput: 'Detener entrada de voz',
  speechReady: 'Pulsa el micrófono para iniciar la entrada de voz. El audio no se guarda.',
  speechUnsupported: 'Este navegador no admite reconocimiento de voz web. Usa el teclado.',
  speechStarting: 'Solicitando acceso al micrófono...',
  speechListening: 'Escuchando y transcribiendo en directo...',
  speechStopping: 'Finalizando la transcripción...',
  speechPermissionDenied: 'No se puede usar el micrófono. Permite el acceso en el navegador.',
  speechMicrophoneUnavailable: 'No se encontró ningún micrófono disponible.',
  speechNoSpeech: 'No se reconoció voz. Inténtalo de nuevo.',
  speechNetworkError: 'El servicio de reconocimiento no está disponible. Inténtalo más tarde.',
  speechLanguageUnsupported: 'El reconocimiento de voz no está disponible para el idioma actual.',
  speechFailed: 'Falló el reconocimiento de voz. Inténtalo de nuevo.',
  speechContentLimit: 'Se alcanzó el límite de contenido de la tarea.',
  holdToTalk: 'mantén 0,4 s para hablar',
  createTask: 'Crear tarea',
  creatingTask: 'Creando...',
  decomposeTask: 'Desglosar con IA',
  decomposingTask: 'Desglosando...',
  loadingTasks: 'Cargando tareas...',
  taskLoadFailed: 'Error al cargar tareas: ',
  taskCreateFailed: 'Error al crear tarea: ',
  taskDecomposeFailed: 'Error al desglosar la tarea: ',
  taskUpdateFailed: 'Error al actualizar tarea: ',
  noTasksInColumn: 'Aún no hay tareas en esta columna',
  noRepoForTasks: 'Selecciona un repositorio Git antes de usar el tablero de tareas.',
  taskStatusTodo: 'Pendiente',
  taskStatusCodex: 'Codex',
  taskStatusClaude: 'Claude',
  taskStatusAntigravity: 'Antigravity',
  taskStatusDoing: 'En curso',
  taskStatusReview: 'Revisión',
  taskStatusDone: 'Hecho',
  agentMonitorLoading: 'Cargando estado de ejecución...',
  agentMonitorWorking: 'Trabajando',
  agentMonitorIdle: 'Inactivo',
  agentMonitorPaused: 'Requiere interacción',
  agentMonitorStopped: 'Sin ejecutar',
  agentMonitorUnavailable: 'Monitor no disponible',
  agentMonitorTimeout: 'Tiempo de espera agotado',
  agentMonitorUnknown: 'Estado desconocido',
  agentMonitorProcesses: 'Procesos',
  agentMonitorMemory: 'Memoria',
  agentMonitorUptime: 'Mayor tiempo activo',
  agentMonitorDays: 'd',
  agentMonitorHours: 'h',
  agentMonitorMinutes: 'min',
  agentMonitorSeconds: 's',
  moveTaskLeft: 'Mover a la izquierda',
  moveTaskRight: 'Mover a la derecha',
  taskUpdatedJustNow: 'Actualizado ahora mismo',
  taskContentEmpty: 'Aún no hay contenido. Añade contexto o criterios de aceptación al crear una tarea.',
  deleteTask: 'Eliminar tarea',
  deleteTaskConfirmPrefix: '¿Eliminar tarea ',
  deleteTaskConfirmSuffix: '?\\n\\nEsto elimina el archivo de tarea del repositorio.',
  taskDeleteFailed: 'Error al eliminar tarea: ',
  taskDetail: 'Detalle de tarea',
  editTask: 'Editar',
  saveTask: 'Guardar',
  savingTask: 'Guardando...',
  taskSaveFailed: 'Error al guardar tarea: ',
  agentSettings: 'Ajustes del agente',
  agentSettingsHelp: 'Elige agentes de IA distintos para generar commit messages y desarrollar tareas.',
  commitAgentSetting: 'Agente de commit messages',
  commitAgentSettingHelp: 'Se usa para generar commit messages.',
  taskAgentSetting: 'Agente de tareas',
  taskAgentSettingHelp: 'Se usa como agente predeterminado para desglosar tareas del repositorio.',
  repositoryTaskAgentSetting: 'Agente de desglose de tareas',
  agentSettingSaved: 'Ajuste del agente guardado',
  agentSettingSaveFailed: 'Error al guardar el ajuste del agente: '
});
I18N.fr = Object.assign({}, I18N.en, {
  language: 'Langue',
  languageButton: 'FR',
  recentRepos: 'Dépôts récents',
  closeSidebar: 'Fermer la barre latérale',
  toggleSidebar: 'Afficher/masquer la barre latérale',
  loading: 'Chargement...',
  settings: 'Paramètres',
  settingsIntro: 'Gérez le contrôle d’accès GitWeb, les préférences d’agent IA et d’autres paramètres globaux.',
  accessSettings: 'Paramètres d’accès',
  installBanner: '⚠️ GMC Hooks n’est pas installé. Installer les Git hooks permet de générer automatiquement les commit messages et d’utiliser git commit partout.',
  installHooks: 'Installer Hooks',
  currentBranch: 'Branche actuelle',
  changedFiles: 'fichiers modifiés',
  workingTree: 'Arbre de travail',
  branchesTree: 'Arbre des branches',
  repositoryFiles: 'Fichiers du dépôt',
  fileTree: 'Arborescence',
  filesCount: 'éléments',
  noRepositoryFiles: 'Aucun fichier à afficher sur cette branche.',
  loadingFiles: 'Chargement des fichiers...',
  loadingFile: 'Chargement du fichier...',
  fileLoadFailed: 'Échec du chargement du fichier : ',
  branchSwitchFailed: 'Échec du changement de branche : ',
  switchingBranch: 'Changement de branche...',
  localBranch: 'locale',
  remoteBranch: 'distante',
  binaryFile: 'L’aperçu des fichiers binaires n’est pas disponible.',
  largeFile: 'Ce fichier est trop volumineux pour un aperçu direct.',
  truncatedFile: 'Contenu tronqué',
  directory: 'Dossier',
  file: 'Fichier',
  diffView: 'Vue Diff',
  loadingDiff: 'Chargement du diff...',
  diffLoadFailed: 'Échec du chargement du diff : ',
  noDiff: 'Aucun diff à afficher.',
  openReadme: 'Ouvrir README',
  commitGraph: 'Graphe des commits',
  recentHistory: 'Historique récent du dépôt',
  accessSettingsIntro: 'Gérez l’accès LAN, actualisez le token d’accès et générez une entrée QR pour la page actuelle. Les appareils mobiles peuvent la scanner pour accéder sans saisir un long token.',
  back: 'Retour',
  allowExternalAccess: 'Autoriser l’accès externe',
  allowExternalAccessHelp: 'Une fois activé, les appareils authentifiés de votre réseau local peuvent accéder à ce service GitWeb. Ce réglage ne peut être modifié que depuis la machine hôte qui exécute GMC.',
  externalAccess: 'Accès externe',
  refreshTokenTitle: 'Actualiser le token',
  refreshTokenHelp: 'L’actualisation invalide immédiatement l’ancien token. Les appareils connectés devront scanner à nouveau ou ouvrir le nouveau lien.',
  refreshToken: 'Actualiser le token',
  hostOnlyWarning: 'Cette page n’a pas été ouverte depuis la machine hôte, les paramètres d’accès sont donc en lecture seule.',
  scanCurrentPage: 'Scanner pour ouvrir cette page',
  qrHelp: 'Le QR code contient l’URL de la page actuelle et le token d’accès. Ne le partagez qu’avec des appareils de confiance.',
  qrEnableExternal: 'Activez l’accès externe pour générer un QR code',
  copyUrl: 'Copier l’URL',
  commit: 'Commit',
  copy: 'Copier',
  close: 'Fermer',
  refreshTokenConfirmTitle: 'Actualiser le token d’accès',
  refreshTokenConfirmBody: 'L’actualisation invalide immédiatement l’ancien token. Tous les appareils externes devront scanner le nouveau QR code ou ouvrir le nouveau lien copié. Continuer ?',
  cancel: 'Annuler',
  confirmRefresh: 'Actualiser',
  selectRepositoryFirst: 'Sélectionnez d’abord un dépôt',
  noRecentRepos: 'Aucun dépôt récent pour le moment.',
  recentlyVisited: 'Visité récemment',
  justNow: 'À l’instant',
  agoMinute: 'min',
  agoHour: 'h',
  agoDay: 'j',
  noRepositorySelected: 'Aucun dépôt sélectionné',
  noUpstream: 'Aucun upstream',
  lanAddress: 'Adresse LAN : ',
  qrNeedExternal: 'Activez l’accès externe avant d’ouvrir cette page depuis un appareil mobile.',
  qrGenerating: 'Génération du QR code...',
  qrReady: 'Le QR code contient l’URL actuelle et un token d’accès.',
  qrFailed: 'Échec de génération du QR code',
  copyLinkFallback: 'Copiez le lien ci-dessous et envoyez-le à l’appareil mobile.',
  linkCopied: 'Lien d’accès copié.',
  refreshInProgress: 'Actualisation du token d’accès...',
  refreshDone: 'L’ancien token est invalide. Utilisez le nouveau token en scannant le nouveau QR code ou en ouvrant le nouveau lien copié.',
  refreshFailed: 'Échec d’actualisation du token : ',
  refreshButtonWorking: 'Actualisation...',
  disableExternalConfirm: 'Voulez-vous vraiment désactiver l’accès externe ?\\n\\nUne fois désactivé, ce réglage ne pourra être réactivé que depuis la machine où le service GitWeb s’exécute.',
  updateExternalFailed: 'Échec de mise à jour des paramètres d’accès externe : ',
  openFinderFailed: 'Échec d’ouverture dans Finder : ',
  finderLocalOnly: 'L’ouverture dans Finder n’est disponible que depuis 127.0.0.1.',
  openTerminal: 'Ouvrir dans Terminal',
  openTerminalPrefix: 'Ouvrir dans Terminal : ',
  terminalLocalOnly: 'L’ouverture du Terminal n’est disponible que depuis 127.0.0.1.',
  openTerminalFailed: 'Échec d’ouverture du Terminal : ',
  cleanWorkingTree: 'Arbre de travail propre.',
  modifiedFiles: 'Modifiés',
  stagedFiles: 'Indexés',
  noModifiedFiles: 'Aucune modification non indexée.',
  noStagedFiles: 'Aucune modification indexée.',
  all: 'Tout',
  restore: 'Restaurer',
  ignore: 'Ignorer',
  stage: 'Indexer',
  staging: 'Indexation...',
  unstage: 'Désindexer',
  unstaging: 'Désindexation...',
  stagingSelected: 'Indexation des fichiers sélectionnés...',
  unstagingSelected: 'Désindexation des fichiers sélectionnés...',
  stagedPrefix: '',
  stagedSuffix: ' fichier(s) indexé(s).',
  unstagedPrefix: '',
  unstagedSuffix: ' fichier(s) désindexé(s).',
  selected: 'sélectionné',
  committing: 'Commit en cours...',
  ignoring: 'Ignore en cours...',
  restoring: 'Restauration...',
  commitSelected: 'Commit',
  installing: 'Installation...',
  installed: 'Installé',
  installFailed: 'Échec d’installation',
  installFailedPrefix: 'Échec d’installation : ',
  working: 'Traitement...',
  successPrefix: 'Succès : ',
  errorPrefix: 'Erreur : ',
  noBranches: 'Aucune branche.',
  noCommits: 'Aucun commit pour le moment.',
  noSubject: 'sans sujet',
  aiGenerating: 'L’IA génère un commit message',
  commitDetail: 'Détail du commit',
  copied: 'Copié',
  selectTextAndCopy: 'Sélectionnez le texte puis copiez',
  repoRunning: 'GMC GitWeb est en cours d’exécution. Utilisez "gmc web" dans un dépôt git pour voir son état.',
  openInFinderPrefix: 'Ouvrir dans Finder : ',
  removeFromRecent: 'Supprimer des récents',
  removeFromRecentAriaSuffix: 'des dépôts récents',
  loadingStatusErrorPrefix: 'Erreur de chargement de l’état : ',
  pushing: 'Push en cours...',
  pulling: 'Pull en cours...',
  commitsOn: 'commits le',
  installHooksConfirm: 'GMC Git Hooks n’est pas installé !\\n\\nAprès installation des hooks, chaque git commit -m gmc déclenchera automatiquement la génération de commit message assistée par IA.\\n\\nCliquez sur "OK" pour installer les hooks et committer\\nCliquez sur "Annuler" pour générer directement le commit message avec l’IA cette fois-ci (plus lent)',
  installingHooks: 'Installation des hooks...',
  hookInstallFailedPrefix: 'Échec d’installation du hook : ',
  commitWithHooksStatus: 'Commit des fichiers sélectionnés...',
  commitWithAiStatus: 'Génération du commit message par IA et commit...',
  committedSelected: 'Fichiers sélectionnés commités.',
  ignoringSelected: 'Ignore des fichiers sélectionnés...',
  ignoreRulesAddedSuffix: ' règle(s) ignore ajoutée(s) à .gitignore.',
  restoreConfirmPrefix: 'Voulez-vous vraiment annuler les modifications dans ',
  restoreConfirmSuffix: ' fichier(s) ?',
  restoringSelected: 'Restauration des fichiers sélectionnés...',
  restoredPrefix: 'Restauré ',
  restoredSuffix: ' fichier(s).',
  taskView: 'Tâches',
  taskBoardTitle: 'Tableau des tâches du dépôt',
  taskBoardIntro: 'Les tâches sont stockées dans .gmc/tasks. Déplacez une tâche vers Codex, Claude ou Antigravity pour lancer cet agent.',
  tasksCount: 'tâches',
  taskStorage: 'Stockage',
  refreshTasks: 'Actualiser',
  newTask: 'Nouvelle tâche',
  taskContent: 'Contenu',
  taskDetails: 'Détails de la tâche',
  taskContentPlaceholder: 'Décrivez la tâche, le contexte ou les critères d’acceptation. Markdown est pris en charge.',
  startSpeechInput: 'Démarrer la saisie vocale',
  stopSpeechInput: 'Arrêter la saisie vocale',
  speechReady: 'Cliquez sur le micro pour démarrer la saisie vocale. L’audio n’est pas enregistré.',
  speechUnsupported: 'Ce navigateur ne prend pas en charge la reconnaissance vocale web. Utilisez le clavier.',
  speechStarting: 'Demande d’accès au microphone...',
  speechListening: 'Écoute et transcription en direct...',
  speechStopping: 'Fin de la transcription...',
  speechPermissionDenied: 'Le microphone est inaccessible. Autorisez-le dans le navigateur.',
  speechMicrophoneUnavailable: 'Aucun microphone disponible n’a été trouvé.',
  speechNoSpeech: 'Aucune parole reconnue. Réessayez.',
  speechNetworkError: 'Le service de reconnaissance vocale est indisponible. Réessayez plus tard.',
  speechLanguageUnsupported: 'La reconnaissance vocale est indisponible pour la langue actuelle.',
  speechFailed: 'La reconnaissance vocale a échoué. Réessayez.',
  speechContentLimit: 'La limite de contenu de la tâche est atteinte.',
  holdToTalk: 'maintenir 0,4 s pour parler',
  createTask: 'Créer la tâche',
  creatingTask: 'Création...',
  decomposeTask: 'Décomposer avec l’IA',
  decomposingTask: 'Décomposition...',
  loadingTasks: 'Chargement des tâches...',
  taskLoadFailed: 'Échec de chargement des tâches : ',
  taskCreateFailed: 'Échec de création de la tâche : ',
  taskDecomposeFailed: 'Échec de décomposition de la tâche : ',
  taskUpdateFailed: 'Échec de mise à jour de la tâche : ',
  noTasksInColumn: 'Aucune tâche dans cette colonne',
  noRepoForTasks: 'Sélectionnez un dépôt Git avant d’utiliser le tableau des tâches.',
  taskStatusTodo: 'À faire',
  taskStatusCodex: 'Codex',
  taskStatusClaude: 'Claude',
  taskStatusAntigravity: 'Antigravity',
  taskStatusDoing: 'En cours',
  taskStatusReview: 'Revue',
  taskStatusDone: 'Terminé',
  agentMonitorLoading: 'Chargement de l’état d’exécution...',
  agentMonitorWorking: 'En cours',
  agentMonitorIdle: 'Inactif',
  agentMonitorPaused: 'Interaction requise',
  agentMonitorStopped: 'Non démarré',
  agentMonitorUnavailable: 'Moniteur indisponible',
  agentMonitorTimeout: 'Délai du moniteur dépassé',
  agentMonitorUnknown: 'État inconnu',
  agentMonitorProcesses: 'Processus',
  agentMonitorMemory: 'Mémoire',
  agentMonitorUptime: 'Durée maximale',
  agentMonitorDays: 'j',
  agentMonitorHours: 'h',
  agentMonitorMinutes: 'min',
  agentMonitorSeconds: 's',
  moveTaskLeft: 'Déplacer à gauche',
  moveTaskRight: 'Déplacer à droite',
  taskUpdatedJustNow: 'Mis à jour à l’instant',
  taskContentEmpty: 'Aucun contenu pour le moment. Ajoutez du contexte ou des critères d’acceptation à la création d’une tâche.',
  deleteTask: 'Supprimer la tâche',
  deleteTaskConfirmPrefix: 'Supprimer la tâche ',
  deleteTaskConfirmSuffix: ' ?\\n\\nCela supprime le fichier de tâche du dépôt.',
  taskDeleteFailed: 'Échec de suppression de la tâche : ',
  taskDetail: 'Détail de la tâche',
  editTask: 'Modifier',
  saveTask: 'Enregistrer',
  savingTask: 'Enregistrement...',
  taskSaveFailed: 'Échec d’enregistrement de la tâche : ',
  agentSettings: 'Paramètres de l’agent',
  agentSettingsHelp: 'Choisissez des agents IA distincts pour les commit messages et le développement des tâches.',
  commitAgentSetting: 'Agent de commit message',
  commitAgentSettingHelp: 'Utilisé pour générer les commit messages.',
  taskAgentSetting: 'Agent de tâche',
  taskAgentSettingHelp: 'Utilisé comme agent par défaut pour décomposer les tâches du dépôt.',
  repositoryTaskAgentSetting: 'Agent de décomposition',
  agentSettingSaved: 'Paramètre de l’agent enregistré',
  agentSettingSaveFailed: 'Échec d’enregistrement du paramètre de l’agent : '
});
var LANGUAGE_ALIASES = {
  zh: 'zh-CN',
  'zh-cn': 'zh-CN',
  'zh-hans': 'zh-CN',
  en: 'en',
  ja: 'ja',
  jp: 'ja',
  ko: 'ko',
  kr: 'ko',
  es: 'es',
  fr: 'fr'
};
var LANGUAGE_HTML_LANG = {
  'zh-CN': 'zh-CN',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
  es: 'es',
  fr: 'fr'
};
var currentLanguage = normalizeLanguage(localStorage.getItem('gmc_language') || (navigator.language || ''));
var $ = function(id) { return document.getElementById(id); };
function getPerfMeasure(name) {
  var entries = performance.getEntriesByName(name, 'measure');
  if (entries.length) return entries[entries.length - 1].duration.toFixed(1);
  return '?';
}
var TASK_BOARD_STATUSES = [
  { id: 'todo', label: 'taskStatusTodo', color: '#0284c7' },
  { id: 'codex', label: 'taskStatusCodex', color: '#16a34a', agent: true, monitorIds: ['codex-cli', 'codex-app'] },
  { id: 'claude', label: 'taskStatusClaude', color: '#d97706', agent: true, monitorIds: ['claude-code'] },
  { id: 'antigravity', label: 'taskStatusAntigravity', color: '#7c3aed', agent: true, monitorIds: ['antigravity'] },
  { id: 'done', label: 'taskStatusDone', color: '#64748b' }
];

function normalizeLanguage(value) {
  var normalized = String(value || '').toLowerCase().replace(/_/g, '-');
  if (LANGUAGE_ALIASES[normalized]) return LANGUAGE_ALIASES[normalized];
  var base = normalized.split('-')[0];
  return LANGUAGE_ALIASES[base] || 'en';
}

function t(key) {
  var table = I18N[currentLanguage] || I18N.en;
  return table[key] || I18N.en[key] || key;
}

function applyLanguage() {
  document.documentElement.lang = LANGUAGE_HTML_LANG[currentLanguage] || 'en';
  document.querySelectorAll('[data-i18n]').forEach(function(node) {
    node.textContent = t(node.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-title]').forEach(function(node) {
    node.title = t(node.getAttribute('data-i18n-title'));
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach(function(node) {
    node.setAttribute('aria-label', t(node.getAttribute('data-i18n-aria-label')));
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(function(node) {
    node.setAttribute('placeholder', t(node.getAttribute('data-i18n-placeholder')));
  });
  var label = $('languageButtonLabel');
  if (label) label.textContent = t('languageButton');
  document.querySelectorAll('[data-lang-option]').forEach(function(button) {
    button.classList.toggle('active', button.getAttribute('data-lang-option') === currentLanguage);
  });
  updateReadmeLink();
  updateRepoLink(state.repoPathText || targetRepo || t('repoRunning'), targetRepo);
  renderSidebar();
  if (!targetRepo) {
    renderHomeRepoMatrix(state.repoHistory || []);
  }
  renderSecurityControls();
  renderThemeControls();
  renderTaskBoard();
  renderTaskSpeechState();
  if (targetRepo) {
    if ($('upstream').dataset.empty === 'true') $('upstream').textContent = t('noUpstream');
    renderFiles(state.files || []);
    renderBranchMenus();
    renderRepositoryBrowser();
    renderFileTree();
    renderCommits(state.commits || []);
    window.setTimeout(function() { renderGraph(state.commits || []); }, 0);
  } else if (state.gitOverview) {
    renderGitOverview(state.gitOverview);
  }
}

function setLanguage(language) {
  currentLanguage = normalizeLanguage(language);
  localStorage.setItem('gmc_language', currentLanguage);
  closeLanguageMenu();
  applyLanguage();
}

function toggleLanguageMenu() {
  var menu = $('languageMenu');
  if (menu) menu.classList.toggle('open');
}

function closeLanguageMenu() {
  var menu = $('languageMenu');
  if (menu) menu.classList.remove('open');
}

function bindLanguageControls() {
  var button = $('openLanguageMenu');
  if (button) {
    button.addEventListener('click', function(event) {
      event.preventDefault();
      event.stopPropagation();
      toggleLanguageMenu();
    });
  }
  document.querySelectorAll('[data-lang-option]').forEach(function(option) {
    option.addEventListener('click', function(event) {
      event.preventDefault();
      setLanguage(option.getAttribute('data-lang-option'));
    });
  });
  document.addEventListener('click', function(event) {
    if (!event.target.closest || !event.target.closest('.language-wrap')) closeLanguageMenu();
  });
  document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape') closeLanguageMenu();
  });
}

function bindViewTabs() {
  document.querySelectorAll('[data-view-tab]').forEach(function(button) {
    button.addEventListener('click', function() {
      setActiveView(button.getAttribute('data-view-tab'));
    });
  });
}

function setActiveView(view) {
  if (!targetRepo) {
    if ($('homePage')) $('homePage').hidden = false;
    if ($('gitPage')) $('gitPage').hidden = true;
    if ($('taskPage')) $('taskPage').hidden = true;
    if ($('settingsPage')) $('settingsPage').hidden = true;
    var tabs = document.querySelector('.view-tabs');
    if (tabs) tabs.hidden = true;
    var closeBtn = $('closeRepoBtn');
    if (closeBtn) closeBtn.hidden = true;
    return;
  }
  view = view === 'tasks' ? 'tasks' : 'git';
  if (view !== 'tasks') cancelTaskSpeech();
  state.settingsOpen = false;
  state.activeView = view;
  var gitPage = $('gitPage');
  var taskPage = $('taskPage');
  var accessPage = $('settingsPage');
  var tabs2 = document.querySelector('.view-tabs');
  var closeBtn2 = $('closeRepoBtn');
  if ($('homePage')) $('homePage').hidden = true;
  if (accessPage) accessPage.hidden = true;
  if (tabs2) tabs2.hidden = false;
  if (closeBtn2) closeBtn2.hidden = false;
  if (gitPage) gitPage.hidden = view !== 'git';
  if (taskPage) taskPage.hidden = view !== 'tasks';
  document.querySelectorAll('[data-view-tab]').forEach(function(button) {
    button.classList.toggle('active', button.getAttribute('data-view-tab') === view);
  });
  if (view === 'tasks') {
    startAgentMonitorPolling();
    performance.mark('gmc-task-view-start');
    Promise.all([loadRepositoryTasks(), loadRepositoryTaskAgent()]).then(function() {
      performance.mark('gmc-task-view-end');
      performance.measure('gmc-task-view-switch', 'gmc-task-view-start', 'gmc-task-view-end');
      console.debug('[gmc:timing] task view switch: ' + getPerfMeasure('gmc-task-view-switch') + 'ms');
    });
  } else {
    stopAgentMonitorPolling();
    refreshLayoutSoon();
  }
}

function updateGitTabBadge(count) {
  var badge = $('gitTabBadge');
  if (!badge) return;
  count = Number(count) || 0;
  if (count > 0) {
    badge.textContent = String(count);
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

function updateTaskTabBadge(count) {
  var badge = $('taskTabBadge');
  if (!badge) return;
  if (typeof count !== 'number') {
    var taskList = state.repoTasks || [];
    count = (taskList || []).filter(function(t) { return t && t.status !== 'done'; }).length;
  }
  if (count > 0) {
    badge.textContent = String(count);
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

function bindTaskControls() {
  var refresh = $('refreshTasks');
  var openComposer = $('openTaskComposer');
  var cancelComposer = $('cancelTaskComposer');
  var decompose = $('decomposeTaskButton');
  var form = $('taskComposer');
  if (refresh) refresh.addEventListener('click', function() {
    loadRepositoryTasks({ force: true });
    loadAgentMonitor({ force: true });
  });
  if (openComposer) openComposer.addEventListener('click', function() { showTaskComposer(true); });
  if (cancelComposer) cancelComposer.addEventListener('click', function() { showTaskComposer(false); });
  if (decompose) decompose.addEventListener('click', decomposeTaskFromForm);
  if (form) {
    form.addEventListener('submit', function(event) {
      event.preventDefault();
      createTaskFromForm();
    });
  }
  initTaskSpeech();
}

function showTaskComposer(open) {
  var form = $('taskComposer');
  if (!form) return;
  if (!open) cancelTaskSpeech();
  form.hidden = !open;
  if (open) {
    setTaskError('');
    window.setTimeout(function() {
      var content = $('taskContentInput');
      if (content) content.focus();
    }, 0);
  }
}

function clearTaskSpeechShortcutTimer() {
  if (!taskSpeech.shortcutTimer) return;
  window.clearTimeout(taskSpeech.shortcutTimer);
  taskSpeech.shortcutTimer = null;
}

function cancelPendingTaskSpeechShortcut() {
  clearTaskSpeechShortcutTimer();
  taskSpeech.shortcutPressed = false;
}

function initTaskSpeech() {
  var button = $('taskSpeechButton');
  var input = $('taskContentInput');
  var hint = document.querySelector('.task-speech-hint');
  taskSpeech.supported = typeof (window.SpeechRecognition || window.webkitSpeechRecognition) === 'function';
  if (button) {
    button.disabled = !taskSpeech.supported;
    button.addEventListener('click', function() {
      if (taskSpeech.requested || taskSpeech.listening) stopTaskSpeech();
      else startTaskSpeech(false);
    });
  }
  if (input) {
    input.addEventListener('input', function() {
      if (taskSpeech.requested || taskSpeech.listening) cancelTaskSpeech();
    });
  }
  if (hint && !taskSpeech.supported) hint.hidden = true;
  document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape' && (taskSpeech.requested || taskSpeech.listening)) {
      cancelTaskSpeech();
      return;
    }
    if (event.key === 'Control') {
      if (event.repeat || taskSpeech.shortcutPressed || !taskSpeech.supported || !taskSpeechShortcutAvailable()) return;
      if ((taskSpeech.requested || taskSpeech.listening) && !taskSpeech.heldByShortcut) return;
      taskSpeech.shortcutPressed = true;
      clearTaskSpeechShortcutTimer();
      taskSpeech.shortcutTimer = window.setTimeout(function() {
        taskSpeech.shortcutTimer = null;
        if (!taskSpeech.shortcutPressed || !taskSpeechShortcutAvailable()) return;
        startTaskSpeech(true);
      }, TASK_SPEECH_CTRL_HOLD_MS);
      return;
    }

    if (taskSpeech.shortcutPressed || taskSpeech.heldByShortcut) {
      var wasHeldByShortcut = taskSpeech.heldByShortcut;
      cancelPendingTaskSpeechShortcut();
      if (wasHeldByShortcut && (taskSpeech.requested || taskSpeech.listening)) cancelTaskSpeech();
    }
  });
  document.addEventListener('keyup', function(event) {
    if (event.key !== 'Control') return;
    clearTaskSpeechShortcutTimer();
    taskSpeech.shortcutPressed = false;
    if (!taskSpeech.heldByShortcut) return;
    taskSpeech.heldByShortcut = false;
    stopTaskSpeech();
  });
  window.addEventListener('blur', function() {
    clearTaskSpeechShortcutTimer();
    taskSpeech.shortcutPressed = false;
    if (taskSpeech.heldByShortcut) {
      taskSpeech.heldByShortcut = false;
      stopTaskSpeech();
    }
  });
  taskSpeech.statusKey = taskSpeech.supported ? 'speechReady' : 'speechUnsupported';
  taskSpeech.statusClass = taskSpeech.supported ? '' : 'error';
  renderTaskSpeechState();
}

function taskSpeechShortcutAvailable() {
  var form = $('taskComposer');
  var createButton = $('createTaskButton');
  var decomposeButton = $('decomposeTaskButton');
  var taskDetailModal = $('taskDetailModal');
  return !!form && !form.hidden && state.activeView === 'tasks' &&
    !(taskDetailModal && taskDetailModal.classList.contains('visible')) &&
    !(createButton && createButton.disabled) &&
    !(decomposeButton && decomposeButton.disabled);
}

function taskSpeechLanguage() {
  return {
    'zh-CN': 'zh-CN',
    en: 'en-US',
    ja: 'ja-JP',
    ko: 'ko-KR',
    es: 'es-ES',
    fr: 'fr-FR'
  }[currentLanguage] || 'en-US';
}

function startTaskSpeech(fromShortcut) {
  var Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  var input = $('taskContentInput');
  if (typeof Recognition !== 'function' || !input || !taskSpeechShortcutAvailable()) return;
  if (taskSpeech.requested || taskSpeech.listening) return;

  taskSpeech.baseValue = input.value;
  taskSpeech.insertStart = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length;
  taskSpeech.insertEnd = typeof input.selectionEnd === 'number' ? input.selectionEnd : taskSpeech.insertStart;
  taskSpeech.finalTranscript = '';
  taskSpeech.interimTranscript = '';
  taskSpeech.statusKey = 'speechStarting';
  taskSpeech.statusClass = 'active';
  taskSpeech.requested = true;
  taskSpeech.stopping = false;
  taskSpeech.heldByShortcut = fromShortcut === true;

  var recognition = new Recognition();
  taskSpeech.recognition = recognition;
  recognition.lang = taskSpeechLanguage();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.onstart = function() {
    if (taskSpeech.recognition !== recognition) return;
    taskSpeech.listening = true;
    taskSpeech.statusKey = 'speechListening';
    taskSpeech.statusClass = 'active';
    renderTaskSpeechState();
  };
  recognition.onresult = function(event) {
    if (taskSpeech.recognition !== recognition) return;
    var interim = '';
    var i;
    for (i = event.resultIndex; i < event.results.length; i += 1) {
      var transcript = event.results[i][0] ? event.results[i][0].transcript : '';
      if (event.results[i].isFinal) {
        taskSpeech.finalTranscript = appendSpeechText(taskSpeech.finalTranscript, transcript);
      } else {
        interim = appendSpeechText(interim, transcript);
      }
    }
    taskSpeech.interimTranscript = interim;
    if (!renderTaskSpeechTranscript()) {
      taskSpeech.statusKey = 'speechContentLimit';
      taskSpeech.statusClass = 'error';
      stopTaskSpeech(true);
      return;
    }
    taskSpeech.statusKey = 'speechListening';
    taskSpeech.statusClass = 'active';
    renderTaskSpeechState();
  };
  recognition.onerror = function(event) {
    if (taskSpeech.recognition !== recognition) return;
    if (event.error === 'aborted' && taskSpeech.stopping) return;
    taskSpeech.statusKey = taskSpeechErrorKey(event.error);
    taskSpeech.statusClass = 'error';
    renderTaskSpeechState();
  };
  recognition.onend = function() {
    if (taskSpeech.recognition !== recognition) return;
    if (taskSpeech.interimTranscript) {
      taskSpeech.finalTranscript = appendSpeechText(taskSpeech.finalTranscript, taskSpeech.interimTranscript);
      taskSpeech.interimTranscript = '';
      renderTaskSpeechTranscript();
    }
    taskSpeech.recognition = null;
    taskSpeech.requested = false;
    taskSpeech.listening = false;
    taskSpeech.stopping = false;
    if (taskSpeech.statusClass !== 'error') {
      taskSpeech.statusKey = 'speechReady';
      taskSpeech.statusClass = '';
    }
    renderTaskSpeechState();
  };

  renderTaskSpeechState();
  input.focus();
  try {
    recognition.start();
  } catch (error) {
    taskSpeech.recognition = null;
    taskSpeech.requested = false;
    taskSpeech.listening = false;
    taskSpeech.statusKey = 'speechFailed';
    taskSpeech.statusClass = 'error';
    renderTaskSpeechState();
  }
}

function stopTaskSpeech(preserveStatus) {
  var recognition = taskSpeech.recognition;
  if (!recognition) {
    taskSpeech.requested = false;
    taskSpeech.listening = false;
    renderTaskSpeechState();
    return;
  }
  taskSpeech.stopping = true;
  if (!preserveStatus) {
    taskSpeech.statusKey = 'speechStopping';
    taskSpeech.statusClass = 'active';
  }
  renderTaskSpeechState();
  try {
    recognition.stop();
  } catch (error) {
    try { recognition.abort(); } catch (ignore) {}
  }
}

function cancelTaskSpeech() {
  var recognition = taskSpeech.recognition;
  clearTaskSpeechShortcutTimer();
  taskSpeech.recognition = null;
  taskSpeech.requested = false;
  taskSpeech.listening = false;
  taskSpeech.stopping = false;
  taskSpeech.heldByShortcut = false;
  taskSpeech.shortcutPressed = false;
  taskSpeech.finalTranscript = '';
  taskSpeech.interimTranscript = '';
  taskSpeech.statusKey = taskSpeech.supported ? 'speechReady' : 'speechUnsupported';
  taskSpeech.statusClass = taskSpeech.supported ? '' : 'error';
  if (recognition) {
    try { recognition.abort(); } catch (ignore) {}
  }
  renderTaskSpeechState();
}

function appendSpeechText(existing, addition) {
  existing = String(existing || '').trim();
  addition = String(addition || '').trim();
  if (!existing) return addition;
  if (!addition) return existing;
  return existing + (/\\s$/.test(existing) || /^\\s/.test(addition) ? '' : ' ') + addition;
}

function renderTaskSpeechTranscript() {
  var input = $('taskContentInput');
  if (!input) return false;
  var transcript = appendSpeechText(taskSpeech.finalTranscript, taskSpeech.interimTranscript);
  if (!transcript) return true;
  var before = taskSpeech.baseValue.slice(0, taskSpeech.insertStart);
  var after = taskSpeech.baseValue.slice(taskSpeech.insertEnd);
  var beforeSpace = before && !/\\s$/.test(before) ? ' ' : '';
  var afterSpace = after && !/^\\s/.test(after) ? ' ' : '';
  var available = 12000 - before.length - after.length - beforeSpace.length - afterSpace.length;
  if (available <= 0) return false;
  var clipped = transcript.slice(0, available);
  input.value = before + beforeSpace + clipped + afterSpace + after;
  var caret = before.length + beforeSpace.length + clipped.length;
  if (typeof input.setSelectionRange === 'function') input.setSelectionRange(caret, caret);
  return clipped.length === transcript.length;
}

function taskSpeechErrorKey(error) {
  if (error === 'not-allowed' || error === 'service-not-allowed') return 'speechPermissionDenied';
  if (error === 'audio-capture') return 'speechMicrophoneUnavailable';
  if (error === 'no-speech') return 'speechNoSpeech';
  if (error === 'network') return 'speechNetworkError';
  if (error === 'language-not-supported' || error === 'language-unavailable') return 'speechLanguageUnsupported';
  return 'speechFailed';
}

function renderTaskSpeechState() {
  var button = $('taskSpeechButton');
  var status = $('taskSpeechStatus');
  var active = taskSpeech.requested || taskSpeech.listening;
  if (button) {
    button.classList.toggle('listening', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.title = t(active ? 'stopSpeechInput' : 'startSpeechInput');
    button.setAttribute('aria-label', t(active ? 'stopSpeechInput' : 'startSpeechInput'));
  }
  if (status) {
    status.textContent = t(taskSpeech.statusKey || 'speechReady');
    status.classList.toggle('active', taskSpeech.statusClass === 'active');
    status.classList.toggle('error', taskSpeech.statusClass === 'error');
  }
}

function loadRepositoryTasks(options) {
  options = options || {};
  if (!targetRepo) {
    state.repoTasks = [];
    state.tasksLoaded = true;
    renderTaskBoard();
    return Promise.resolve([]);
  }
  if (state.taskLoading) {
    if (options.force) state.pendingTaskReload = true;
    return Promise.resolve(state.repoTasks);
  }
  if (state.tasksLoaded && !options.force) {
    var t0 = performance.now();
    renderTaskBoard();
    console.debug('[gmc:timing] renderTaskBoard(cached): ' + (performance.now() - t0).toFixed(1) + 'ms');
    return Promise.resolve(state.repoTasks);
  }

  performance.mark('gmc-tasks-api-start');
  var repoAtStart = targetRepo;
  state.taskLoading = true;
  renderTaskBoard();
  return fetch('/api/tasks?repo=' + encodeURIComponent(targetRepo), { cache: 'no-store' })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
        performance.mark('gmc-tasks-api-end');
        performance.measure('gmc-tasks-api', 'gmc-tasks-api-start', 'gmc-tasks-api-end');
        console.debug('[gmc:timing] /api/tasks fetch: ' + getPerfMeasure('gmc-tasks-api') + 'ms (server timings: %o)', data.timings);
        return data;
      });
    })
    .then(function(data) {
      if (targetRepo !== repoAtStart) return state.repoTasks;
      state.repoTasks = data.tasks || [];
      state.tasksLoaded = true;
      var storage = $('taskStoragePath');
      if (storage) storage.textContent = data.directory || '.gmc/tasks';
      setTaskError('');
      var t0 = performance.now();
      renderTaskBoard();
      if (state.activeTaskId && !state.taskDetailEditing) {
        var activeTask = findRepoTask(state.activeTaskId);
        if (activeTask) renderTaskDetail(activeTask);
        else hideTaskDetail();
      }
      console.debug('[gmc:timing] renderTaskBoard: ' + (performance.now() - t0).toFixed(1) + 'ms');
      return state.repoTasks;
    })
    .catch(function(error) {
      if (targetRepo !== repoAtStart) return state.repoTasks;
      setTaskError(t('taskLoadFailed') + error.message);
      renderTaskBoard();
      return state.repoTasks;
    })
    .finally(function() {
      if (targetRepo !== repoAtStart) return;
      state.taskLoading = false;
      renderTaskBoard();
      if (state.pendingTaskReload) {
        state.pendingTaskReload = false;
        return loadRepositoryTasks({ force: true });
      }
    });
}

function startAgentMonitorPolling() {
  stopAgentMonitorPolling();
  if (state.activeView !== 'tasks' || state.settingsOpen || document.hidden) return;
  if (!state.agentMonitor.agents.length) {
    state.agentMonitor = { status: 'loading', available: false, reason: '', agents: [], usage: null };
    renderTaskBoard();
  }
  loadAgentMonitor();
  connectAgentMonitorSocket();
}

function stopAgentMonitorPolling() {
  if (state.agentMonitorTimer) {
    clearTimeout(state.agentMonitorTimer);
    state.agentMonitorTimer = null;
  }
  if (state.agentMonitorRequest) {
    state.agentMonitorRequest.abort();
    state.agentMonitorRequest = null;
  }
  if (state.agentMonitorReconnectTimer) {
    clearTimeout(state.agentMonitorReconnectTimer);
    state.agentMonitorReconnectTimer = null;
  }
  if (state.agentMonitorSocket) {
    var socket = state.agentMonitorSocket;
    state.agentMonitorSocket = null;
    try {
      socket.close();
    } catch (error) {}
  }
  state.agentMonitorLoading = false;
}

function scheduleAgentMonitorPoll() {
  if (state.agentMonitorTimer) clearTimeout(state.agentMonitorTimer);
  state.agentMonitorTimer = null;
  if (state.activeView !== 'tasks' || state.settingsOpen || document.hidden) return;
  if (state.agentMonitorSocket &&
      (state.agentMonitorSocket.readyState === WebSocket.CONNECTING ||
       state.agentMonitorSocket.readyState === WebSocket.OPEN)) return;
  state.agentMonitorTimer = setTimeout(function() {
    state.agentMonitorTimer = null;
    loadAgentMonitor();
  }, AGENT_MONITOR_POLL_INTERVAL_MS);
}

function scheduleAgentMonitorReconnect() {
  if (state.agentMonitorReconnectTimer) clearTimeout(state.agentMonitorReconnectTimer);
  state.agentMonitorReconnectTimer = null;
  if (state.activeView !== 'tasks' || state.settingsOpen || document.hidden) return;
  if (typeof window.WebSocket !== 'function') return;
  state.agentMonitorReconnectTimer = setTimeout(function() {
    state.agentMonitorReconnectTimer = null;
    connectAgentMonitorSocket();
  }, AGENT_MONITOR_RECONNECT_INTERVAL_MS);
}

function connectAgentMonitorSocket() {
  if (state.activeView !== 'tasks' || state.settingsOpen || document.hidden) return;
  if (typeof window.WebSocket !== 'function') {
    scheduleAgentMonitorPoll();
    return;
  }
  if (state.agentMonitorSocket &&
      (state.agentMonitorSocket.readyState === WebSocket.CONNECTING ||
       state.agentMonitorSocket.readyState === WebSocket.OPEN)) return;

  var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  var socket = new WebSocket(protocol + '//' + window.location.host + '/api/agent-monitor/ws');
  state.agentMonitorSocket = socket;

  socket.addEventListener('open', function() {
    if (state.agentMonitorSocket !== socket) return;
    if (state.agentMonitorTimer) {
      clearTimeout(state.agentMonitorTimer);
      state.agentMonitorTimer = null;
    }
  });
  socket.addEventListener('message', function(event) {
    if (state.agentMonitorSocket !== socket) return;
    var payload;
    try {
      payload = JSON.parse(event.data);
    } catch (error) {
      return;
    }
    if (!payload) return;
    var socketAgents = Array.isArray(payload.agents) ? payload.agents : [];
    state.agentMonitor = {
      status: 'ok',
      available: true,
      reason: '',
      agents: normalizeAgentMonitorSocketAgents(socketAgents),
      usage: payload.usage || null
    };
    if (!state.draggedTaskId) renderTaskBoard();
  });
  socket.addEventListener('close', function() {
    if (state.agentMonitorSocket !== socket) return;
    state.agentMonitorSocket = null;
    loadAgentMonitor({ force: true });
    scheduleAgentMonitorReconnect();
  });
  socket.addEventListener('error', function() {
    if (state.agentMonitorSocket !== socket) return;
    try {
      socket.close();
    } catch (error) {}
  });
}

function normalizeAgentMonitorSocketAgents(agents) {
  return agents.slice(0, 50).map(function(item) {
    var status = String(item && item.status || '').toLowerCase();
    var processCount = Math.max(0, Math.floor(Number(
      item && (item.process_count != null ? item.process_count : item.processCount)
    ) || 0));
    if (status !== 'working' && status !== 'idle' &&
        status !== 'paused' && status !== 'stopped') {
      status = 'unknown';
    }
    if (processCount === 0) status = 'stopped';
    return {
      agentId: String(item && (item.agent_id || item.agentId || item.id) || '').toLowerCase(),
      displayName: String(item && (item.display_name || item.displayName) || ''),
      status: status,
      processCount: processCount,
      cpuPercent: Math.max(0, Number(item && (
        item.total_cpu_percent != null ? item.total_cpu_percent : item.cpuPercent
      )) || 0),
      memoryMb: Math.max(0, Number(item && (
        item.total_memory_mb != null ? item.total_memory_mb : item.memoryMb
      )) || 0),
      uptimeSeconds: Math.max(0, Number(item && (
        item.max_uptime_seconds != null ? item.max_uptime_seconds : item.uptimeSeconds
      )) || 0)
    };
  }).filter(function(item) {
    return item.agentId;
  });
}

function getAgentUsageData(column) {
  var monitor = state.agentMonitor || {};
  var usage = monitor.usage;
  if (!usage || typeof usage !== 'object') return null;
  var agentId = String(column && column.id || '').toLowerCase();
  if (!agentId) return null;

  if (usage[agentId]) return usage[agentId];
  if (agentId === 'claude' && (usage['claude'] || usage['claude-code'])) return usage['claude'] || usage['claude-code'];
  if (agentId === 'codex' && (usage['codex'] || usage['codex-cli'] || usage['codex-app'])) return usage['codex'] || usage['codex-cli'] || usage['codex-app'];
  if (agentId === 'antigravity' && usage['antigravity']) return usage['antigravity'];

  var keys = Object.keys(usage);
  for (var i = 0; i < keys.length; i += 1) {
    var k = keys[i];
    if (k === agentId || k.indexOf(agentId) >= 0 || agentId.indexOf(k) >= 0) {
      return usage[k];
    }
  }
  return null;
}

function formatUsageWindowLabel(label) {
  var norm = String(label || '').trim().toLowerCase();
  if (norm === '5h' || norm === '5h window' || norm === '5h_window') return t('agentUsage5h');
  if (norm === '7d' || norm === '7d window' || norm === '7d_window') return t('agentUsage7d');
  if (norm === '24h' || norm === '24h window' || norm === '24h_window') return t('agentUsage24h');
  if (norm === '30d' || norm === '30d window' || norm === '30d_window') return t('agentUsage30d');
  if (norm === 'today') return t('agentUsageToday');
  if (norm === 'month' || norm === 'this_month') return t('agentUsageMonth');
  if (norm === 'total' || norm === 'all_time') return t('agentUsageTotal');
  if (norm === 'last_session') return t('agentUsageLastSession');
  if (norm === 'project_last_sessions') return t('agentUsageProjectLastSessions');
  return label;
}

function formatUsageWindowMetrics(win) {
  var parts = [];
  if (win.used_percent != null && win.used_percent !== undefined) {
    var pct = Number(win.used_percent);
    parts.push((pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(1)) + '%');
  }
  if (win.cost_cents != null && win.cost_cents !== undefined) {
    var dollars = (Number(win.cost_cents) / 100).toFixed(2);
    parts.push('$' + dollars);
  }
  if (win.tokens_input != null || win.tokens_output != null) {
    var totalTokens = (Number(win.tokens_input) || 0) + (Number(win.tokens_output) || 0);
    if (totalTokens > 0) {
      parts.push(formatTokenCount(totalTokens));
    }
  }
  if (win.sessions != null && win.sessions > 0) {
    parts.push(win.sessions + ' ' + t('agentUsageSessions'));
  }
  return parts.join(' · ');
}

function formatTokenCount(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
  return String(num);
}

function getCodexUsageColor(pct) {
  var p = Math.max(0, Math.min(100, Number(pct) || 0));
  var stops = [
    { pct: 0, r: 34, g: 197, b: 94 },
    { pct: 25, r: 234, g: 179, b: 8 },
    { pct: 50, r: 249, g: 115, b: 22 },
    { pct: 75, r: 239, g: 68, b: 68 },
    { pct: 100, r: 127, g: 29, b: 29 }
  ];
  for (var i = 0; i < stops.length - 1; i += 1) {
    var s1 = stops[i];
    var s2 = stops[i + 1];
    if (p >= s1.pct && p <= s2.pct) {
      var factor = (p - s1.pct) / (s2.pct - s1.pct);
      var r = Math.round(s1.r + factor * (s2.r - s1.r));
      var g = Math.round(s1.g + factor * (s2.g - s1.g));
      var b = Math.round(s1.b + factor * (s2.b - s1.b));
      return 'rgb(' + r + ', ' + g + ', ' + b + ')';
    }
  }
  return 'rgb(127, 29, 29)';
}

function getCodexUsageGradient(pct) {
  var p = Math.max(0, Math.min(100, Number(pct) || 0));
  if (p <= 0) return 'rgb(34, 197, 94)';

  var allStops = [
    { pct: 0, color: 'rgb(34, 197, 94)' },
    { pct: 25, color: 'rgb(234, 179, 8)' },
    { pct: 50, color: 'rgb(249, 115, 22)' },
    { pct: 75, color: 'rgb(239, 68, 68)' },
    { pct: 100, color: 'rgb(127, 29, 29)' }
  ];

  var currentColor = getCodexUsageColor(p);
  var activeStops = [];
  for (var i = 0; i < allStops.length; i += 1) {
    if (allStops[i].pct < p) {
      var stopPos = (allStops[i].pct / p * 100).toFixed(1) + '%';
      activeStops.push(allStops[i].color + ' ' + stopPos);
    }
  }
  activeStops.push(currentColor + ' 100%');

  if (activeStops.length === 1) return currentColor;
  return 'linear-gradient(90deg, ' + activeStops.join(', ') + ')';
}

function agentUsageHtml(column) {
  var data = getAgentUsageData(column);
  if (!data) return '';
  if (data.status === 'error' && data.error) {
    return '<div class="task-agent-monitor-usage">' +
      '<div class="task-agent-usage-head"><span class="task-agent-usage-title">' + escapeHtml(t('agentUsageTitle')) + '</span></div>' +
      '<div class="task-agent-usage-error">' + escapeHtml(data.error) + '</div>' +
    '</div>';
  }
  var windows = Array.isArray(data.windows) ? data.windows : [];
  if (!windows.length && !data.plan) return '';

  var planHtml = data.plan ? '<span class="task-agent-usage-plan">' + escapeHtml(data.plan) + '</span>' : '';
  var windowsHtml = windows.map(function(win) {
    var label = formatUsageWindowLabel(win.label);
    var metrics = formatUsageWindowMetrics(win);
    if (!metrics) return '';

    var progressBarHtml = '';
    if (win.used_percent != null && win.used_percent !== undefined) {
      var pct = Math.max(0, Math.min(100, Number(win.used_percent) || 0));
      var bgGradient = getCodexUsageGradient(pct);
      progressBarHtml = '<div class="task-agent-usage-progress">' +
        '<div class="task-agent-usage-progress-bar" style="width: ' + pct + '%; background: ' + bgGradient + ';"></div>' +
      '</div>';
    }

    return '<div class="task-agent-usage-item">' +
      '<div class="task-agent-usage-row">' +
        '<span class="task-agent-usage-label">' + escapeHtml(label) + '</span>' +
        '<span class="task-agent-usage-val">' + escapeHtml(metrics) + '</span>' +
      '</div>' +
      progressBarHtml +
    '</div>';
  }).filter(Boolean).join('');

  if (!windowsHtml && !planHtml) return '';

  return '<div class="task-agent-monitor-usage">' +
    '<div class="task-agent-usage-head">' +
      '<span class="task-agent-usage-title">' + escapeHtml(t('agentUsageTitle')) + '</span>' +
      planHtml +
    '</div>' +
    (windowsHtml ? '<div class="task-agent-usage-windows">' + windowsHtml + '</div>' : '') +
  '</div>';
}


function loadAgentMonitor(options) {
  options = options || {};
  if (state.activeView !== 'tasks' || state.settingsOpen || document.hidden) {
    return Promise.resolve(state.agentMonitor);
  }
  if (state.agentMonitorLoading && !options.force) {
    return Promise.resolve(state.agentMonitor);
  }
  if (state.agentMonitorRequest) state.agentMonitorRequest.abort();
  if (state.agentMonitorTimer) clearTimeout(state.agentMonitorTimer);
  state.agentMonitorTimer = null;
  var controller = new AbortController();
  state.agentMonitorRequest = controller;
  state.agentMonitorLoading = true;
  return fetch('/api/agent-monitor', {
    cache: 'no-store',
    signal: controller.signal,
    gmcTimeoutMs: 5000
  })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return data;
      });
    })
    .then(function(data) {
      if (state.agentMonitorRequest !== controller) return state.agentMonitor;
      state.agentMonitor = {
        status: data.status || 'unavailable',
        available: data.available === true,
        reason: data.reason || '',
        agents: Array.isArray(data.agents) ? data.agents : [],
        usage: data.usage || null
      };
      if (!state.draggedTaskId) renderTaskBoard();
      return state.agentMonitor;
    })
    .catch(function(error) {
      if (state.agentMonitorRequest !== controller || error && error.name === 'AbortError') {
        return state.agentMonitor;
      }
      state.agentMonitor = {
        status: 'unavailable',
        available: false,
        reason: 'unavailable',
        agents: [],
        usage: null
      };
      if (!state.draggedTaskId) renderTaskBoard();
      return state.agentMonitor;
    })
    .finally(function() {
      if (state.agentMonitorRequest !== controller) return;
      state.agentMonitorRequest = null;
      state.agentMonitorLoading = false;
      scheduleAgentMonitorPoll();
    });
}

function connectTaskEvents() {
  if (!targetRepo || typeof window.EventSource !== 'function') return;
  if (state.taskEvents) state.taskEvents.close();
  state.taskEvents = new EventSource('/api/events?repo=' + encodeURIComponent(targetRepo));
  state.taskEvents.addEventListener('tasks-changed', function () {
    loadRepositoryTasks({ force: true });
  });
}

function createTaskFromForm() {
  submitTaskForm(false);
}

function decomposeTaskFromForm() {
  submitTaskForm(true);
}

function submitTaskForm(decompose) {
  if (!targetRepo) {
    setTaskError(t('noRepoForTasks'));
    return;
  }
  var content = $('taskContentInput');
  var createButton = $('createTaskButton');
  var decomposeButton = $('decomposeTaskButton');
  var button = decompose ? decomposeButton : createButton;
  var contentValue = content ? content.value.trim() : '';
  if (createButton && createButton.disabled || decomposeButton && decomposeButton.disabled) return;
  if (!contentValue) {
    if (content) content.focus();
    return;
  }

  cancelTaskSpeech();
  if (button) {
    button.textContent = t(decompose ? 'decomposingTask' : 'creatingTask');
  }
  if (createButton) createButton.disabled = true;
  if (decomposeButton) decomposeButton.disabled = true;
  var endpoint = decompose ? '/api/tasks/decompose' : '/api/tasks/create';
  var requestOptions = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: contentValue, status: 'todo' })
  };
  if (decompose) requestOptions.gmcTimeoutMs = TASK_DECOMPOSITION_TIMEOUT_MS;
  fetch(endpoint + '?repo=' + encodeURIComponent(targetRepo), requestOptions)
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
        return data;
      });
    })
    .then(function(data) {
      state.repoTasks = data.tasks || [];
      state.tasksLoaded = true;
      if (content) content.value = '';
      showTaskComposer(false);
      setTaskError('');
      renderTaskBoard();
      refreshRepositoryStatus();
    })
    .catch(function(error) {
      setTaskError(t(decompose ? 'taskDecomposeFailed' : 'taskCreateFailed') + error.message);
    })
    .finally(function() {
      if (createButton) {
        createButton.disabled = false;
        createButton.textContent = t('createTask');
      }
      if (decomposeButton) {
        decomposeButton.disabled = false;
        decomposeButton.textContent = t('decomposeTask');
      }
    });
}

function decomposeTaskDetail() {
  var task = findRepoTask(state.activeTaskId);
  var button = $('decomposeTaskDetail');
  if (!task || !button || button.disabled) return;
  setTaskError('');
  button.disabled = true;
  button.textContent = t('decomposingTask');
  var requirementContent = task.title ?
    task.title + (task.content ? '\\n\\n' + task.content : '') :
    task.content;
  fetch('/api/tasks/decompose?repo=' + encodeURIComponent(targetRepo), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: requirementContent }),
    gmcTimeoutMs: TASK_DECOMPOSITION_TIMEOUT_MS
  })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
        return data;
      });
    })
    .then(function(data) {
      state.repoTasks = data.tasks || [];
      state.tasksLoaded = true;
      renderTaskBoard();
      setTaskError('');
      var count = (data.createdTasks || []).length;
      var message = t('deleteDecomposedTaskConfirm')
        .replace('{id}', task.id)
        .replace('{count}', String(count));
      if (confirm(message)) {
        return deleteTaskRequest(task.id);
      }
      renderTaskDetail(findRepoTask(task.id));
      refreshRepositoryStatus();
    })
    .catch(function(error) {
      setTaskError(t('taskDecomposeFailed') + error.message);
    })
    .finally(function() {
      button.disabled = false;
      button.textContent = t('decomposeTask');
    });
}

function updateTaskStatus(taskId, status) {
  if (!targetRepo || !taskId || !status) return;
  setTaskError('');
  return fetch('/api/tasks/update?repo=' + encodeURIComponent(targetRepo), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: taskId, status: status })
  })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
        return data;
      });
    })
    .then(function(data) {
      state.repoTasks = data.tasks || [];
      renderTaskBoard();
      refreshRepositoryStatus();
    })
    .catch(function(error) {
      setTaskError(t('taskUpdateFailed') + error.message);
      loadRepositoryTasks({ force: true });
    });
}

function deleteTask(taskId) {
  if (!targetRepo || !taskId) return;
  if (!confirm(t('deleteTaskConfirmPrefix') + taskId + t('deleteTaskConfirmSuffix'))) return;
  return deleteTaskRequest(taskId);
}

function deleteTaskRequest(taskId) {
  setTaskError('');
  return fetch('/api/tasks/delete?repo=' + encodeURIComponent(targetRepo), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: taskId })
  })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
        return data;
      });
    })
    .then(function(data) {
      state.repoTasks = data.tasks || [];
      renderTaskBoard();
      if (state.activeTaskId === taskId) hideTaskDetail();
      refreshRepositoryStatus();
    })
    .catch(function(error) {
      setTaskError(t('taskDeleteFailed') + error.message);
      loadRepositoryTasks({ force: true });
    });
}

function moveTask(taskId, direction) {
  var task = findRepoTask(taskId);
  if (!task) return;
  var index = TASK_BOARD_STATUSES.map(function(item) { return item.id; }).indexOf(taskBoardStatus(task.status));
  var next = TASK_BOARD_STATUSES[index + direction];
  if (next) updateTaskStatus(taskId, next.id);
}

function findRepoTask(taskId) {
  return (state.repoTasks || []).find(function(task) { return task.id === taskId; });
}

function taskStatusMeta(status) {
  status = taskBoardStatus(status);
  return TASK_BOARD_STATUSES.find(function(item) { return item.id === status; }) || TASK_BOARD_STATUSES[0];
}

function taskBoardStatus(status) {
  if (status === 'doing') return 'codex';
  if (status === 'review') return 'done';
  return status;
}

function renderTaskBoard() {
  var board = $('taskBoard');
  if (!board) return;
  var total = $('taskTotalCount');
  if (total) total.textContent = String((state.repoTasks || []).length);
  updateTaskTabBadge();

  if (!targetRepo) {
    board.innerHTML = '<div class="task-board-loading">' + escapeHtml(t('noRepoForTasks')) + '</div>';
    return;
  }
  if (state.taskLoading && !state.tasksLoaded) {
    board.innerHTML = '<div class="task-board-loading">' + escapeHtml(t('loadingTasks')) + '</div>';
    return;
  }

  board.innerHTML = TASK_BOARD_STATUSES.map(function(column) {
    var tasks = (state.repoTasks || []).filter(function(task) { return taskBoardStatus(task.status) === column.id; });
    var monitorState = column.agent ? agentMonitorColumnState(column).status : '';
    var dotClass = column.agent && monitorState === 'working' ? 'task-dot breathing' : 'task-dot';
    var cards = tasks.length ? tasks.map(function(task) {
      return taskCardHtml(task, column);
    }).join('') : '<div class="task-empty">' + escapeHtml(t('noTasksInColumn')) + '</div>';
    return '<section class="task-column" data-task-status="' + escapeHtml(column.id) + '" style="--task-color:' + escapeHtml(column.color) + '">' +
      '<div class="task-column-head">' +
        '<div class="task-column-head-main">' +
          '<div class="task-column-title"><span class="' + dotClass + '"></span><span>' + escapeHtml(t(column.label)) + '</span></div>' +
          '<div class="task-count">' + tasks.length + '</div>' +
        '</div>' +
        (column.agent ? agentMonitorHtml(column) : '') +
      '</div>' +
      '<div class="task-column-body">' + cards + '</div>' +
    '</section>';
  }).join('');
  bindRenderedTaskBoard();
}

function agentMonitorColumnState(column) {
  var monitor = state.agentMonitor || {};
  if (monitor.status === 'loading') {
    return { status: 'loading', entries: [], processCount: 0, cpuPercent: 0, memoryMb: 0, uptimeSeconds: 0 };
  }
  if (!monitor.available) {
    return {
      status: monitor.reason === 'timeout' ? 'timeout' : 'unavailable',
      entries: [],
      processCount: 0,
      cpuPercent: 0,
      memoryMb: 0,
      uptimeSeconds: 0
    };
  }
  var entries = (column.monitorIds || []).map(function(agentId) {
    var entry = (monitor.agents || []).find(function(item) {
      return item && item.agentId === agentId;
    });
    return entry || {
      agentId: agentId,
      displayName: agentMonitorSourceLabel(agentId),
      status: 'stopped',
      processCount: 0,
      cpuPercent: 0,
      memoryMb: 0,
      uptimeSeconds: 0
    };
  });
  var status = 'stopped';
  if (entries.some(function(entry) { return entry.status === 'paused'; })) status = 'paused';
  else if (entries.some(function(entry) { return entry.status === 'working'; })) status = 'working';
  else if (entries.some(function(entry) { return entry.status === 'idle'; })) status = 'idle';
  else if (entries.some(function(entry) { return entry.status === 'unknown'; })) status = 'unknown';
  return {
    status: status,
    entries: entries,
    processCount: entries.reduce(function(total, entry) { return total + (Number(entry.processCount) || 0); }, 0),
    cpuPercent: entries.reduce(function(total, entry) { return total + (Number(entry.cpuPercent) || 0); }, 0),
    memoryMb: entries.reduce(function(total, entry) { return total + (Number(entry.memoryMb) || 0); }, 0),
    uptimeSeconds: entries.reduce(function(longest, entry) { return Math.max(longest, Number(entry.uptimeSeconds) || 0); }, 0)
  };
}

function agentMonitorHtml(column) {
  var summary = agentMonitorColumnState(column);
  var stateKey = {
    loading: 'agentMonitorLoading',
    working: 'agentMonitorWorking',
    idle: 'agentMonitorIdle',
    paused: 'agentMonitorPaused',
    stopped: 'agentMonitorStopped',
    unavailable: 'agentMonitorUnavailable',
    timeout: 'agentMonitorTimeout',
    unknown: 'agentMonitorUnknown'
  }[summary.status] || 'agentMonitorUnknown';
  var metrics = '';
  var sources = '';
  if (summary.status === 'working' || summary.status === 'idle' ||
      summary.status === 'paused' || summary.status === 'stopped' ||
      summary.status === 'unknown') {
    metrics = '<div class="task-agent-monitor-metrics">' +
      '<span>' + escapeHtml(t('agentMonitorProcesses')) + ' ' + summary.processCount + '</span>' +
      '<span>CPU ' + escapeHtml(formatAgentMonitorNumber(summary.cpuPercent)) + '%</span>' +
      '<span>' + escapeHtml(t('agentMonitorMemory')) + ' ' + escapeHtml(formatAgentMonitorMemory(summary.memoryMb)) + '</span>' +
      '<span>' + escapeHtml(t('agentMonitorUptime')) + ' ' + escapeHtml(formatAgentMonitorUptime(summary.uptimeSeconds)) + '</span>' +
    '</div>';
  }
  if (summary.entries.length > 1) {
    sources = '<div class="task-agent-monitor-sources">' + summary.entries.map(function(entry) {
      return '<div class="task-agent-monitor-source">' +
        '<span>' + escapeHtml(agentMonitorSourceLabel(entry.agentId)) + '</span>' +
        '<span>' + escapeHtml(t('agentMonitor' + capitalizeAgentMonitorStatus(entry.status))) + ' · ' +
          (Number(entry.processCount) || 0) + '</span>' +
      '</div>';
    }).join('') + '</div>';
  }
  var usage = agentUsageHtml(column);
  return '<div class="task-agent-monitor" data-monitor-state="' + escapeHtml(summary.status) + '">' +
    '<div class="task-agent-monitor-head">' +
      '<span class="task-agent-monitor-state">' + escapeHtml(t(stateKey)) + '</span>' +
    '</div>' +
    metrics +
    usage +
    sources +
  '</div>';
}

function capitalizeAgentMonitorStatus(status) {
  status = String(status || 'unknown');
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function agentMonitorSourceLabel(agentId) {
  return {
    'codex-cli': 'Codex CLI',
    'codex-app': 'Codex App',
    'claude-code': 'Claude Code',
    'antigravity': 'Antigravity'
  }[agentId] || agentId;
}

function formatAgentMonitorNumber(value) {
  value = Number(value) || 0;
  return value.toFixed(value >= 10 || value === 0 ? 0 : 1);
}

function formatAgentMonitorMemory(value) {
  value = Number(value) || 0;
  if (value >= 1024) return (value / 1024).toFixed(value >= 10240 ? 0 : 1) + ' GB';
  return Math.round(value) + ' MB';
}

function formatAgentMonitorUptime(value) {
  value = Math.max(0, Math.floor(Number(value) || 0));
  if (value >= 86400) return Math.floor(value / 86400) + t('agentMonitorDays');
  if (value >= 3600) return Math.floor(value / 3600) + t('agentMonitorHours');
  if (value >= 60) return Math.floor(value / 60) + t('agentMonitorMinutes');
  return value + t('agentMonitorSeconds');
}

function taskCardHtml(task, column) {
  var statusIndex = TASK_BOARD_STATUSES.map(function(item) { return item.id; }).indexOf(taskBoardStatus(task.status));
  var canMoveLeft = statusIndex > 0;
  var canMoveRight = statusIndex < TASK_BOARD_STATUSES.length - 1;
  var summary = taskSummary(task.content);
  var titleHtml = task.title ? '<strong class="task-card-title">' + escapeHtml(task.title) + '</strong>' : '';
  var copyClass = task.title ? 'task-card-copy has-title' : 'task-card-copy';
  return '<article class="task-card" draggable="true" data-task-id="' + escapeHtml(task.id) + '" style="--task-color:' + escapeHtml(column.color) + '">' +
    '<button class="task-remove" type="button" title="' + escapeHtml(t('deleteTask')) + '" aria-label="' + escapeHtml(t('deleteTask') + ' ' + task.id) + '" data-task-delete="' + escapeHtml(task.id) + '">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
    '</button>' +
    '<div class="task-card-band">' +
      '<span class="task-id">' + escapeHtml(task.id) + '</span>' +
    '</div>' +
    '<button class="' + copyClass + '" type="button" data-task-detail="' + escapeHtml(task.id) + '">' +
      titleHtml +
      '<span class="task-card-summary">' + escapeHtml(summary || t('taskContentEmpty')) + '</span>' +
    '</button>' +
    '<div class="task-card-footer">' +
      '<span>' + escapeHtml(formatTaskUpdated(task.updated || task.created)) + '</span>' +
      '<span class="task-card-actions">' +
        '<button class="task-mini-button" type="button" data-task-move="-1" title="' + escapeHtml(t('moveTaskLeft')) + '"' + (canMoveLeft ? '' : ' disabled') + '>‹</button>' +
        '<button class="task-mini-button" type="button" data-task-move="1" title="' + escapeHtml(t('moveTaskRight')) + '"' + (canMoveRight ? '' : ' disabled') + '>›</button>' +
      '</span>' +
    '</div>' +
  '</article>';
}

function bindRenderedTaskBoard() {
  document.querySelectorAll('.task-card').forEach(function(card) {
    card.addEventListener('dragstart', function(event) {
      state.draggedTaskId = card.getAttribute('data-task-id');
      card.classList.add('dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', state.draggedTaskId);
      }
    });
    card.addEventListener('dragend', function() {
      state.draggedTaskId = '';
      card.classList.remove('dragging');
      document.querySelectorAll('.task-column.drag-over').forEach(function(column) {
        column.classList.remove('drag-over');
      });
    });
    card.querySelectorAll('[data-task-delete]').forEach(function(button) {
      button.addEventListener('click', function(event) {
        event.preventDefault();
        event.stopPropagation();
        deleteTask(button.getAttribute('data-task-delete'));
      });
    });
    card.querySelectorAll('[data-task-detail]').forEach(function(button) {
      button.addEventListener('click', function(event) {
        event.preventDefault();
        event.stopPropagation();
        showTaskDetail(button.getAttribute('data-task-detail'));
      });
    });
    card.querySelectorAll('[data-task-move]').forEach(function(button) {
      button.addEventListener('click', function(event) {
        event.preventDefault();
        event.stopPropagation();
        moveTask(card.getAttribute('data-task-id'), Number(button.getAttribute('data-task-move')) || 0);
      });
    });
  });
  document.querySelectorAll('.task-column').forEach(function(column) {
    column.addEventListener('dragover', function(event) {
      event.preventDefault();
      column.classList.add('drag-over');
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    });
    column.addEventListener('dragleave', function(event) {
      if (!column.contains(event.relatedTarget)) column.classList.remove('drag-over');
    });
    column.addEventListener('drop', function(event) {
      event.preventDefault();
      column.classList.remove('drag-over');
      var taskId = state.draggedTaskId || event.dataTransfer && event.dataTransfer.getData('text/plain');
      var status = column.getAttribute('data-task-status');
      var task = findRepoTask(taskId);
      if (task && taskBoardStatus(task.status) !== status) updateTaskStatus(taskId, status);
    });
  });
}

function taskSummary(content) {
  return String(content || '').replace(/\s+/g, ' ').trim();
}

function showTaskDetail(taskId) {
  var task = findRepoTask(taskId);
  if (!task) return;
  var modal = $('taskDetailModal');
  if (!modal) return;
  state.activeTaskId = task.id;
  setTaskDetailEditing(false);
  renderTaskDetail(task);
  modal.classList.add('visible');
  $('closeTaskDetail').focus();
}

function renderTaskDetail(task) {
  if (!task) return;
  var meta = taskStatusMeta(task.status);
  $('taskDetailId').textContent = task.id;
  $('taskDetailStatus').textContent = t(meta.label);
  $('taskDetailStatus').style.setProperty('--task-color', meta.color);
  $('taskDetailUpdated').textContent = formatTaskUpdated(task.updated || task.created);
  $('taskDetailTitle').textContent = task.title || '';
  $('taskDetailTitle').hidden = !task.title;
  renderTaskMarkdown($('taskDetailBody'), task.content || t('taskContentEmpty'));
}

function hideTaskDetail() {
  var modal = $('taskDetailModal');
  if (modal) modal.classList.remove('visible');
  state.activeTaskId = '';
  setTaskDetailEditing(false);
}

function setTaskDetailEditing(editing) {
  state.taskDetailEditing = editing === true;
  var task = findRepoTask(state.activeTaskId);
  var body = $('taskDetailBody');
  var form = $('taskDetailEdit');
  var editButton = $('editTaskDetail');
  var decomposeButton = $('decomposeTaskDetail');
  var cancelButton = $('cancelTaskEdit');
  var saveButton = $('saveTaskDetail');
  if (body) body.hidden = state.taskDetailEditing;
  if (form) form.hidden = !state.taskDetailEditing;
  if (editButton) editButton.hidden = state.taskDetailEditing;
  if (decomposeButton) decomposeButton.hidden = state.taskDetailEditing;
  if (cancelButton) cancelButton.hidden = !state.taskDetailEditing;
  if (saveButton) saveButton.hidden = !state.taskDetailEditing;
  if (state.taskDetailEditing && task) {
    $('taskDetailContentInput').value = task.content || '';
    window.setTimeout(function() { $('taskDetailContentInput').focus(); }, 0);
  }
}

function saveTaskDetail() {
  var task = findRepoTask(state.activeTaskId);
  if (!task) return;
  var contentInput = $('taskDetailContentInput');
  var saveButton = $('saveTaskDetail');
  var content = contentInput ? contentInput.value.trim() : '';
  if (!content) {
    if (contentInput) contentInput.focus();
    return;
  }
  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = t('savingTask');
  }
  fetch('/api/tasks/update?repo=' + encodeURIComponent(targetRepo), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: task.id, content: content })
  })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
        return data;
      });
    })
    .then(function(data) {
      state.repoTasks = data.tasks || [];
      var updated = data.task || findRepoTask(task.id);
      renderTaskBoard();
      renderTaskDetail(updated);
      setTaskDetailEditing(false);
      setTaskError('');
      refreshRepositoryStatus();
    })
    .catch(function(error) {
      setTaskError(t('taskSaveFailed') + error.message);
    })
    .finally(function() {
      if (saveButton) {
        saveButton.disabled = false;
        saveButton.textContent = t('saveTask');
      }
    });
}

function renderTaskMarkdown(target, markdown) {
  if (!target) return;
  if (!window.marked || !window.marked.parse) {
    target.textContent = markdown || '';
    return;
  }
  target.innerHTML = sanitizeTaskHtml(window.marked.parse(markdown || '', { gfm: true, breaks: false }));
  target.querySelectorAll('a[href]').forEach(function(link) {
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noreferrer');
  });
}

function sanitizeTaskHtml(html) {
  var template = document.createElement('template');
  template.innerHTML = html || '';
  var allowedTags = {
    A: true, BLOCKQUOTE: true, BR: true, CODE: true, DEL: true, EM: true, H1: true, H2: true,
    H3: true, H4: true, HR: true, LI: true, OL: true, P: true, PRE: true, STRONG: true,
    TABLE: true, TBODY: true, TD: true, TH: true, THEAD: true, TR: true, UL: true
  };
  var allowedAttrs = {
    A: { href: true, title: true },
    TH: { align: true },
    TD: { align: true }
  };
  Array.prototype.slice.call(template.content.querySelectorAll('*')).forEach(function(node) {
    if (!allowedTags[node.tagName]) {
      node.replaceWith(document.createTextNode(node.textContent || ''));
      return;
    }
    Array.prototype.slice.call(node.attributes).forEach(function(attr) {
      var attrs = allowedAttrs[node.tagName] || {};
      var name = attr.name.toLowerCase();
      if (!attrs[attr.name] || name.indexOf('on') === 0) {
        node.removeAttribute(attr.name);
        return;
      }
      if (node.tagName === 'A' && attr.name === 'href' && !isSafeTaskHref(attr.value)) {
        node.removeAttribute(attr.name);
      }
    });
  });
  return template.innerHTML;
}

function isSafeTaskHref(value) {
  var href = String(value || '').trim().toLowerCase();
  return href.indexOf('http://') === 0 ||
    href.indexOf('https://') === 0 ||
    href.indexOf('mailto:') === 0 ||
    href.charAt(0) === '#';
}

function formatTaskUpdated(value) {
  var time = value ? new Date(value) : null;
  if (!time || Number.isNaN(time.getTime())) return t('taskUpdatedJustNow');
  var diff = Date.now() - time.getTime();
  if (diff >= 0 && diff < 60 * 1000) return t('taskUpdatedJustNow');
  return time.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function setTaskError(message) {
  var target = $('taskError');
  if (!target) return;
  target.textContent = message || '';
  target.classList.toggle('visible', !!message);
}

function refreshRepositoryStatus() {
  if (!targetRepo) return;
  load({ force: true });
}

function updateReadmeLink() {
  var link = $('readmeLink');
  if (!link) return;
  if (!targetRepo) {
    link.removeAttribute('href');
    link.textContent = t('selectRepositoryFirst');
    return;
  }
  link.href = '/readme?repo=' + encodeURIComponent(targetRepo);
  link.textContent = t('openReadme');
}

function updateRepoLink(text, repoPath) {
  var link = $('repo');
  if (!link) return;
  state.repoPathText = text;
  link.textContent = text;
  if (repoPath && canOpenRepositoryLocally()) {
    link.href = '#';
    link.title = t('openInFinderPrefix') + repoPath;
  } else {
    link.removeAttribute('href');
    if (repoPath) {
      link.title = t('finderLocalOnly');
    } else {
      link.removeAttribute('title');
    }
  }
  updateTerminalButton(repoPath);
}

function updateTerminalButton(repoPath) {
  var qaBar = $('quickActions');
  if (!qaBar) return;
  var canOpen = !!(repoPath && canOpenRepositoryLocally());
  qaBar.hidden = !canOpen;
  if (canOpen) {
    var terminalBtn = $('qaTerminal');
    if (terminalBtn) {
      terminalBtn.title = t('openTerminalPrefix') + repoPath;
      terminalBtn.setAttribute('aria-label', t('openTerminal'));
    }
    detectProjectAndUpdateIde(repoPath);
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
      alert(t('openFinderFailed') + error.message);
    });
}

function openCurrentTerminal(event) {
  if (event) event.preventDefault();
  if (!targetRepo) return;
  if (!canOpenRepositoryLocally()) return;
  fetch('/api/open-terminal?repo=' + encodeURIComponent(targetRepo), { method: 'POST' })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
        return data;
      });
    })
    .catch(function(error) {
      alert(t('openTerminalFailed') + error.message);
    });
}

function detectProjectAndUpdateIde(repoPath) {
  if (!repoPath) return;
  var ideBtn = $('qaOpenIde');
  if (!ideBtn) return;
  fetch('/api/detect-project?repo=' + encodeURIComponent(targetRepo), { cache: 'no-store' })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
        return data;
      });
    })
    .then(function(project) {
      var ideIcon = $('qaIdeIcon');
      var ideLabel = $('qaIdeLabel');
      if (ideLabel) ideLabel.textContent = project.ideLabel || 'VS Code';
      if (ideIcon) {
        if (project.ide === 'xcode') {
          ideIcon.src = '/icons/xcode.svg';
        } else if (project.ide === 'android-studio') {
          ideIcon.src = '/icons/android-studio.svg';
        } else {
          ideIcon.src = '/icons/vscode.svg';
        }
      }
      ideBtn.hidden = false;
    })
    .catch(function() {
      var ideLabel = $('qaIdeLabel');
      if (ideLabel) ideLabel.textContent = 'VS Code';
      var ideBtn = $('qaOpenIde');
      if (ideBtn) ideBtn.hidden = false;
    });
}

function openProjectIde(event) {
  if (event) event.preventDefault();
  if (!targetRepo) return;
  if (!canOpenRepositoryLocally()) return;
  fetch('/api/open-ide?repo=' + encodeURIComponent(targetRepo), { method: 'POST' })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
        return data;
      });
    })
    .catch(function(error) {
      var ideLabel = $('qaIdeLabel');
      var name = ideLabel ? ideLabel.textContent : 'IDE';
      console.error('openProjectIde error:', error.message);
      alert('Failed to open ' + name + ': ' + error.message);
    });
}

function openAgentTerminal(event, btn) {
  console.log('openAgentTerminal called');
  if (event) event.preventDefault();
  if (!targetRepo) { console.log('no targetRepo'); return; }
  if (!canOpenRepositoryLocally()) { console.log('not local'); return; }
  var agent = btn.getAttribute('data-agent');
  console.log('agent:', agent);
  if (!agent) { console.log('no agent'); return; }
  var url = '/api/open-agent?repo=' + encodeURIComponent(targetRepo) + '&agent=' + encodeURIComponent(agent);
  console.log('fetching:', url);
  fetch(url, { method: 'POST' })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
        console.log('response:', data);
        return data;
      });
    })
    .catch(function(error) {
      console.error('fetch error:', error);
      alert(t('openTerminalFailed') + agent + ': ' + error.message);
    });
}

function canOpenRepositoryLocally() {
  return window.location.hostname === '127.0.0.1' ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '::1' ||
    window.location.hostname === '[::1]';
}

function loadRepoHistory(force) {
  var url = '/api/repositories' + (force ? '?force=1' : '');
  return fetch(url, { cache: 'no-store' })
    .then(function(res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function(data) {
      state.repoHistory = data.repositories || [];
      renderSidebar();
      if (!targetRepo) {
        renderHomeRepoMatrix(state.repoHistory);
      }
      return state.repoHistory;
    })
    .catch(function() {
      state.repoHistory = [];
      renderSidebar();
      if (!targetRepo) {
        renderHomeRepoMatrix([]);
      }
      return state.repoHistory;
    });
}

function renderRepoBranchBadge(status) {
  if (!status || !status.branch) return '';
  return '<span class="repo-branch-pill" title="' + escapeHtml(t('currentBranch') + ': ' + status.branch) + '">' +
    '<svg class="repo-branch-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="3" x2="6" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg>' +
    '<span class="repo-branch-name">' + escapeHtml(status.branch) + '</span>' +
  '</span>';
}

function renderRepoStatusPills(status) {
  if (!status) return '';
  if (status.clean) {
    return '<span class="repo-pill-clean" title="' + escapeHtml(t('repoCleanTooltip')) + '">✓ ' + escapeHtml(t('clean')) + '</span>';
  }

  var html = '<div class="repo-pills-wrap">';
  if (status.unstaged > 0) {
    html += '<span class="repo-pill repo-pill-unstaged" title="' + escapeHtml(status.unstaged + ' ' + t('unstagedFilesTooltip')) + '">● ' + status.unstaged + '</span>';
  }
  if (status.staged > 0) {
    html += '<span class="repo-pill repo-pill-staged" title="' + escapeHtml(status.staged + ' ' + t('stagedFilesTooltip')) + '">+ ' + status.staged + '</span>';
  }
  if (status.untracked > 0 && status.unstaged === 0) {
    html += '<span class="repo-pill repo-pill-untracked" title="' + escapeHtml(status.untracked + ' ' + t('untrackedFilesTooltip')) + '">? ' + status.untracked + '</span>';
  }
  if (status.ahead > 0) {
    html += '<span class="repo-pill repo-pill-ahead" title="' + escapeHtml(status.ahead + ' ' + t('aheadCommitsTooltip')) + '">↑ ' + status.ahead + '</span>';
  }
  if (status.behind > 0) {
    html += '<span class="repo-pill repo-pill-behind" title="' + escapeHtml(status.behind + ' ' + t('behindCommitsTooltip')) + '">↓ ' + status.behind + '</span>';
  }
  html += '</div>';
  return html;
}

function renderSidebar() {
  var list = $('repoList');
  if (!list) return;
  var history = state.repoHistory || [];

  if (!history.length) {
    list.innerHTML = '<div class="repo-empty">' + escapeHtml(t('noRecentRepos')) + '</div>';
    return;
  }

  var prevScroll = list.scrollTop;
  list.innerHTML = history.map(function(item) {
    var name = item.name || repoDisplayName(item.path);
    var active = item.path === targetRepo ? ' active' : '';
    var st = item.status;
    var branchBadge = renderRepoBranchBadge(st);
    var statusPills = renderRepoStatusPills(st);

    return '<div class="repo-item' + active + '" role="link" tabindex="0" data-repo="' + escapeHtml(item.path) + '">' +
      '<div class="repo-item-body">' +
        '<div class="repo-item-header">' +
          '<div class="repo-item-name" title="' + escapeHtml(name) + '">' + escapeHtml(name) + '</div>' +
          branchBadge +
        '</div>' +
        '<div class="repo-item-path" title="' + escapeHtml(item.path) + '">' + escapeHtml(item.path) + '</div>' +
        '<div class="repo-item-footer">' +
          '<div class="repo-item-time">' + escapeHtml(formatRepoVisit(item.lastCommitTime || item.lastVisited)) + '</div>' +
          statusPills +
        '</div>' +
      '</div>' +
      '<button class="repo-remove" type="button" title="' + escapeHtml(t('removeFromRecent')) + '" aria-label="' + escapeHtml(t('removeFromRecent') + ' ' + name + ' ' + t('removeFromRecentAriaSuffix')) + '" data-repo="' + escapeHtml(item.path) + '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
      '</button>' +
    '</div>';
  }).join('');
  list.scrollTop = prevScroll;
}

function updateSidebarActive() {
  var list = $('repoList');
  if (!list) return;
  var items = list.querySelectorAll('.repo-item');
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (item.getAttribute('data-repo') === targetRepo) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  }
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
  switchRepository(repoPath);
}

function exitToHome(options) {
  switchRepository('', options);
}

function switchRepository(repoPath, options) {
  options = options || {};
  repoPath = repoPath || '';
  if (repoPath === targetRepo && !options.force) return;

  targetRepo = repoPath;

  try {
    var nextUrl = new URL(window.location.href);
    if (repoPath) {
      nextUrl.searchParams.set('repo', repoPath);
    } else {
      nextUrl.searchParams.delete('repo');
    }
    if (!options.skipHistory && window.history && window.history.pushState) {
      window.history.pushState({ repo: repoPath }, '', nextUrl.pathname + (nextUrl.search ? nextUrl.search : ''));
    }
  } catch (e) {}

  updateSidebarActive();

  clearTimeout(state.timer);
  clearTimeout(state.graphTimer);
  state.loading = false;
  state.pendingForceLoad = false;
  state.statusSignature = null;
  state.repoHistoryNeedsRefresh = false;
  closeCommitDetail();
  hideTaskDetail();
  cancelTaskSpeech();

  if ($('fileDetailPage')) $('fileDetailPage').hidden = true;
  if ($('diffDetailPage')) $('diffDetailPage').hidden = true;

  if (!targetRepo) {
    setPageTitle('');
    updateRepoLink(t('repoRunning'), null);
    if ($('homePage')) $('homePage').hidden = false;
    if ($('city3dContainer')) $('city3dContainer').hidden = false;
    if (typeof City3DEngine !== 'undefined') City3DEngine.resume();
    if ($('gitPage')) $('gitPage').hidden = true;
    if ($('taskPage')) $('taskPage').hidden = true;
    if ($('closeRepoBtn')) $('closeRepoBtn').hidden = true;
    var viewTabsEl = document.querySelector('.view-tabs');
    if (viewTabsEl) viewTabsEl.hidden = true;
    if (state.taskEvents) {
      try { state.taskEvents.close(); } catch (e) {}
      state.taskEvents = null;
    }
    loadGitOverview({ force: true });
    return;
  }

  setPageTitle(targetRepo);
  updateRepoLink(targetRepo, targetRepo);
  updateReadmeLink();
  if ($('homePage')) $('homePage').hidden = true;
  if ($('city3dContainer')) $('city3dContainer').hidden = true;
  if (typeof City3DEngine !== 'undefined') City3DEngine.pause();
  if ($('closeRepoBtn')) $('closeRepoBtn').hidden = false;
  var viewTabsEl2 = document.querySelector('.view-tabs');
  if (viewTabsEl2) viewTabsEl2.hidden = false;

  if (state.activeView === 'tasks') {
    if ($('gitPage')) $('gitPage').hidden = true;
    if ($('taskPage')) $('taskPage').hidden = false;
  } else {
    if ($('taskPage')) $('taskPage').hidden = true;
    if ($('gitPage')) $('gitPage').hidden = false;
    if ($('dashboardPage')) $('dashboardPage').hidden = false;
  }

  state.commits = [];
  state.files = [];
  state.selectedModified = {};
  state.selectedStaged = {};
  state.tasks = [];
  state.repoTasks = [];
  state.tasksLoaded = false;
  state.taskLoading = false;
  state.pendingTaskReload = false;
  state.activeTaskId = '';
  state.taskDetailEditing = false;
  state.repoBrowserLoaded = false;
  state.repoBrowserEntries = [];
  state.repoBrowserPath = '';
  state.fileTree = null;
  state.fileTreeLoading = false;
  state.fileTreeExpanded = {};
  state.fileViewPath = '';
  state.fileViewType = '';
  state.diffViewPath = '';
  state.readmeLoaded = false;
  state.branchSwitching = false;

  connectTaskEvents();

  var branchText = $('branchText');
  if (branchText) branchText.textContent = t('loading');
  var upstreamEl = $('upstream');
  if (upstreamEl) {
    upstreamEl.textContent = '';
    upstreamEl.dataset.empty = 'true';
  }
  var aheadEl = $('ahead');
  if (aheadEl) aheadEl.textContent = '0';
  var behindEl = $('behind');
  if (behindEl) behindEl.textContent = '0';
  var dirtyEl = $('dirty');
  if (dirtyEl) dirtyEl.textContent = '0';
  var btnPush = $('btnPush');
  if (btnPush) btnPush.style.display = 'none';

  updateGitTabBadge(0);
  updateTaskTabBadge(0);

  var fileList = $('fileList');
  if (fileList) fileList.innerHTML = '<div class="file-empty">' + escapeHtml(t('loading')) + '</div>';
  var branchesTree = $('branchesTree');
  if (branchesTree) branchesTree.innerHTML = '';
  var commitGraph = $('commitGraph');
  if (commitGraph) commitGraph.innerHTML = '';

  if (state.activeView === 'tasks') {
    renderTaskBoard();
    loadRepositoryTasks({ force: true });
    loadRepositoryTaskAgent();
  }

  load({ force: true });
}

function loadGitOverview(options) {
  options = options || {};
  if (state.gitOverviewLoading && !options.force) return Promise.resolve();
  state.gitOverviewLoading = true;

  var url = '/api/git-overview' + (options.force ? '?force=1' : '');
  return fetch(url, { cache: 'no-store' })
    .then(function(res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function(data) {
      state.gitOverviewLoading = false;
      state.gitOverview = data;
      renderGitOverview(data);
      return data;
    })
    .catch(function(err) {
      state.gitOverviewLoading = false;
      console.error('loadGitOverview error:', err);
    });
}

function renderGitOverview(data) {
  if (!data) return;

  if (data.repositories) {
    state.repoHistory = data.repositories;
    renderSidebar();
  }

  var verEl = $('homeGitVersion');
  if (verEl) verEl.textContent = data.version || 'Unknown';

  var pathEl = $('homeGitPath');
  if (pathEl) {
    var p = data.gitBin || data.execPath || '-';
    pathEl.textContent = p;
    pathEl.title = p;
  }

  var identityEl = $('homeGlobalIdentity');
  if (identityEl) {
    var idStr = '';
    if (data.userName && data.userEmail) {
      idStr = data.userName + ' <' + data.userEmail + '>';
    } else if (data.userName) {
      idStr = data.userName;
    } else if (data.userEmail) {
      idStr = data.userEmail;
    } else {
      idStr = t('notSet');
    }
    identityEl.textContent = idStr;
  }

  var countEl = $('homeTrackedCount');
  if (countEl) {
    countEl.textContent = String(data.repositoriesCount || (state.repoHistory || []).length || 0);
  }

  var uNameInput = $('cfgUserName');
  if (uNameInput && document.activeElement !== uNameInput) uNameInput.value = data.userName || '';
  var uEmailInput = $('cfgUserEmail');
  if (uEmailInput && document.activeElement !== uEmailInput) uEmailInput.value = data.userEmail || '';
  var cEditorInput = $('cfgCoreEditor');
  if (cEditorInput && document.activeElement !== cEditorInput) cEditorInput.value = data.coreEditor || '';
  var dBranchInput = $('cfgDefaultBranch');
  if (dBranchInput && document.activeElement !== dBranchInput) dBranchInput.value = data.defaultBranch || '';
  var pRebaseSelect = $('cfgPullRebase');
  if (pRebaseSelect && document.activeElement !== pRebaseSelect) pRebaseSelect.value = data.pullRebase || '';

  renderHomeRepoMatrix(data.repositories || state.repoHistory || []);

  renderGlobalConfigTable(data.configs || []);

  if (data.globalContributions) {
    renderHomeCalendar(data.globalContributions);
  }

  if (data.cityData && typeof City3DEngine !== 'undefined') {
    City3DEngine.buildCity(data.cityData);
  }
}

function renderHomeRepoMatrix(repositories) {
  var section = $('homeRepoMatrixSection');
  var grid = $('homeRepoMatrixGrid');
  var badge = $('homeRepoMatrixBadge');
  if (!section || !grid) return;

  repositories = repositories || state.repoHistory || [];

  var attentionRepos = repositories.filter(function(item) {
    if (!item || !item.status) return false;
    var st = item.status;
    return !st.clean || (st.unstaged > 0) || (st.staged > 0) || (st.untracked > 0) || (st.ahead > 0) || (st.behind > 0);
  });

  if (attentionRepos.length === 0) {
    section.hidden = true;
    grid.innerHTML = '';
    return;
  }

  section.hidden = false;
  if (badge) {
    badge.textContent = attentionRepos.length + ' ' + t('reposNeedingAttentionCount');
  }

  var html = attentionRepos.map(function(item) {
    var name = item.name || repoDisplayName(item.path);
    var st = item.status || {};
    var branch = st.branch || 'HEAD';
    var timeStr = formatRepoVisit(item.lastCommitTime || item.lastVisited);

    var unstagedClass = (st.unstaged > 0) ? ' active-amber' : '';
    var stagedClass = (st.staged > 0) ? ' active-emerald' : '';
    var aheadClass = (st.ahead > 0) ? ' active-blue' : '';
    var behindClass = (st.behind > 0) ? ' active-purple' : '';

    return '<div class="home-matrix-card" data-repo="' + escapeHtml(item.path) + '">' +
      '<div class="home-matrix-card-head">' +
        '<div class="home-matrix-card-title" title="' + escapeHtml(name) + '">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>' +
          '<span>' + escapeHtml(name) + '</span>' +
        '</div>' +
        '<span class="repo-branch-pill">' +
          '<svg class="repo-branch-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="3" x2="6" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg>' +
          '<span class="repo-branch-name">' + escapeHtml(branch) + '</span>' +
        '</span>' +
      '</div>' +
      '<div class="home-matrix-card-path" title="' + escapeHtml(item.path) + '">' + escapeHtml(item.path) + '</div>' +
      '<div class="home-matrix-stats-grid">' +
        '<div class="home-matrix-stat-item' + unstagedClass + '">' +
          '<span>●</span><span>' + (st.unstaged || 0) + ' ' + escapeHtml(t('unstaged')) + '</span>' +
        '</div>' +
        '<div class="home-matrix-stat-item' + stagedClass + '">' +
          '<span>+</span><span>' + (st.staged || 0) + ' ' + escapeHtml(t('staged')) + '</span>' +
        '</div>' +
        '<div class="home-matrix-stat-item' + aheadClass + '">' +
          '<span>↑</span><span>' + (st.ahead || 0) + ' ' + escapeHtml(t('aheadLabel')) + '</span>' +
        '</div>' +
        '<div class="home-matrix-stat-item' + behindClass + '">' +
          '<span>↓</span><span>' + (st.behind || 0) + ' ' + escapeHtml(t('behindLabel')) + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="home-matrix-card-foot">' +
        '<span class="home-matrix-time">🕒 ' + escapeHtml(timeStr) + '</span>' +
        '<button class="home-matrix-open-btn" type="button">' +
          '<span>' + escapeHtml(t('enterRepo')) + '</span>' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>' +
        '</button>' +
      '</div>' +
    '</div>';
  }).join('');

  grid.innerHTML = html;
}

function renderHomeCalendar(globalContribs) {
  globalContribs = globalContribs || {};
  renderCalendar(globalContribs, globalContribs, 'homeCalendar');

  var metaEl = $('homeCalendarMeta');
  if (!metaEl) return;

  var total = 0;
  var activeDays = 0;
  Object.keys(globalContribs).forEach(function(k) {
    var val = globalContribs[k] || 0;
    total += val;
    if (val > 0) activeDays++;
  });

  metaEl.innerHTML = '<span>' + escapeHtml(t('totalCommits')) + ': <strong>' + total + '</strong></span>' +
    '<span>' + escapeHtml(t('activeDays')) + ': <strong>' + activeDays + '</strong></span>';
}

function renderGlobalConfigTable(configs) {
  var container = $('homeAllConfigsTable');
  if (!container) return;

  if (!configs || !configs.length) {
    container.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:8px;">' + escapeHtml(t('notSet')) + '</div>';
    return;
  }

  var html = '';
  configs.forEach(function(item) {
    if (!item || !item.key) return;
    html += '<div class="home-config-row" data-key="' + escapeHtml(item.key) + '">' +
      '<span class="home-config-row-key">' + escapeHtml(item.key) + '</span>' +
      '<span class="home-config-row-val" title="' + escapeHtml(item.value || '') + '">' + escapeHtml(item.value || '') + '</span>' +
      '<button class="home-config-del-btn" type="button" title="' + escapeHtml(t('delete')) + '" data-delete-key="' + escapeHtml(item.key) + '">✕</button>' +
      '</div>';
  });

  container.innerHTML = html;
}

function bindHomePageEvents() {
  var matrixGrid = $('homeRepoMatrixGrid');
  if (matrixGrid && matrixGrid.dataset.bound !== 'true') {
    matrixGrid.dataset.bound = 'true';
    matrixGrid.addEventListener('click', function(e) {
      var card = e.target.closest('.home-matrix-card');
      if (card) {
        var repoPath = card.getAttribute('data-repo');
        if (repoPath) {
          openRepoFromHistory(repoPath);
        }
      }
    });
  }

  var refreshBtn = $('btnRefreshRepoMatrix');
  if (refreshBtn && refreshBtn.dataset.bound !== 'true') {
    refreshBtn.dataset.bound = 'true';
    refreshBtn.addEventListener('click', function(e) {
      e.preventDefault();
      refreshBtn.classList.add('spinning');
      loadGitOverview({ force: true }).then(function() {
        refreshBtn.classList.remove('spinning');
      }).catch(function() {
        refreshBtn.classList.remove('spinning');
      });
    });
  }

  var form = $('globalConfigForm');
  if (form && form.dataset.bound !== 'true') {
    form.dataset.bound = 'true';
    form.addEventListener('submit', function(e) {
      e.preventDefault();
      var btn = $('btnSaveConfig');
      var statusEl = $('configSaveStatus');
      if (btn) btn.disabled = true;
      if (statusEl) {
        statusEl.textContent = t('saving');
        statusEl.style.color = '';
      }

      var entries = {
        'user.name': $('cfgUserName') ? $('cfgUserName').value.trim() : '',
        'user.email': $('cfgUserEmail') ? $('cfgUserEmail').value.trim() : '',
        'core.editor': $('cfgCoreEditor') ? $('cfgCoreEditor').value.trim() : '',
        'init.defaultBranch': $('cfgDefaultBranch') ? $('cfgDefaultBranch').value.trim() : '',
        'pull.rebase': $('cfgPullRebase') ? $('cfgPullRebase').value : ''
      };

      fetch('/api/git-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: entries })
      })
        .then(function(res) {
          if (!res.ok) return res.text().then(function(t) { throw new Error(t); });
          return res.json();
        })
        .then(function(data) {
          if (btn) btn.disabled = false;
          if (statusEl) {
            statusEl.textContent = '✓ ' + t('configSaved');
            statusEl.style.color = 'var(--green)';
            setTimeout(function() { if (statusEl) statusEl.textContent = ''; }, 3000);
          }
          if (data && data.overview) {
            state.gitOverview = data.overview;
            renderGitOverview(data.overview);
          } else {
            loadGitOverview({ force: true });
          }
        })
        .catch(function(err) {
          if (btn) btn.disabled = false;
          if (statusEl) {
            statusEl.textContent = '✕ ' + (err.message || 'Save failed');
            statusEl.style.color = 'var(--rose)';
            setTimeout(function() {
              if (statusEl) {
                statusEl.textContent = '';
                statusEl.style.color = '';
              }
            }, 4000);
          }
        });
    });
  }

  var btnAdd = $('btnAddConfigKey');
  if (btnAdd && btnAdd.dataset.bound !== 'true') {
    btnAdd.dataset.bound = 'true';
    btnAdd.addEventListener('click', function() {
      var keyInput = $('newConfigKey');
      var valInput = $('newConfigVal');
      var key = keyInput ? keyInput.value.trim() : '';
      var val = valInput ? valInput.value.trim() : '';
      if (!key) {
        if (keyInput) keyInput.focus();
        return;
      }

      fetch('/api/git-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: key, value: val })
      })
        .then(function(res) {
          if (!res.ok) return res.text().then(function(t) { throw new Error(t); });
          return res.json();
        })
        .then(function(data) {
          if (keyInput) keyInput.value = '';
          if (valInput) valInput.value = '';
          if (data && data.overview) {
            state.gitOverview = data.overview;
            renderGitOverview(data.overview);
          } else {
            loadGitOverview({ force: true });
          }
        })
        .catch(function(err) {
          alert('Failed to set config: ' + err.message);
        });
    });
  }

  var allConfigsTable = $('homeAllConfigsTable');
  if (allConfigsTable && allConfigsTable.dataset.bound !== 'true') {
    allConfigsTable.dataset.bound = 'true';
    allConfigsTable.addEventListener('click', function(e) {
      var delBtn = e.target.closest('[data-delete-key]');
      if (!delBtn) return;
      var key = delBtn.getAttribute('data-delete-key');
      if (!key) return;

      fetch('/api/git-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: key, value: null })
      })
        .then(function(res) {
          if (!res.ok) return res.text().then(function(t) { throw new Error(t); });
          return res.json();
        })
        .then(function(data) {
          if (data && data.overview) {
            state.gitOverview = data.overview;
            renderGitOverview(data.overview);
          } else {
            loadGitOverview({ force: true });
          }
        })
        .catch(function(err) {
          alert('Failed to delete config: ' + err.message);
        });
    });
  }

  var homePageEl = $('homePage');
  if (homePageEl && homePageEl.dataset.bound !== 'true') {
    homePageEl.dataset.bound = 'true';
    homePageEl.addEventListener('click', function(e) {
      var launchBtn = e.target.closest('[data-launch-app]');
      if (!launchBtn) return;
      var app = launchBtn.getAttribute('data-launch-app');
      if (!app) return;

      var origHtml = launchBtn.innerHTML;
      launchBtn.classList.add('working');
      launchBtn.innerHTML = '<span>' + escapeHtml(t('working')) + '</span>';

      fetch('/api/open-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app: app })
      })
        .then(function(res) {
          if (!res.ok) return res.json().then(function(j) { throw new Error(j.message || 'Launch failed'); });
          return res.json();
        })
        .then(function() {
          launchBtn.classList.remove('working');
          launchBtn.classList.add('success');
          launchBtn.innerHTML = '<span>✓ ' + escapeHtml(t('appLaunched')) + '</span>';
          setTimeout(function() {
            launchBtn.classList.remove('success');
            launchBtn.innerHTML = origHtml;
          }, 2000);
        })
        .catch(function(err) {
          launchBtn.classList.remove('working');
          launchBtn.innerHTML = origHtml;
          alert(t('launchFailed') + (err.message || 'Unknown error'));
        });
    });
  }

  var closeBtn = $('closeRepoBtn');
  if (closeBtn && closeBtn.dataset.bound !== 'true') {
    closeBtn.dataset.bound = 'true';
    closeBtn.addEventListener('click', function() {
      exitToHome();
    });
  }
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
  if (state.contributions || state.globalContributions) renderCalendar(state.contributions, state.globalContributions);
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

  var addBtn = $('addRepoBtn');
  if (addBtn) {
    if (canOpenRepositoryLocally()) {
      addBtn.style.display = '';
      addBtn.title = 'Add or Create Git Repository';
      addBtn.addEventListener('click', function() {
        addBtn.disabled = true;
        fetch('/api/add-repository', { method: 'POST' })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (data.status === 'cancelled') return;
            if (data.error) { alert(data.error); return; }
            if (data.path) {
              loadRepoHistory().then(function() {
                switchRepository(data.path);
              });
            }
          })
          .catch(function(err) { alert('Failed: ' + err.message); })
          .finally(function() { addBtn.disabled = false; });
      });
    }
  }

}

function initSecurityControls() {
  var external = $('allowExternalAccess');
  var rotate = $('rotateToken');
  if (!external || !rotate) return;
  renderSecurityControls();

  external.addEventListener('change', function() {
    if (!external.checked) {
      if (!confirm(t('disableExternalConfirm'))) {
        external.checked = true;
        return;
      }
    }
    updateExternalAccess(external.checked);
  });
  rotate.addEventListener('click', showTokenConfirmModal);
  $('openSettings').addEventListener('click', openSettings);
  $('closeSettings').addEventListener('click', closeSettings);
  $('copyAccessUrl').addEventListener('click', copyAccessUrl);
  $('cancelRotateToken').addEventListener('click', hideTokenConfirmModal);
  $('confirmRotateToken').addEventListener('click', rotateToken);
  $('decomposeTaskDetail').addEventListener('click', decomposeTaskDetail);
  $('editTaskDetail').addEventListener('click', function() { setTaskDetailEditing(true); });
  $('cancelTaskEdit').addEventListener('click', function() { setTaskDetailEditing(false); });
  $('saveTaskDetail').addEventListener('click', saveTaskDetail);
  $('closeTaskDetail').addEventListener('click', hideTaskDetail);
  $('tokenConfirmModal').addEventListener('click', function(event) {
    if (event.target === $('tokenConfirmModal')) hideTokenConfirmModal();
  });
  $('taskDetailModal').addEventListener('click', function(event) {
    if (event.target === $('taskDetailModal')) hideTaskDetail();
  });
  document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape') {
      hideTokenConfirmModal();
      hideTaskDetail();
    }
  });
  loadSecuritySettings();
}

var THEMES = [
  { id: 'default', nameKey: 'themeDefault', defaultName: '经典翡翠', colorScheme: 'light', bg: '#f4f6f8', panel: '#ffffff', accent: '#068d6d', text: '#111827' },
  { id: 'dark', nameKey: 'themeDark', defaultName: '深邃夜空', colorScheme: 'dark', bg: '#0b0f17', panel: '#1e293b', accent: '#38bdf8', text: '#f8fafc' },
  { id: 'ocean', nameKey: 'themeOcean', defaultName: '湛蓝海洋', colorScheme: 'light', bg: '#f0f7ff', panel: '#ffffff', accent: '#2563eb', text: '#0f172a' },
  { id: 'purple', nameKey: 'themePurple', defaultName: '魅紫风暴', colorScheme: 'dark', bg: '#130d24', panel: '#1d1536', accent: '#a855f7', text: '#f5f3ff' }
];
var DEFAULT_THEME = 'default';

function getValidTheme(themeId) {
  if (!themeId || typeof themeId !== 'string') return DEFAULT_THEME;
  for (var i = 0; i < THEMES.length; i++) {
    if (THEMES[i].id === themeId) return themeId;
  }
  return DEFAULT_THEME;
}

function applyTheme(themeId) {
  var validId = getValidTheme(themeId);
  document.documentElement.setAttribute('data-theme', validId);
  try {
    localStorage.setItem('gmc_theme', validId);
  } catch (e) {}
  state.currentTheme = validId;
  renderThemeControls();
  if (typeof City3DEngine !== 'undefined' && City3DEngine.syncWithTheme) {
    City3DEngine.syncWithTheme(validId);
  }
}

function renderThemeControls() {
  var container = $('themeOptions');
  if (!container) return;
  var currentTheme = getValidTheme(state.currentTheme || (function() {
    try { return localStorage.getItem('gmc_theme'); } catch(e) { return null; }
  })());

  var html = '';
  THEMES.forEach(function(theme) {
    var isActive = theme.id === currentTheme;
    var activeClass = isActive ? ' active' : '';
    var title = t(theme.nameKey) || theme.defaultName;
    var activeText = t('activeTheme');

    html += '<div class="theme-card-option' + activeClass + '" data-theme-id="' + theme.id + '" tabindex="0" role="radio" aria-checked="' + (isActive ? 'true' : 'false') + '">' +
      '<div class="theme-card-preview" style="background:' + theme.bg + '; border-color:' + (theme.colorScheme === 'dark' ? '#334155' : '#cbd5e1') + ';">' +
        '<div class="theme-card-preview-bar">' +
          '<div class="theme-card-preview-dot" style="background:' + theme.accent + ';"></div>' +
          '<div class="theme-card-preview-pill" style="background:' + theme.panel + ';"></div>' +
        '</div>' +
        '<div class="theme-card-preview-bar">' +
          '<div class="theme-card-preview-pill" style="background:' + theme.text + '; opacity:0.7;"></div>' +
          '<div class="theme-card-preview-dot" style="background:' + theme.accent + '; opacity:0.5;"></div>' +
        '</div>' +
      '</div>' +
      '<div class="theme-card-header">' +
        '<span class="theme-card-title">' + escapeHtml(title) + '</span>' +
        '<span class="theme-card-badge">' + escapeHtml(activeText) + '</span>' +
      '</div>' +
    '</div>';
  });
  container.innerHTML = html;

  var cards = container.querySelectorAll('.theme-card-option');
  cards.forEach(function(card) {
    var themeId = card.getAttribute('data-theme-id');
    card.addEventListener('click', function() {
      applyTheme(themeId);
    });
    card.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        applyTheme(themeId);
      }
    });
  });
}

function initThemeControls() {
  var savedTheme = (function() {
    try {
      return localStorage.getItem('gmc_theme');
    } catch (e) {
      return null;
    }
  })();
  applyTheme(savedTheme);
}

function openSettings() {
  cancelTaskSpeech();
  state.settingsOpen = true;
  stopAgentMonitorPolling();
  state.previousViewBeforeSettings = !targetRepo ? 'home' : (state.activeView || 'git');
  var tabs = document.querySelector('.view-tabs');
  if (tabs) tabs.hidden = true;
  var closeBtn = $('closeRepoBtn');
  if (closeBtn) closeBtn.hidden = true;
  if ($('homePage')) $('homePage').hidden = true;
  if ($('city3dContainer')) $('city3dContainer').hidden = true;
  if (typeof City3DEngine !== 'undefined') City3DEngine.pause();
  if ($('gitPage')) $('gitPage').hidden = true;
  if ($('taskPage')) $('taskPage').hidden = true;
  $('settingsPage').hidden = false;
  renderSecurityControls();
  renderAccessQr();
  loadAgentSettings();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function closeSettings() {
  state.settingsOpen = false;
  $('settingsPage').hidden = true;
  if (!targetRepo) {
    if ($('homePage')) $('homePage').hidden = false;
    if ($('city3dContainer')) $('city3dContainer').hidden = false;
    if (typeof City3DEngine !== 'undefined') City3DEngine.resume();
    if ($('gitPage')) $('gitPage').hidden = true;
    if ($('taskPage')) $('taskPage').hidden = true;
    var tabs = document.querySelector('.view-tabs');
    if (tabs) tabs.hidden = true;
    var closeBtn = $('closeRepoBtn');
    if (closeBtn) closeBtn.hidden = true;
    if (state.gitOverview) {
      renderGitOverview(state.gitOverview);
    } else {
      loadGitOverview({ force: true });
    }
  } else {
    var closeBtn2 = $('closeRepoBtn');
    if (closeBtn2) closeBtn2.hidden = false;
    setActiveView(state.previousViewBeforeSettings === 'home' ? 'git' : (state.previousViewBeforeSettings || 'git'));
  }
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
    address.textContent = t('lanAddress') + displayAddress;
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
      alert(t('updateExternalFailed') + error.message);
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
    box.innerHTML = '<div class="qr-placeholder">' + escapeHtml(t('qrEnableExternal')) + '</div>';
    if (status) status.textContent = t('qrNeedExternal');
    return;
  }

  var accessUrl = currentAccessUrl();
  field.value = accessUrl;
  if (status) status.textContent = t('qrReady');
  if (state.qrUrl === accessUrl || state.qrLoading) return;

  state.qrLoading = true;
  box.innerHTML = '<div class="qr-placeholder">' + escapeHtml(t('qrGenerating')) + '</div>';
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
      box.innerHTML = data.svg || '<div class="qr-placeholder">' + escapeHtml(t('qrFailed')) + '</div>';
    })
    .catch(function(error) {
      state.qrUrl = '';
      box.innerHTML = '<div class="qr-placeholder">' + escapeHtml(t('qrFailed')) + '<br>' + escapeHtml(error.message) + '</div>';
      if (status) status.textContent = t('copyLinkFallback');
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
    if (status) status.textContent = t('linkCopied');
  }).catch(function() {
    field.focus();
    field.select();
  });
}

function showTokenConfirmModal() {
  if (!state.security.allowExternalAccess || state.security.localAccess === false) return;
  var modal = $('tokenConfirmModal');
  if (!modal) return;
  modal.classList.add('visible');
  $('confirmRotateToken').focus();
}

function hideTokenConfirmModal() {
  var modal = $('tokenConfirmModal');
  if (!modal) return;
  modal.classList.remove('visible');
}

function rotateToken() {
  if (!state.security.allowExternalAccess || state.security.localAccess === false) return;
  hideTokenConfirmModal();
  var button = $('rotateToken');
  var confirmButton = $('confirmRotateToken');
  var status = $('qrStatus');
  if (button) {
    button.disabled = true;
    button.textContent = t('refreshButtonWorking');
  }
  if (confirmButton) confirmButton.disabled = true;
  if (status) status.textContent = t('refreshInProgress');
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
      if (status) status.textContent = t('refreshDone');
    })
    .catch(function(error) {
      if (status) status.textContent = t('refreshFailed') + error.message;
      else alert(t('refreshFailed') + error.message);
    })
    .finally(function() {
      if (button) {
        button.disabled = false;
        button.textContent = t('refreshToken');
      }
      if (confirmButton) confirmButton.disabled = false;
    });
}

var AGENTS = ['codex', 'claude', 'antigravity', 'opencode'];

function loadAgentSettings() {
  fetch('/api/agent', { cache: 'no-store' })
    .then(function(res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function(data) {
      state.commitAgent = data.commitAgent || data.agent || 'codex';
      state.taskAgent = data.taskAgent || data.agent || 'codex';
      renderAgentOptions('commit');
      renderAgentOptions('task');
    })
    .catch(function() {
      state.commitAgent = 'codex';
      state.taskAgent = 'codex';
      renderAgentOptions('commit');
      renderAgentOptions('task');
    });
}

function loadRepositoryTaskAgent() {
  var selector = $('repositoryTaskAgentSelector');
  if (selector) selector.hidden = !targetRepo;
  if (!targetRepo) {
    return Promise.resolve(null);
  }
  var repoAtStart = targetRepo;
  return fetch('/api/agent?repo=' + encodeURIComponent(targetRepo), { cache: 'no-store' })
    .then(function(res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function(data) {
      if (targetRepo !== repoAtStart) return null;
      state.repositoryTaskAgent = data.repositoryTaskAgent || data.taskAgent || data.agent || 'codex';
      renderAgentOptions('repositoryTask');
      return state.repositoryTaskAgent;
    })
    .catch(function(error) {
      if (targetRepo !== repoAtStart) return null;
      var status = $('repositoryTaskAgentStatus');
      if (status) status.textContent = t('agentSettingSaveFailed') + error.message;
      renderAgentOptions('repositoryTask');
      return null;
    });
}

function renderAgentOptions(scope) {
  var stateKey = scope + 'Agent';
  var container = $(scope + 'AgentOptions');
  if (!container) return;
  var currentAgent = state[stateKey] || 'codex';
  var inputName = 'gmc-' + scope + '-agent';
  var html = '';
  AGENTS.forEach(function(name) {
    var checked = name === currentAgent ? ' checked' : '';
    html += '<label class="radio-label"><input type="radio" name="' + inputName + '" value="' + name + '"' + checked + '>' +
      '<span class="radio-indicator"></span><span class="radio-text">' + name + '</span></label>';
  });
  container.innerHTML = html;

  var radios = container.querySelectorAll('input[type="radio"]');
  radios.forEach(function(radio) {
    radio.addEventListener('change', function() {
      if (this.checked) {
        updateAgentSetting(scope, this.value);
      }
    });
  });
}

function updateAgentSetting(scope, agent) {
  var status = $(scope + 'AgentStatus');
  var apiScope = scope;
  var endpoint = '/api/agent';
  if (scope === 'repositoryTask') {
    apiScope = 'repository-task';
    endpoint += '?repo=' + encodeURIComponent(targetRepo);
  }
  if (status) status.textContent = t('working');
  var inputs = document.querySelectorAll('input[name="gmc-' + scope + '-agent"]');
  if (inputs) {
    inputs.forEach(function(input) { input.disabled = true; });
  }
  fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: apiScope, agent: agent })
  })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
        return data;
      });
    })
    .then(function(data) {
      state[scope + 'Agent'] = data.agent || agent;
      if (status) status.textContent = t('agentSettingSaved');
    })
    .catch(function(error) {
      if (status) status.textContent = t('agentSettingSaveFailed') + error.message;
      renderAgentOptions(scope);
    })
    .finally(function() {
      if (inputs) {
        inputs.forEach(function(input) { input.disabled = false; });
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
  if (!time) return t('recentlyVisited');
  var diff = Date.now() - time;
  var minute = 60 * 1000;
  var hour = 60 * minute;
  var day = 24 * hour;
  if (diff < minute) return t('justNow');
  if (diff < hour) return Math.floor(diff / minute) + t('agoMinute');
  if (diff < day) return Math.floor(diff / hour) + t('agoHour');
  if (diff < day * 7) return Math.floor(diff / day) + t('agoDay');
  return new Date(time).toLocaleDateString();
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  var k = 1024;
  var sizes = ['B', 'KB', 'MB', 'GB'];
  var i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function(ch) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
  });
}

/* =========================================================================
 * City3DEngine: 3D Aerial City Map from Managed Repositories (Git Contribution HDR)
 * ========================================================================= */
var City3DEngine = (function() {
  var containerEl = null;
  var canvasEl = null;
  var repoCardEl = null;
  var renderer = null;
  var scene = null;
  var camera = null;
  var animationId = null;
  var isInitialized = false;
  var isRunning = false;

  // Scene Objects
  var cityGroup = null;
  var skyGroup = null;
  var cloudsGroup = null;
  var rainGroup = null;
  var streetlightsGroup = null;
  var trafficGroup = null;
  var sunLight = null;
  var moonLight = null;
  var ambientLight = null;
  var hemiLight = null;
  var starField = null;

  // Dynamic Scene Elements
  var repoBadges = [];
  var districtData = [];
  var trafficCars = [];
  var beaconMeshes = [];
  var streetlightLenses = [];
  var streetlightGlowDecals = [];
  var buildingMaterials = [];
  var roadMaterials = [];

  // Emissive Texture Cache per Building/Repo (Git Contribution Heatmap Light Maps)
  var emissiveTexCache = {};

  // Textures
  var aoContactTex = null;
  var lampGlowTex = null;
  var billboardCanvas = null;
  var billboardCtx = null;
  var billboardTex = null;

  // Day & Night Transition State
  var dayNightMode = 'night';
  var targetMode = 'night';
  var modeTransition = 1.0; // 0 = day, 1 = night
  var manualModeOverride = false;

  // Weather System
  var isRaining = true;
  var rainPoints = null;
  var rainPositions = null;
  var rainCount = 2400;

  // Airplane Cruise Flight
  var isAutoCruising = true;
  var cruiseSpeed = 1.0;
  var cruiseProgress = 0.0;
  var flightSpline = null;
  var bankAngle = 0;
  var targetBankAngle = 0;
  var currentLookAt = null;
  var targetLookAt = null;

  // Free Orbit Controls
  var isDragging = false;
  var previousPointer = { x: 0, y: 0 };
  var orbit = { theta: 0.8, phi: 0.62, radius: 240, target: { x: 0, y: 15, z: 0 } };
  var userInteractionTimer = null;
  var raycaster = null;
  var mouse = null;
  var hoveredBadge = null;

  // Data cache
  var cachedCityData = null;

  // Zen Mode
  var isZenMode = false;
  var lastTimestamp = 0;
  var totalElapsedTime = 0;

  function init() {
    if (isInitialized) {
      resume();
      return;
    }

    containerEl = document.getElementById('city3dContainer');
    canvasEl = document.getElementById('city3dCanvas');
    repoCardEl = document.getElementById('city3dRepoCard');
    if (!containerEl || !canvasEl) return;

    if (typeof THREE === 'undefined') {
      loadThreeScript(function() {
        init();
      });
      return;
    }

    try {
      var isSidebarCollapsed = document.body.classList.contains('sidebar-collapsed');
      var width = containerEl.clientWidth || (window.innerWidth - (isSidebarCollapsed ? 0 : 260));
      if (window.innerWidth <= 960) width = window.innerWidth;
      var height = containerEl.clientHeight || window.innerHeight;
      if (width <= 0) width = window.innerWidth;
      if (height <= 0) height = window.innerHeight;

      renderer = new THREE.WebGLRenderer({
        canvas: canvasEl,
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance'
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.15;

      scene = new THREE.Scene();
      scene.background = new THREE.Color(0x060914);
      scene.fog = new THREE.FogExp2(0x070b18, 0.0018);

      camera = new THREE.PerspectiveCamera(50, width / height, 1, 3800);
      camera.position.set(160, 140, 220);

      currentLookAt = new THREE.Vector3(0, 15, 0);
      targetLookAt = new THREE.Vector3(0, 15, 0);

      raycaster = new THREE.Raycaster();
      mouse = new THREE.Vector2(-999, -999);

      setupLighting();
      setupSkyAndStars();
      createAOTex();
      createLampGlowTex();
      createAnimatedBillboardTexture();

      cityGroup = new THREE.Group();
      scene.add(cityGroup);

      trafficGroup = new THREE.Group();
      scene.add(trafficGroup);

      cloudsGroup = new THREE.Group();
      scene.add(cloudsGroup);

      rainGroup = new THREE.Group();
      scene.add(rainGroup);

      streetlightsGroup = new THREE.Group();
      scene.add(streetlightsGroup);

      setupCloudsAndRain();
      bindEvents();
      bindHudControls();

      var currentTheme = (function() {
        try { return localStorage.getItem('gmc_theme') || 'default'; } catch(e) { return 'default'; }
      })();
      syncWithTheme(currentTheme);

      isInitialized = true;
      isRunning = true;
      lastTimestamp = performance.now();
      requestAnimationFrame(animate);

      if (cachedCityData && cachedCityData.length) {
        buildCity(cachedCityData);
      } else if (typeof state !== 'undefined' && state.gitOverview && state.gitOverview.cityData) {
        buildCity(state.gitOverview.cityData);
      } else {
        buildCity(null);
        fetchCityData();
      }
    } catch (err) {
      console.warn('City3DEngine init failed:', err);
    }
  }

  function loadThreeScript(cb) {
    if (typeof THREE !== 'undefined') {
      if (typeof cb === 'function') cb();
      return;
    }
    var existing = document.querySelector('script[src*="three"]');
    if (existing) {
      existing.addEventListener('load', function() {
        if (typeof cb === 'function') cb();
      });
      existing.addEventListener('error', function() {
        var s2 = document.createElement('script');
        s2.src = 'https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js';
        s2.onload = function() { if (typeof cb === 'function') cb(); };
        document.head.appendChild(s2);
      });
      return;
    }
    var s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
    s.onload = function() { if (typeof cb === 'function') cb(); };
    s.onerror = function() {
      var s2 = document.createElement('script');
      s2.src = 'https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js';
      s2.onload = function() { if (typeof cb === 'function') cb(); };
      document.head.appendChild(s2);
    };
    document.head.appendChild(s);
  }

  function setupLighting() {
    ambientLight = new THREE.AmbientLight(0x475569, 0.45);
    scene.add(ambientLight);

    hemiLight = new THREE.HemisphereLight(0xcce0ff, 0x334155, 0.75);
    scene.add(hemiLight);

    sunLight = new THREE.DirectionalLight(0xfff5e0, 1.25);
    sunLight.position.set(240, 340, 180);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.width = 1024;
    sunLight.shadow.mapSize.height = 1024;
    sunLight.shadow.camera.near = 10;
    sunLight.shadow.camera.far = 900;
    sunLight.shadow.camera.left = -280;
    sunLight.shadow.camera.right = 280;
    sunLight.shadow.camera.top = 280;
    sunLight.shadow.camera.bottom = -280;
    sunLight.shadow.bias = -0.0004;
    scene.add(sunLight);

    moonLight = new THREE.DirectionalLight(0x818cf8, 0.55);
    moonLight.position.set(-180, 260, -140);
    scene.add(moonLight);
  }

  function setupSkyAndStars() {
    skyGroup = new THREE.Group();
    scene.add(skyGroup);

    var starCount = 1400;
    var starGeo = new THREE.BufferGeometry();
    var starPositions = new Float32Array(starCount * 3);
    var starColors = new Float32Array(starCount * 3);

    for (var i = 0; i < starCount; i++) {
      var u = Math.random();
      var v = Math.random();
      var theta = u * 2.0 * Math.PI;
      var phi = Math.acos(2.0 * v - 1.0);
      var r = 1200 + Math.random() * 400;
      var x = r * Math.sin(phi) * Math.cos(theta);
      var y = Math.abs(r * Math.cos(phi)) + 60;
      var z = r * Math.sin(phi) * Math.sin(theta);

      starPositions[i * 3] = x;
      starPositions[i * 3 + 1] = y;
      starPositions[i * 3 + 2] = z;

      var colType = Math.random();
      if (colType > 0.8) {
        starColors[i * 3] = 0.6; starColors[i * 3 + 1] = 0.8; starColors[i * 3 + 2] = 1.0;
      } else if (colType > 0.6) {
        starColors[i * 3] = 1.0; starColors[i * 3 + 1] = 0.9; starColors[i * 3 + 2] = 0.6;
      } else {
        starColors[i * 3] = 0.95; starColors[i * 3 + 1] = 0.95; starColors[i * 3 + 2] = 1.0;
      }
    }

    starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    starGeo.setAttribute('color', new THREE.BufferAttribute(starColors, 3));

    var starMat = new THREE.PointsMaterial({
      size: 3.2,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false
    });
    starField = new THREE.Points(starGeo, starMat);
    skyGroup.add(starField);
  }

  function setupCloudsAndRain() {
    var cloudMat = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0,
      roughness: 0.9,
      transparent: true,
      opacity: 0.52
    });
    var cloudGeo1 = new THREE.DodecahedronGeometry(22, 1);
    var cloudGeo2 = new THREE.DodecahedronGeometry(16, 1);

    for (var c = 0; c < 14; c++) {
      var cloudGroup = new THREE.Group();
      var p1 = new THREE.Mesh(cloudGeo1, cloudMat);
      var p2 = new THREE.Mesh(cloudGeo2, cloudMat);
      p2.position.set(16, -3, 8);
      var p3 = new THREE.Mesh(cloudGeo2, cloudMat);
      p3.position.set(-16, -2, -6);
      cloudGroup.add(p1);
      cloudGroup.add(p2);
      cloudGroup.add(p3);

      var cx = (Math.random() - 0.5) * 800;
      var cy = 190 + Math.random() * 70;
      var cz = (Math.random() - 0.5) * 800;
      cloudGroup.position.set(cx, cy, cz);
      cloudGroup.scale.set(1.4, 0.45, 1.1);
      cloudGroup.userData = { speed: 4.5 + Math.random() * 4.0 };
      cloudsGroup.add(cloudGroup);
    }

    var rainGeo = new THREE.BufferGeometry();
    rainPositions = new Float32Array(rainCount * 3);
    for (var r = 0; r < rainCount; r++) {
      rainPositions[r * 3] = (Math.random() - 0.5) * 900;
      rainPositions[r * 3 + 1] = Math.random() * 260;
      rainPositions[r * 3 + 2] = (Math.random() - 0.5) * 900;
    }
    rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPositions, 3));

    var rainMat = new THREE.PointsMaterial({
      size: 2.2,
      color: 0x93c5fd,
      transparent: true,
      opacity: 0.65,
      depthWrite: false
    });
    rainPoints = new THREE.Points(rainGeo, rainMat);
    rainGroup.add(rainPoints);
  }

  // Dynamic Git Contribution Heatmap Light Texture (Reflects ONLY Surface Luminance, Preserves Building Color)
  function createContributionLightTexture(repo, item, bIndex, styleSeed) {
    var cacheKey = (repo ? repo.name : 'repo') + '_' + (item ? item.name : 'file') + '_' + bIndex;
    if (emissiveTexCache[cacheKey]) {
      return emissiveTexCache[cacheKey];
    }

    var canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    var ctx = canvas.getContext('2d');

    // Emissive base is strictly pure black (0 emission on walls and spandrels)
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, 256, 256);

    // Extract Git contribution calendar commit frequencies
    var contribs = (repo && repo.contributions) ? repo.contributions : {};
    var dates = Object.keys(contribs);
    var counts = [];
    if (dates.length > 0) {
      for (var d = 0; d < dates.length; d++) {
        counts.push(contribs[dates[d]] || 0);
      }
    }

    var bays = 8;
    var floors = 8;
    var cellW = 256 / bays;
    var cellH = 256 / floors;
    var padX = 3.2;
    var padY = 3.2;
    var winW = cellW - padX * 2;
    var winH = cellH - padY * 2;

    var fileHash = hashStr(item ? item.name : ('b_' + bIndex)) + (styleSeed || 0);

    for (var r = 0; r < floors; r++) {
      for (var c = 0; c < bays; c++) {
        var x = c * cellW + padX;
        var y = r * cellH + padY;

        // Map cell to Git contribution calendar index
        var cellIdx = (c + r * bays + (fileHash % 37)) % Math.max(1, counts.length || 64);
        var commitCount = counts.length > 0 ? (counts[cellIdx] || 0) : 0;

        // Realistic baseline developer activity distribution
        var pseudoActivity = ((fileHash * 17 + c * 23 + r * 31) % 100);
        var effectiveCount = commitCount > 0 ? commitCount : (pseudoActivity > 50 ? Math.floor(pseudoActivity / 18) : 0);

        if (effectiveCount > 0) {
          var brightness = 0.55;
          var winColor = 'rgba(255, 243, 199, '; // Warm golden white
          if (effectiveCount >= 8) {
            brightness = 1.0; // 1.0 * 1.25 emissiveIntensity = 1.25x HDR peak brightness
            winColor = 'rgba(255, 255, 255, '; // Blazing sprint white
          } else if (effectiveCount >= 4) {
            brightness = 0.85;
            winColor = 'rgba(254, 240, 138, '; // Bright yellow
          } else if (effectiveCount >= 2) {
            brightness = 0.70;
            winColor = 'rgba(253, 186, 116, '; // Amber
          } else {
            brightness = 0.50;
            winColor = 'rgba(224, 242, 254, '; // Soft cyan/white
          }

          ctx.fillStyle = winColor + brightness + ')';
          ctx.fillRect(x, y, winW, winH);

          // Realistic ceiling hot-spot
          var grad = ctx.createLinearGradient(x, y, x, y + winH);
          grad.addColorStop(0, 'rgba(255, 255, 255, ' + (brightness * 0.9) + ')');
          grad.addColorStop(0.35, 'rgba(255, 255, 255, ' + (brightness * 0.25) + ')');
          grad.addColorStop(1, 'rgba(0, 0, 0, 0.45)');
          ctx.fillStyle = grad;
          ctx.fillRect(x, y, winW, winH);

          // Horizontal window blind silhouettes
          ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
          ctx.fillRect(x, y + winH * 0.3, winW, 1.5);
          ctx.fillRect(x, y + winH * 0.6, winW, 1.5);
        } else if ((fileHash + c * 7 + r * 11) % 8 === 0) {
          // Faint standby ambient monitor glow in unoccupied rooms
          ctx.fillStyle = 'rgba(255, 180, 80, 0.18)';
          ctx.fillRect(x, y, winW, winH);
        }
      }
    }

    var tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    emissiveTexCache[cacheKey] = tex;
    return tex;
  }

  function createAOTex() {
    var canvasAO = document.createElement('canvas');
    canvasAO.width = 128;
    canvasAO.height = 128;
    var ctxAO = canvasAO.getContext('2d');
    ctxAO.clearRect(0, 0, 128, 128);

    var radGrad = ctxAO.createRadialGradient(64, 64, 8, 64, 64, 62);
    radGrad.addColorStop(0, 'rgba(0, 0, 0, 0.82)');
    radGrad.addColorStop(0.35, 'rgba(0, 0, 0, 0.55)');
    radGrad.addColorStop(0.7, 'rgba(0, 0, 0, 0.2)');
    radGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');

    ctxAO.fillStyle = radGrad;
    ctxAO.fillRect(0, 0, 128, 128);

    aoContactTex = new THREE.CanvasTexture(canvasAO);
  }

  function createLampGlowTex() {
    var canvasLamp = document.createElement('canvas');
    canvasLamp.width = 128;
    canvasLamp.height = 128;
    var ctxLamp = canvasLamp.getContext('2d');
    ctxLamp.clearRect(0, 0, 128, 128);

    var rad = ctxLamp.createRadialGradient(64, 64, 4, 64, 64, 60);
    rad.addColorStop(0, 'rgba(254, 240, 138, 0.85)');
    rad.addColorStop(0.3, 'rgba(251, 191, 36, 0.45)');
    rad.addColorStop(0.65, 'rgba(245, 158, 11, 0.15)');
    rad.addColorStop(1, 'rgba(245, 158, 11, 0)');

    ctxLamp.fillStyle = rad;
    ctxLamp.fillRect(0, 0, 128, 128);

    lampGlowTex = new THREE.CanvasTexture(canvasLamp);
  }

  function createAnimatedBillboardTexture() {
    billboardCanvas = document.createElement('canvas');
    billboardCanvas.width = 256;
    billboardCanvas.height = 128;
    billboardCtx = billboardCanvas.getContext('2d');
    billboardTex = new THREE.CanvasTexture(billboardCanvas);
  }

  function updateAnimatedBillboards(time) {
    if (!billboardCtx || !billboardTex) return;
    billboardCtx.fillStyle = '#050a14';
    billboardCtx.fillRect(0, 0, 256, 128);

    billboardCtx.strokeStyle = '#00f2fe';
    billboardCtx.lineWidth = 2;
    billboardCtx.beginPath();
    for (var x = 0; x < 256; x += 8) {
      var y = 64 + Math.sin(x * 0.05 + time * 3.5) * 22 + Math.cos(x * 0.02 - time * 2.0) * 12;
      if (x === 0) billboardCtx.moveTo(x, y);
      else billboardCtx.lineTo(x, y);
    }
    billboardCtx.stroke();

    for (var b = 0; b < 12; b++) {
      var barH = 15 + Math.abs(Math.sin(time * 2.5 + b * 0.8)) * 36;
      billboardCtx.fillStyle = (b % 2 === 0) ? '#ff0055' : '#10b981';
      billboardCtx.fillRect(20 + b * 18, 120 - barH, 12, barH);
    }

    billboardCtx.fillStyle = '#ffd166';
    billboardCtx.font = 'bold 16px monospace';
    billboardCtx.fillText('GMC METRICS · 24/7', 16, 22);

    billboardTex.needsUpdate = true;
  }

  function applyBuildingUVs(geometry, bw, bh, bd) {
    if (!geometry || !geometry.attributes || !geometry.attributes.uv) return;
    var uvs = geometry.attributes.uv.array;
    var bayW = 12.0;
    var floorH = 10.0;
    var uX = bw / bayW;
    var uZ = bd / bayW;
    var vY = bh / floorH;

    // Face 0 (+X)
    uvs[0] = 0;   uvs[1] = vY;
    uvs[2] = uZ;  uvs[3] = vY;
    uvs[4] = 0;   uvs[5] = 0;
    uvs[6] = uZ;  uvs[7] = 0;

    // Face 1 (-X)
    uvs[8]  = 0;   uvs[9]  = vY;
    uvs[10] = uZ;  uvs[11] = vY;
    uvs[12] = 0;   uvs[13] = 0;
    uvs[14] = uZ;  uvs[15] = 0;

    // Face 2 (+Y Top Roof)
    uvs[16] = 0;   uvs[17] = 1;
    uvs[18] = 1;   uvs[19] = 1;
    uvs[20] = 0;   uvs[21] = 0;
    uvs[22] = 1;   uvs[23] = 0;

    // Face 3 (-Y Bottom)
    uvs[24] = 0;   uvs[25] = 1;
    uvs[26] = 1;   uvs[27] = 1;
    uvs[28] = 0;   uvs[29] = 0;
    uvs[30] = 1;   uvs[31] = 0;

    // Face 4 (+Z Front)
    uvs[32] = 0;   uvs[33] = vY;
    uvs[34] = uX;  uvs[35] = vY;
    uvs[36] = 0;   uvs[37] = 0;
    uvs[38] = uX;  uvs[39] = 0;

    // Face 5 (-Z Back)
    uvs[40] = 0;   uvs[41] = vY;
    uvs[42] = uX;  uvs[43] = vY;
    uvs[44] = 0;   uvs[45] = 0;
    uvs[46] = uX;  uvs[47] = 0;

    geometry.attributes.uv.needsUpdate = true;
  }

  function hashStr(str) {
    var hash = 5381;
    var s = String(str || '');
    for (var i = 0; i < s.length; i++) {
      hash = ((hash << 5) + hash) + s.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  function computeBuildingHeight(fileSize, jitter) {
    var size = fileSize || 100;
    var logS = Math.log(size + 10) / Math.LN10;
    var h = Math.max(5, Math.min(110, 4.0 + Math.pow(logS, 2.08) * 3.8 + Math.sqrt(size) * 0.032));
    if (jitter != null) {
      h *= (1 + (jitter - 0.5) * 0.24);
    }
    return Math.max(4.5, h);
  }

  function clusterBuildings(files, tallestFile) {
    if (!files || !files.length) return [];
    var tallestName = tallestFile ? (tallestFile.name || tallestFile.path) : '';

    var landmarks = [];
    var regulars = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var fName = f.name || f.path || 'file';
      if (fName === tallestName || (f.size && f.size > 80000)) {
        landmarks.push({
          type: 'landmark',
          files: [f],
          size: f.size || 1000,
          name: fName,
          ext: f.ext || '',
          count: 1
        });
      } else {
        regulars.push(f);
      }
    }

    regulars.sort(function(a, b) { return (b.size || 0) - (a.size || 0); });

    var clusters = [];
    var currentGroup = [];
    for (var j = 0; j < regulars.length; j++) {
      var cur = regulars[j];
      if (currentGroup.length === 0) {
        currentGroup.push(cur);
      } else {
        var first = currentGroup[0];
        var ratio = (first.size && cur.size) ? (cur.size / first.size) : 1;
        if (currentGroup.length < 3 && (ratio >= 0.55 || (first.size < 8192 && cur.size < 8192))) {
          currentGroup.push(cur);
        } else {
          clusters.push(createClusterItem(currentGroup));
          currentGroup = [cur];
        }
      }
    }
    if (currentGroup.length > 0) {
      clusters.push(createClusterItem(currentGroup));
    }

    return landmarks.concat(clusters);
  }

  function createClusterItem(group) {
    if (group.length === 1) {
      var g0 = group[0];
      return {
        type: 'single',
        files: group,
        size: g0.size || 1000,
        name: g0.name || g0.path || 'file',
        ext: g0.ext || '',
        count: 1
      };
    }
    var totalSize = 0;
    for (var k = 0; k < group.length; k++) totalSize += (group[k].size || 0);
    var avgSize = totalSize / group.length;
    var firstName = group[0].name || group[0].path || 'file';
    return {
      type: 'compound',
      files: group,
      size: avgSize * 1.15,
      totalSize: totalSize,
      name: firstName + ' +' + (group.length - 1) + ' files',
      ext: group[0].ext || '',
      count: group.length
    };
  }

  function createRepoBannerSprite(repoName, totalFiles, maxFileSize, isNight, status) {
    var canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 160;
    var ctx = canvas.getContext('2d');

    var isConflict = status && status.conflicted;
    var hasChanges = status && (!status.clean || (status.staged + status.unstaged + status.untracked > 0));
    var isAhead = status && status.ahead > 0;
    var isBehind = status && status.behind > 0;

    var themeColor = '#00f2fe';
    var themeBg = isNight ? 'rgba(7, 12, 24, 0.94)' : 'rgba(255, 255, 255, 0.96)';
    var statusTag = '✓ CLEAN';
    var statusTagColor = isNight ? '#38bdf8' : '#059669';

    if (isConflict) {
      themeColor = '#ff0055';
      statusTag = '⚠️ CONFLICT';
      statusTagColor = '#ff0055';
    } else if (hasChanges) {
      var totalChanges = (status.staged || 0) + (status.unstaged || 0) + (status.untracked || 0);
      themeColor = '#f59e0b';
      statusTag = '⚡ ' + totalChanges + ' CHANGES';
      statusTagColor = '#f59e0b';
    } else if (isAhead || isBehind) {
      themeColor = '#a855f7';
      statusTag = '🚀 ↑' + (status.ahead || 0) + ' ↓' + (status.behind || 0);
      statusTagColor = '#a855f7';
    }

    ctx.clearRect(0, 0, 512, 160);
    ctx.save();
    ctx.fillStyle = themeBg;
    ctx.strokeStyle = themeColor;
    ctx.lineWidth = 4;
    ctx.shadowColor = themeColor;
    ctx.shadowBlur = isNight ? 16 : 8;

    var x = 12, y = 12, w = 488, h = 136, r = 24;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = themeColor;
    ctx.beginPath();
    ctx.arc(60, 80, 26, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = isNight ? '#070c18' : '#ffffff';
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'round';
    if (isConflict) {
      ctx.fillStyle = isNight ? '#070c18' : '#ffffff';
      ctx.font = 'bold 30px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', 60, 80);
    } else if (hasChanges) {
      ctx.fillStyle = isNight ? '#070c18' : '#ffffff';
      ctx.font = 'bold 24px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('⚡', 60, 80);
    } else {
      ctx.beginPath();
      ctx.arc(52, 68, 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(68, 88, 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(52, 72);
      ctx.lineTo(52, 92);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(52, 78);
      ctx.quadraticCurveTo(68, 78, 68, 84);
      ctx.stroke();
    }

    ctx.textAlign = 'left';
    ctx.font = 'bold 36px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = isNight ? '#ffffff' : '#0f172a';
    ctx.textBaseline = 'middle';
    var displayName = repoName || 'repo';
    if (displayName.length > 15) displayName = displayName.slice(0, 13) + '...';
    ctx.fillText(displayName, 105, 62);

    ctx.font = '700 20px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = statusTagColor;
    ctx.fillText(statusTag, 105, 105);

    ctx.font = '500 19px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = isNight ? '#94a3b8' : '#64748b';
    var sizeStr = formatBytes(maxFileSize || 0);
    ctx.fillText(' · ' + (totalFiles || 0) + ' files', 105 + ctx.measureText(statusTag).width + 8, 105);

    var texture = new THREE.CanvasTexture(canvas);
    var spriteMat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false
    });
    var sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(42, 13.1, 1);
    return sprite;
  }

  function createFixed3DRooftopSign(text, colorHex, width, height) {
    var group = new THREE.Group();
    var signW = width || 9.5;
    var signH = height || 3.0;

    var steelMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.8, roughness: 0.3 });
    var postGeo = new THREE.BoxGeometry(0.3, signH * 1.3, 0.3);
    var post1 = new THREE.Mesh(postGeo, steelMat);
    post1.position.set(-signW * 0.38, signH * 0.65, 0);
    group.add(post1);

    var post2 = new THREE.Mesh(postGeo, steelMat);
    post2.position.set(signW * 0.38, signH * 0.65, 0);
    group.add(post2);

    var backGeo = new THREE.BoxGeometry(signW, signH, 0.35);
    var backMesh = new THREE.Mesh(backGeo, steelMat);
    backMesh.position.set(0, signH * 0.8, 0);
    group.add(backMesh);

    var canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 80;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0a0f1d';
    ctx.fillRect(0, 0, 256, 80);

    ctx.strokeStyle = colorHex;
    ctx.lineWidth = 4;
    ctx.shadowColor = colorHex;
    ctx.shadowBlur = 14;
    ctx.strokeRect(6, 6, 244, 68);

    ctx.font = 'bold 26px monospace';
    ctx.fillStyle = colorHex;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 40);

    var tex = new THREE.CanvasTexture(canvas);
    var faceMat = new THREE.MeshBasicMaterial({ map: tex });
    var faceGeo = new THREE.PlaneGeometry(signW * 0.96, signH * 0.88);
    var faceMesh = new THREE.Mesh(faceGeo, faceMat);
    faceMesh.position.set(0, signH * 0.8, 0.2);
    group.add(faceMesh);

    return group;
  }

  function buildCity(cityDataList) {
    if (cityDataList && cityDataList.length) {
      cachedCityData = cityDataList;
    }
    if (!cityGroup || !scene || !isInitialized) return;

    while (cityGroup.children.length > 0) {
      var obj = cityGroup.children[0];
      cityGroup.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(function(m) { m.dispose(); });
        else obj.material.dispose();
      }
    }

    while (trafficGroup.children.length > 0) {
      var tobj = trafficGroup.children[0];
      trafficGroup.remove(tobj);
      if (tobj.geometry) tobj.geometry.dispose();
      if (tobj.material) tobj.material.dispose();
    }

    while (streetlightsGroup.children.length > 0) {
      var lobj = streetlightsGroup.children[0];
      streetlightsGroup.remove(lobj);
      if (lobj.geometry) lobj.geometry.dispose();
      if (lobj.material) lobj.material.dispose();
    }

    // Dispose and reset emissive texture cache
    Object.keys(emissiveTexCache).forEach(function(k) {
      if (emissiveTexCache[k] && emissiveTexCache[k].dispose) emissiveTexCache[k].dispose();
    });
    emissiveTexCache = {};

    repoBadges = [];
    districtData = [];
    trafficCars = [];
    beaconMeshes = [];
    streetlightLenses = [];
    streetlightGlowDecals = [];
    buildingMaterials = [];
    roadMaterials = [];

    var repos = (cachedCityData && cachedCityData.length) ? cachedCityData : (cityDataList && cityDataList.length) ? cityDataList : [
      {
        name: 'vibe-git',
        path: '',
        totalFiles: 42,
        textCount: 36,
        nonTextCount: 6,
        tallest: { name: 'web.js', size: 180000, ext: 'js' },
        buildings: [
          { name: 'web.js', size: 180000, ext: 'js' },
          { name: 'gmc.js', size: 90000, ext: 'js' },
          { name: 'git.js', size: 25000, ext: 'js' },
          { name: 'agent.js', size: 14000, ext: 'js' },
          { name: 'README.md', size: 8000, ext: 'md' }
        ],
        contributions: {}
      }
    ];

    var N = repos.length;
    var cols = Math.max(1, Math.ceil(Math.sqrt(N)));
    var rows = Math.max(1, Math.ceil(N / cols));

    var BW = 110;
    var BD = 110;
    var RW = 34;
    var stepX = BW + RW;
    var stepZ = BD + RW;
    var originX = -(cols - 1) * stepX / 2;
    var originZ = -(rows - 1) * stepZ / 2;

    var totalCityW = cols * stepX + 160;
    var totalCityD = rows * stepZ + 160;

    var groundGeo = new THREE.PlaneGeometry(totalCityW, totalCityD);
    var groundMat = new THREE.MeshStandardMaterial({
      color: 0x111622,
      roughness: 0.9,
      metalness: 0.1
    });
    var groundMesh = new THREE.Mesh(groundGeo, groundMat);
    groundMesh.rotation.x = -Math.PI / 2;
    groundMesh.position.y = -0.1;
    groundMesh.receiveShadow = true;
    cityGroup.add(groundMesh);

    buildRoadNetwork(cols, rows, stepX, stepZ, originX, originZ, BW, BD, RW, totalCityW, totalCityD);

    for (var i = 0; i < N; i++) {
      var repo = repos[i];
      var col = i % cols;
      var row = Math.floor(i / cols);
      var posX = originX + col * stepX;
      var posZ = originZ + row * stepZ;

      buildDistrict(repo, i, posX, posZ, BW, BD);
      buildAvenueStreetTrees(posX, posZ, BW, BD);
    }

    buildStreetlights(cols, rows, stepX, stepZ, originX, originZ, BW, BD, RW);
    buildTrafficCars(cols, rows, stepX, stepZ, originX, originZ, totalCityW, totalCityD);
    buildFlightSpline(districtData);
  }

  function buildRoadNetwork(cols, rows, stepX, stepZ, originX, originZ, BW, BD, RW, totalW, totalD) {
    var roadMat = new THREE.MeshStandardMaterial({
      color: 0x1a2130,
      roughness: isRaining ? 0.2 : 0.85,
      metalness: isRaining ? 0.8 : 0.1
    });
    roadMaterials.push(roadMat);

    var lineMatYellow = new THREE.MeshBasicMaterial({ color: 0xf59e0b });
    var lineMatWhite = new THREE.MeshBasicMaterial({ color: 0xe2e8f0 });
    var zebraMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

    for (var c = 0; c <= cols; c++) {
      var rx = originX + (c - 0.5) * stepX;
      var roadV = new THREE.Mesh(new THREE.PlaneGeometry(RW, totalD), roadMat);
      roadV.rotation.x = -Math.PI / 2;
      roadV.position.set(rx, 0.05, 0);
      roadV.receiveShadow = true;
      cityGroup.add(roadV);

      var dividerV = new THREE.Mesh(new THREE.PlaneGeometry(0.8, totalD), lineMatYellow);
      dividerV.rotation.x = -Math.PI / 2;
      dividerV.position.set(rx, 0.08, 0);
      cityGroup.add(dividerV);

      var laneV1 = new THREE.Mesh(new THREE.PlaneGeometry(0.4, totalD), lineMatWhite);
      laneV1.rotation.x = -Math.PI / 2;
      laneV1.position.set(rx - 7.5, 0.07, 0);
      cityGroup.add(laneV1);

      var laneV2 = new THREE.Mesh(new THREE.PlaneGeometry(0.4, totalD), lineMatWhite);
      laneV2.rotation.x = -Math.PI / 2;
      laneV2.position.set(rx + 7.5, 0.07, 0);
      cityGroup.add(laneV2);
    }

    for (var r = 0; r <= rows; r++) {
      var rz = originZ + (r - 0.5) * stepZ;
      var roadH = new THREE.Mesh(new THREE.PlaneGeometry(totalW, RW), roadMat);
      roadH.rotation.x = -Math.PI / 2;
      roadH.position.set(0, 0.05, rz);
      roadH.receiveShadow = true;
      cityGroup.add(roadH);

      var dividerH = new THREE.Mesh(new THREE.PlaneGeometry(totalW, 0.8), lineMatYellow);
      dividerH.rotation.x = -Math.PI / 2;
      dividerH.position.set(0, 0.08, rz);
      cityGroup.add(dividerH);

      var laneH1 = new THREE.Mesh(new THREE.PlaneGeometry(totalW, 0.4), lineMatWhite);
      laneH1.rotation.x = -Math.PI / 2;
      laneH1.position.set(0, 0.07, rz - 7.5);
      cityGroup.add(laneH1);

      var laneH2 = new THREE.Mesh(new THREE.PlaneGeometry(totalW, 0.4), lineMatWhite);
      laneH2.rotation.x = -Math.PI / 2;
      laneH2.position.set(0, 0.07, rz + 7.5);
      cityGroup.add(laneH2);
    }

    var zebraBarGeo = new THREE.PlaneGeometry(1.4, 4.5);
    for (var c2 = 0; c2 <= cols; c2++) {
      for (var r2 = 0; r2 <= rows; r2++) {
        var ix = originX + (c2 - 0.5) * stepX;
        var iz = originZ + (r2 - 0.5) * stepZ;

        for (var bar = -3; bar <= 3; bar++) {
          var zN = new THREE.Mesh(zebraBarGeo, zebraMat);
          zN.rotation.x = -Math.PI / 2;
          zN.position.set(ix + bar * 2.2, 0.09, iz - RW * 0.55);
          cityGroup.add(zN);

          var zS = new THREE.Mesh(zebraBarGeo, zebraMat);
          zS.rotation.x = -Math.PI / 2;
          zS.position.set(ix + bar * 2.2, 0.09, iz + RW * 0.55);
          cityGroup.add(zS);

          var zW = new THREE.Mesh(zebraBarGeo, zebraMat);
          zW.rotation.x = -Math.PI / 2;
          zW.rotation.z = Math.PI / 2;
          zW.position.set(ix - RW * 0.55, 0.09, iz + bar * 2.2);
          cityGroup.add(zW);

          var zE = new THREE.Mesh(zebraBarGeo, zebraMat);
          zE.rotation.x = -Math.PI / 2;
          zE.rotation.z = Math.PI / 2;
          zE.position.set(ix + RW * 0.55, 0.09, iz + bar * 2.2);
          cityGroup.add(zE);
        }
      }
    }
  }

  function buildAvenueStreetTrees(posX, posZ, BW, BD) {
    var trunkGeo = new THREE.CylinderGeometry(0.3, 0.45, 3.4, 6);
    var trunkMat = new THREE.MeshStandardMaterial({ color: 0x5c3d2e, roughness: 0.9 });
    var folMat1 = new THREE.MeshStandardMaterial({ color: 0x16a34a, roughness: 0.75 });
    var folMat2 = new THREE.MeshStandardMaterial({ color: 0x15803d, roughness: 0.75 });
    var folGeo = new THREE.SphereGeometry(1.8, 8, 8);
    var grateGeo = new THREE.BoxGeometry(2.4, 0.1, 2.4);
    var grateMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.8 });

    var halfW = BW / 2 - 2.5;
    var halfD = BD / 2 - 2.5;
    var steps = 6;

    for (var s = 0; s < steps; s++) {
      var tOffset = -halfW + (s + 0.5) * (BW / steps);

      var treeCoords = [
        [tOffset, -halfD],
        [tOffset, halfD],
        [-halfW, tOffset],
        [halfW, tOffset]
      ];

      for (var tc = 0; tc < treeCoords.length; tc++) {
        var tx = posX + treeCoords[tc][0];
        var tz = posZ + treeCoords[tc][1];

        var tGroup = new THREE.Group();
        tGroup.position.set(tx, 1.8, tz);

        var grate = new THREE.Mesh(grateGeo, grateMat);
        grate.position.y = 0.05;
        tGroup.add(grate);

        var trunk = new THREE.Mesh(trunkGeo, trunkMat);
        trunk.position.y = 1.7;
        tGroup.add(trunk);

        var folMesh = new THREE.Mesh(folGeo, (s % 2 === 0) ? folMat1 : folMat2);
        folMesh.position.y = 4.2;
        folMesh.scale.set(1.0, 1.35, 1.0);
        folMesh.castShadow = true;
        tGroup.add(folMesh);

        cityGroup.add(tGroup);
      }
    }
  }

  function buildStreetlights(cols, rows, stepX, stepZ, originX, originZ, BW, BD, RW) {
    var poleMat = new THREE.MeshStandardMaterial({ color: 0x64748b, metalness: 0.8, roughness: 0.3 });
    var poleGeo = new THREE.CylinderGeometry(0.25, 0.35, 8.0, 6);
    var armGeo = new THREE.BoxGeometry(3.5, 0.25, 0.25);
    var headGeo = new THREE.BoxGeometry(1.0, 0.4, 0.8);
    var decalGeo = new THREE.PlaneGeometry(9.0, 9.0);

    for (var c = 0; c < cols; c++) {
      for (var r = 0; r < rows; r++) {
        var px = originX + c * stepX;
        var pz = originZ + r * stepZ;

        var lampOffsets = [
          [-BW / 2 - 2.5, -25, -Math.PI / 2],
          [-BW / 2 - 2.5, 25, -Math.PI / 2],
          [BW / 2 + 2.5, -25, Math.PI / 2],
          [BW / 2 + 2.5, 25, Math.PI / 2],
          [-25, -BD / 2 - 2.5, Math.PI],
          [25, -BD / 2 - 2.5, Math.PI],
          [-25, BD / 2 + 2.5, 0],
          [25, BD / 2 + 2.5, 0]
        ];

        for (var l = 0; l < lampOffsets.length; l++) {
          var lx = px + lampOffsets[l][0];
          var lz = pz + lampOffsets[l][1];
          var rot = lampOffsets[l][2];

          var lampGroup = new THREE.Group();
          lampGroup.position.set(lx, 0, lz);
          lampGroup.rotation.y = rot;

          var post = new THREE.Mesh(poleGeo, poleMat);
          post.position.y = 4.0;
          lampGroup.add(post);

          var arm = new THREE.Mesh(armGeo, poleMat);
          arm.position.set(1.4, 7.8, 0);
          lampGroup.add(arm);

          var lensMat = new THREE.MeshStandardMaterial({
            color: 0xfef08a,
            emissive: new THREE.Color(0xfbbf24),
            emissiveIntensity: 2.5
          });
          var head = new THREE.Mesh(headGeo, lensMat);
          head.position.set(2.8, 7.6, 0);
          lampGroup.add(head);
          streetlightLenses.push(lensMat);

          streetlightsGroup.add(lampGroup);

          if (lampGlowTex) {
            var decalMat = new THREE.MeshBasicMaterial({
              map: lampGlowTex,
              transparent: true,
              opacity: 0.45,
              depthWrite: false
            });
            var decal = new THREE.Mesh(decalGeo, decalMat);
            decal.rotation.x = -Math.PI / 2;
            decal.position.set(lx + Math.sin(rot) * 2.8, 0.08, lz + Math.cos(rot) * 2.8);
            streetlightsGroup.add(decal);
            streetlightGlowDecals.push(decalMat);
          }
        }
      }
    }
  }

  function buildArchitecturalStructure(districtGroup, item, bIndex, slot, repo, posX, posZ, isNight, isTallest, roofMat, groundMat, buildingSeed) {
    var styleSeed = hashStr(item.name || ('file_' + bIndex)) + buildingSeed;
    var styleType = isTallest ? 0 : (item.type === 'compound' ? 4 : (styleSeed % 6));

    var jitter = ((styleSeed % 100) / 100);
    var bHeight = computeBuildingHeight(item.size, isTallest ? 0.5 : jitter);
    if (isTallest) {
      bHeight = Math.max(bHeight, 55);
    }

    var isCompound = item.type === 'compound';
    var bw = Math.max(6.0, slot.w * (isCompound ? 1.35 : (0.85 + (styleSeed % 3) * 0.1)));
    var bd = Math.max(6.0, slot.d * (isCompound ? 1.35 : (0.85 + ((styleSeed + 1) % 3) * 0.1)));
    var bx = slot.x;
    var bz = slot.z;

    // Distinct Procedural Building Material Colors (Preserved in daylight & nighttime ambient)
    var palColors = [0x1e3a8a, 0x0284c7, 0xf8fafc, 0xd8cfbe, 0x94a3b8, 0xc25e3e, 0x065f46, 0x1e293b];
    var colHex = palColors[styleSeed % palColors.length];
    var isGlass = (styleSeed % 3 === 0);

    // Git Contribution Heatmap Emissive Light Texture (Only modulates window brightness, 1.25x HDR)
    var contribLightTex = createContributionLightTexture(repo, item, bIndex, styleSeed);
    var curEmissiveIntensity = (targetMode === 'night') ? 1.25 : 0.0;

    var facadeMat = new THREE.MeshStandardMaterial({
      color: colHex,
      roughness: isGlass ? 0.22 : 0.65,
      metalness: isGlass ? 0.80 : 0.20,
      emissiveMap: contribLightTex,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: curEmissiveIntensity
    });
    if (buildingMaterials.indexOf(facadeMat) === -1) buildingMaterials.push(facadeMat);

    // Multi-Material Array: [Right, Left, Top/Roof, Bottom, Front, Back]
    // Crucial: Top (+Y) face uses roofMat (Clean slate/concrete, ZERO windows or light textures on roofs!)
    var multiMats = [facadeMat, facadeMat, roofMat, groundMat, facadeMat, facadeMat];

    var accentMat = new THREE.MeshStandardMaterial({
      color: isNight ? 0x38bdf8 : 0x0284c7,
      roughness: 0.2,
      metalness: 0.85
    });

    // Ground Contact AO Shadow Disc
    if (aoContactTex) {
      var aoGeo = new THREE.PlaneGeometry(bw * 1.45, bd * 1.45);
      var aoMat = new THREE.MeshBasicMaterial({
        map: aoContactTex,
        transparent: true,
        opacity: 0.72,
        depthWrite: false
      });
      var aoMesh = new THREE.Mesh(aoGeo, aoMat);
      aoMesh.rotation.x = -Math.PI / 2;
      aoMesh.position.set(bx, 1.82, bz);
      districtGroup.add(aoMesh);
    }

    var buildingTopY = 1.8 + bHeight;
    var buildingCenterX = posX + bx;
    var buildingCenterZ = posZ + bz;

    if (styleType === 0) {
      // Style 0: Art Deco / Stepped Skyscraper
      var t1H = bHeight * 0.45;
      var t2H = bHeight * 0.33;
      var t3H = bHeight * 0.22;

      var t1Geo = new THREE.BoxGeometry(bw, t1H, bd);
      applyBuildingUVs(t1Geo, bw, t1H, bd);
      var t1Mesh = new THREE.Mesh(t1Geo, multiMats);
      t1Mesh.position.set(bx, 1.8 + t1H / 2, bz);
      t1Mesh.castShadow = true;
      t1Mesh.receiveShadow = true;
      districtGroup.add(t1Mesh);

      var t2Geo = new THREE.BoxGeometry(bw * 0.76, t2H, bd * 0.76);
      applyBuildingUVs(t2Geo, bw * 0.76, t2H, bd * 0.76);
      var t2Mesh = new THREE.Mesh(t2Geo, multiMats);
      t2Mesh.position.set(bx, 1.8 + t1H + t2H / 2, bz);
      t2Mesh.castShadow = true;
      districtGroup.add(t2Mesh);

      var t3Geo = new THREE.BoxGeometry(bw * 0.52, t3H, bd * 0.52);
      applyBuildingUVs(t3Geo, bw * 0.52, t3H, bd * 0.52);
      var t3Mesh = new THREE.Mesh(t3Geo, multiMats);
      t3Mesh.position.set(bx, 1.8 + t1H + t2H + t3H / 2, bz);
      t3Mesh.castShadow = true;
      t3Mesh.userData = { repo: repo, item: item, height: bHeight };
      districtGroup.add(t3Mesh);

      var capGeo = new THREE.BoxGeometry(bw * 0.44, 1.6, bd * 0.44);
      var capMesh = new THREE.Mesh(capGeo, accentMat);
      capMesh.position.set(bx, buildingTopY + 0.8, bz);
      districtGroup.add(capMesh);

      buildingTopY += 1.6;
    } else if (styleType === 1) {
      // Style 1: Cylindrical Glass Rotunda Tower
      var cylR = Math.min(bw, bd) * 0.46;
      var cylGeo = new THREE.CylinderGeometry(cylR, cylR * 1.05, bHeight, 18);
      var cylMesh = new THREE.Mesh(cylGeo, facadeMat);
      cylMesh.position.set(bx, 1.8 + bHeight / 2, bz);
      cylMesh.castShadow = true;
      cylMesh.receiveShadow = true;
      cylMesh.userData = { repo: repo, item: item, height: bHeight };
      districtGroup.add(cylMesh);

      var ringGeo = new THREE.CylinderGeometry(cylR * 1.06, cylR * 1.06, 1.4, 18);
      var ringMesh = new THREE.Mesh(ringGeo, accentMat);
      ringMesh.position.set(bx, buildingTopY + 0.7, bz);
      districtGroup.add(ringMesh);

      var domeGeo = new THREE.SphereGeometry(cylR * 0.65, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      var domeMat = new THREE.MeshStandardMaterial({
        color: isNight ? 0x38bdf8 : 0x67e8f9,
        roughness: 0.15,
        metalness: 0.9
      });
      var domeMesh = new THREE.Mesh(domeGeo, domeMat);
      domeMesh.position.set(bx, buildingTopY + 1.4, bz);
      districtGroup.add(domeMesh);

      buildingTopY += 1.4 + cylR * 0.65;
    } else if (styleType === 2) {
      // Style 2: Beveled Crystal Diamond Prism
      var prismH = bHeight * 0.78;
      var pyrH = bHeight * 0.22;

      var bGeo2 = new THREE.BoxGeometry(bw, prismH, bd);
      applyBuildingUVs(bGeo2, bw, prismH, bd);
      var bMesh2 = new THREE.Mesh(bGeo2, multiMats);
      bMesh2.position.set(bx, 1.8 + prismH / 2, bz);
      bMesh2.castShadow = true;
      bMesh2.receiveShadow = true;
      bMesh2.userData = { repo: repo, item: item, height: bHeight };
      districtGroup.add(bMesh2);

      var pyrGeo = new THREE.ConeGeometry(Math.min(bw, bd) * 0.68, pyrH, 4);
      var pyrMat = new THREE.MeshStandardMaterial({
        color: isNight ? 0x0ea5e9 : 0x0284c7,
        roughness: 0.2,
        metalness: 0.8
      });
      var pyrMesh = new THREE.Mesh(pyrGeo, pyrMat);
      pyrMesh.rotation.y = Math.PI / 4;
      pyrMesh.position.set(bx, 1.8 + prismH + pyrH / 2, bz);
      districtGroup.add(pyrMesh);

      buildingTopY = 1.8 + prismH + pyrH;
    } else if (styleType === 3) {
      // Style 3: Interconnected Skybridge Twin Tower
      var twW = bw * 0.42;
      var twD = bd * 0.82;
      var twOff = bw * 0.28;

      var tAGeo = new THREE.BoxGeometry(twW, bHeight, twD);
      applyBuildingUVs(tAGeo, twW, bHeight, twD);
      var tA = new THREE.Mesh(tAGeo, multiMats);
      tA.position.set(bx - twOff, 1.8 + bHeight / 2, bz);
      tA.castShadow = true;
      tA.userData = { repo: repo, item: item, height: bHeight };
      districtGroup.add(tA);

      var tBGeo = new THREE.BoxGeometry(twW, bHeight * 0.92, twD);
      applyBuildingUVs(tBGeo, twW, bHeight * 0.92, twD);
      var tB = new THREE.Mesh(tBGeo, multiMats);
      tB.position.set(bx + twOff, 1.8 + (bHeight * 0.92) / 2, bz);
      tB.castShadow = true;
      districtGroup.add(tB);

      var bridgeGeo = new THREE.BoxGeometry(twOff * 2 + twW * 0.5, 2.2, twD * 0.45);
      var bridgeMesh = new THREE.Mesh(bridgeGeo, accentMat);
      bridgeMesh.position.set(bx, 1.8 + bHeight * 0.62, bz);
      districtGroup.add(bridgeMesh);

      var rA = new THREE.Mesh(new THREE.BoxGeometry(twW * 0.85, 1.2, twD * 0.85), roofMat);
      rA.position.set(bx - twOff, buildingTopY + 0.6, bz);
      districtGroup.add(rA);

      buildingTopY += 1.2;
    } else if (styleType === 4) {
      // Style 4: Modern Compound / Campus Wing Complex
      var podH = 3.4;
      var podGeo = new THREE.BoxGeometry(bw * 1.35, podH, bd * 1.35);
      var podMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.75 });
      var podMesh = new THREE.Mesh(podGeo, podMat);
      podMesh.position.set(bx, 1.8 + podH / 2, bz);
      podMesh.receiveShadow = true;
      districtGroup.add(podMesh);

      var mainW = bw * 0.78;
      var mainD = bd * 0.72;
      var mainH = bHeight;
      var mainGeo = new THREE.BoxGeometry(mainW, mainH, mainD);
      applyBuildingUVs(mainGeo, mainW, mainH, mainD);
      var mainMesh = new THREE.Mesh(mainGeo, multiMats);
      mainMesh.position.set(bx - bw * 0.22, 1.8 + podH + (mainH - podH) / 2, bz - bd * 0.1);
      mainMesh.castShadow = true;
      mainMesh.userData = { repo: repo, item: item, height: bHeight };
      districtGroup.add(mainMesh);

      var subW = bw * 0.7;
      var subD = bd * 0.7;
      var subH = (bHeight - podH) * 0.62;
      var subGeo = new THREE.BoxGeometry(subW, subH, subD);
      applyBuildingUVs(subGeo, subW, subH, subD);
      var subMesh = new THREE.Mesh(subGeo, multiMats);
      subMesh.position.set(bx + bw * 0.26, 1.8 + podH + subH / 2, bz + bd * 0.15);
      subMesh.castShadow = true;
      districtGroup.add(subMesh);

      var rSub = new THREE.Mesh(new THREE.BoxGeometry(subW * 0.88, 1.2, subD * 0.88), roofMat);
      rSub.position.set(bx + bw * 0.26, 1.8 + podH + subH + 0.6, bz + bd * 0.15);
      districtGroup.add(rSub);

      var rMain = new THREE.Mesh(new THREE.BoxGeometry(mainW * 0.88, 1.2, mainD * 0.88), roofMat);
      rMain.position.set(bx - bw * 0.22, 1.8 + mainH + 0.6, bz - bd * 0.1);
      districtGroup.add(rMain);

      buildingTopY = 1.8 + mainH + 1.2;
    } else {
      // Style 5: High-Tech Glass Tower with Vertical Corner Ribs
      var coreGeo = new THREE.BoxGeometry(bw, bHeight, bd);
      applyBuildingUVs(coreGeo, bw, bHeight, bd);
      var coreMesh = new THREE.Mesh(coreGeo, multiMats);
      coreMesh.position.set(bx, 1.8 + bHeight / 2, bz);
      coreMesh.castShadow = true;
      coreMesh.receiveShadow = true;
      coreMesh.userData = { repo: repo, item: item, height: bHeight };
      districtGroup.add(coreMesh);

      var ribGeo = new THREE.BoxGeometry(0.6, bHeight + 1.6, 0.6);
      var corners = [
        [-bw / 2, -bd / 2],
        [bw / 2, -bd / 2],
        [-bw / 2, bd / 2],
        [bw / 2, bd / 2]
      ];
      for (var cIdx = 0; cIdx < 4; cIdx++) {
        var rib = new THREE.Mesh(ribGeo, accentMat);
        rib.position.set(bx + corners[cIdx][0], 1.8 + (bHeight + 1.6) / 2, bz + corners[cIdx][1]);
        districtGroup.add(rib);
      }

      var roofCap = new THREE.Mesh(new THREE.BoxGeometry(bw * 0.85, 1.2, bd * 0.85), roofMat);
      roofCap.position.set(bx, buildingTopY + 0.6, bz);
      districtGroup.add(roofCap);

      buildingTopY += 1.2;
    }

    // Realistic Rooftop Detailing (HVAC, Mechanical Penthouse, Antennas)
    var topType = styleSeed % 5;
    if (!isTallest && bHeight > 18) {
      if (topType === 0) {
        var hvacGeo = new THREE.BoxGeometry(2.4, 1.3, 1.8);
        var hvacMat = new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.6, roughness: 0.4 });
        var hvac1 = new THREE.Mesh(hvacGeo, hvacMat);
        hvac1.position.set(bx - 1.2, buildingTopY + 0.65, bz - 0.8);
        districtGroup.add(hvac1);
        var hvac2 = new THREE.Mesh(hvacGeo, hvacMat);
        hvac2.position.set(bx + 1.2, buildingTopY + 0.65, bz - 0.8);
        districtGroup.add(hvac2);
      } else if (topType === 1) {
        var pentGeo = new THREE.BoxGeometry(bw * 0.38, 3.2, bd * 0.38);
        var pentMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.7 });
        var pentMesh = new THREE.Mesh(pentGeo, pentMat);
        pentMesh.position.set(bx, buildingTopY + 1.6, bz);
        districtGroup.add(pentMesh);
      } else if (topType === 2) {
        var antGeo = new THREE.CylinderGeometry(0.2, 0.25, 6.5, 6);
        var antMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.85 });
        var antMesh = new THREE.Mesh(antGeo, antMat);
        antMesh.position.set(bx + bw * 0.2, buildingTopY + 3.25, bz + bd * 0.2);
        districtGroup.add(antMesh);
      }
    }

    // Street-Facing Animated LED Billboard (Strictly on outer perimeter facades facing avenue!)
    if (slot.isStreetEdge && slot.streetDir && billboardTex && bHeight > 24 && (bIndex % 4 === 1)) {
      var bbW = Math.min(bw * 0.85, 14.0);
      var bbH = Math.min(bHeight * 0.32, 10.0);
      var bbGeo = new THREE.PlaneGeometry(bbW, bbH);
      var bbMat = new THREE.MeshBasicMaterial({ map: billboardTex });
      var bbMesh = new THREE.Mesh(bbGeo, bbMat);

      if (slot.streetDir === 'N') {
        bbMesh.position.set(bx, 1.8 + bHeight * 0.55, bz - bd * 0.51);
        bbMesh.rotation.y = Math.PI;
      } else if (slot.streetDir === 'S') {
        bbMesh.position.set(bx, 1.8 + bHeight * 0.55, bz + bd * 0.51);
        bbMesh.rotation.y = 0;
      } else if (slot.streetDir === 'E') {
        bbMesh.position.set(bx + bw * 0.51, 1.8 + bHeight * 0.55, bz);
        bbMesh.rotation.y = Math.PI / 2;
      } else if (slot.streetDir === 'W') {
        bbMesh.position.set(bx - bw * 0.51, 1.8 + bHeight * 0.55, bz);
        bbMesh.rotation.y = -Math.PI / 2;
      }
      districtGroup.add(bbMesh);
    }

    // Fixed 3D Physical Rooftop Sign
    if (bIndex % 5 === 2 && bHeight > 35) {
      var neonNames = ['GMC CLOUD', 'GIT HIGHWAY', 'VIBE LABS', 'QUANTUM', 'NEO MATRIX', 'CYBER CORP'];
      var neonCols = ['#00f2fe', '#ff0055', '#10b981', '#f59e0b', '#a855f7', '#38bdf8'];
      var nIdx = styleSeed % neonNames.length;
      var fixedSign = createFixed3DRooftopSign(neonNames[nIdx], neonCols[nIdx], Math.min(bw * 0.85, 10.0), 2.8);
      fixedSign.position.set(bx, buildingTopY, bz);
      districtGroup.add(fixedSign);
    }

    return {
      topY: buildingTopY,
      posX: buildingCenterX,
      posZ: buildingCenterZ,
      height: bHeight
    };
  }

  function buildDistrict(repo, index, posX, posZ, BW, BD) {
    var districtGroup = new THREE.Group();
    districtGroup.position.set(posX, 0, posZ);

    var baseGeo = new THREE.BoxGeometry(BW, 1.8, BD);
    var baseMat = new THREE.MeshStandardMaterial({
      color: 0x242e3d,
      roughness: 0.75,
      metalness: 0.2
    });
    var baseMesh = new THREE.Mesh(baseGeo, baseMat);
    baseMesh.position.y = 0.9;
    baseMesh.receiveShadow = true;
    districtGroup.add(baseMesh);

    var curbMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.6 });
    var curbGeo = new THREE.BoxGeometry(BW + 1.2, 0.6, BD + 1.2);
    var curbMesh = new THREE.Mesh(curbGeo, curbMat);
    curbMesh.position.y = 0.3;
    districtGroup.add(curbMesh);

    var roofMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.85, metalness: 0.1 });
    var groundMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.9 });

    var nonTextCount = repo.nonTextCount || 0;
    var parkW = Math.min(48, Math.max(16, 14 + Math.sqrt(nonTextCount) * 5.0));
    var parkD = parkW;
    var parkPosX = 0;
    var parkPosZ = 0;

    var lawnGeo = new THREE.BoxGeometry(parkW, 0.5, parkD);
    var lawnMat = new THREE.MeshStandardMaterial({
      color: 0x2e7d32,
      roughness: 0.85
    });
    var lawnMesh = new THREE.Mesh(lawnGeo, lawnMat);
    lawnMesh.position.set(parkPosX, 1.9, parkPosZ);
    lawnMesh.receiveShadow = true;
    districtGroup.add(lawnMesh);

    var numTrees = Math.min(24, Math.max(2, Math.floor(nonTextCount * 0.75)));
    if (nonTextCount === 0) numTrees = 2;

    var trunkGeo = new THREE.CylinderGeometry(0.35, 0.5, 3.2, 6);
    var trunkMat = new THREE.MeshStandardMaterial({ color: 0x5c3d2e, roughness: 0.9 });
    var foliageColors = [0x22c55e, 0x16a34a, 0x15803d, 0x10b981];

    for (var t = 0; t < numTrees; t++) {
      var treeGroup = new THREE.Group();
      var angle = (t / numTrees) * Math.PI * 2 + Math.random() * 0.5;
      var dist = 3.5 + Math.random() * (parkW * 0.38);
      var tx = parkPosX + Math.cos(angle) * dist;
      var tz = parkPosZ + Math.sin(angle) * dist;

      var trunk = new THREE.Mesh(trunkGeo, trunkMat);
      trunk.position.y = 1.6;
      treeGroup.add(trunk);

      var folCol = foliageColors[t % foliageColors.length];
      var folMat = new THREE.MeshStandardMaterial({ color: folCol, roughness: 0.7 });
      var folGeo1 = new THREE.ConeGeometry(2.0, 3.5, 6);
      var fol1 = new THREE.Mesh(folGeo1, folMat);
      fol1.position.y = 4.2;
      fol1.castShadow = true;
      treeGroup.add(fol1);

      var folGeo2 = new THREE.ConeGeometry(1.5, 2.8, 6);
      var fol2 = new THREE.Mesh(folGeo2, folMat);
      fol2.position.y = 5.8;
      treeGroup.add(fol2);

      treeGroup.position.set(tx, 2.0, tz);
      districtGroup.add(treeGroup);
    }

    if (nonTextCount >= 4) {
      var pondGeo = new THREE.CylinderGeometry(parkW * 0.18, parkW * 0.18, 0.4, 16);
      var pondMat = new THREE.MeshStandardMaterial({
        color: 0x0284c7,
        roughness: 0.1,
        metalness: 0.8,
        transparent: true,
        opacity: 0.85
      });
      var pondMesh = new THREE.Mesh(pondGeo, pondMat);
      pondMesh.position.set(parkPosX, 2.15, parkPosZ);
      districtGroup.add(pondMesh);
    }

    var buildingFiles = (repo.buildings && repo.buildings.length) ? repo.buildings : [];
    if (!buildingFiles.length && repo.tallest) buildingFiles = [repo.tallest];
    if (!buildingFiles.length) buildingFiles = [{ name: 'index.js', size: 1000 }];

    var clusteredItems = clusterBuildings(buildingFiles, repo.tallest);
    var itemCount = clusteredItems.length;

    var slots = [];
    var gridSize = Math.max(3, Math.ceil(Math.sqrt(itemCount + 5)));
    var cellW = BW / gridSize;
    var cellD = BD / gridSize;

    for (var gx = 0; gx < gridSize; gx++) {
      for (var gz = 0; gz < gridSize; gz++) {
        var sx = -BW / 2 + (gx + 0.5) * cellW;
        var sz = -BD / 2 + (gz + 0.5) * cellD;
        if (Math.abs(sx - parkPosX) < parkW * 0.55 && Math.abs(sz - parkPosZ) < parkD * 0.55) {
          continue;
        }

        var isEdge = (gx === 0 || gx === gridSize - 1 || gz === 0 || gz === gridSize - 1);
        var sDir = null;
        if (gz === 0) sDir = 'N';
        else if (gz === gridSize - 1) sDir = 'S';
        else if (gx === gridSize - 1) sDir = 'E';
        else if (gx === 0) sDir = 'W';

        slots.push({
          x: sx,
          z: sz,
          w: Math.min(cellW * 0.85, 16),
          d: Math.min(cellD * 0.85, 16),
          isStreetEdge: isEdge,
          streetDir: sDir
        });
      }
    }

    var repoSeed = hashStr(repo.name || ('repo_' + index));
    for (var s = slots.length - 1; s > 0; s--) {
      var randIdx = (repoSeed + s * 23) % (s + 1);
      var tmp = slots[s];
      slots[s] = slots[randIdx];
      slots[randIdx] = tmp;
    }

    var tallestBuildingPos = new THREE.Vector3(posX, 20, posZ);
    var maxHeight = 0;
    var tallestFileName = repo.tallest ? (repo.tallest.name || repo.tallest.path) : '';

    for (var b = 0; b < itemCount; b++) {
      var item = clusteredItems[b];
      var slot = slots[b % slots.length];
      if (!slot) break;

      var isTallest = (b === 0 && item.type === 'landmark') || (item.name === tallestFileName);
      var bInfo = buildArchitecturalStructure(districtGroup, item, b, slot, repo, posX, posZ, targetMode === 'night', isTallest, roofMat, groundMat, (repoSeed + b * 17));

      if (bInfo.height > maxHeight || isTallest) {
        maxHeight = Math.max(maxHeight, bInfo.height);
        tallestBuildingPos.set(bInfo.posX, bInfo.topY, bInfo.posZ);
      }
    }

    var spireGeo = new THREE.CylinderGeometry(0.3, 0.7, 10, 8);
    var spireMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.8, roughness: 0.2 });
    var spireMesh = new THREE.Mesh(spireGeo, spireMat);
    spireMesh.position.set(tallestBuildingPos.x - posX, tallestBuildingPos.y + 5.0 - 1.8, tallestBuildingPos.z - posZ);
    districtGroup.add(spireMesh);

    var status = repo.status || null;
    var isConflict = status && status.conflicted;
    var hasChanges = status && (!status.clean || (status.staged + status.unstaged + status.untracked > 0));
    var isAhead = status && status.ahead > 0;
    var isBehind = status && status.behind > 0;

    var beaconColor = 0x10b981;
    if (isConflict) beaconColor = 0xff0055;
    else if (hasChanges) beaconColor = 0xf59e0b;
    else if (isAhead || isBehind) beaconColor = 0xa855f7;

    var beaconGeo = new THREE.SphereGeometry(1.2, 12, 12);
    var beaconMat = new THREE.MeshBasicMaterial({ color: beaconColor });
    var beaconMesh = new THREE.Mesh(beaconGeo, beaconMat);
    beaconMesh.position.set(tallestBuildingPos.x - posX, tallestBuildingPos.y + 10.0 - 1.8, tallestBuildingPos.z - posZ);
    districtGroup.add(beaconMesh);
    beaconMeshes.push(beaconMesh);

    var bannerSprite = createRepoBannerSprite(repo.name, repo.totalFiles, (repo.tallest ? repo.tallest.size : 0), targetMode === 'night', status);
    bannerSprite.position.set(tallestBuildingPos.x, tallestBuildingPos.y + 14.0, tallestBuildingPos.z);
    bannerSprite.userData = { repoIndex: index, repo: repo, districtCenter: new THREE.Vector3(posX, 15, posZ) };
    cityGroup.add(bannerSprite);

    var tetherGeo = new THREE.BufferGeometry();
    var tetherPoints = [
      new THREE.Vector3(tallestBuildingPos.x, tallestBuildingPos.y + 10.0, tallestBuildingPos.z),
      new THREE.Vector3(tallestBuildingPos.x, tallestBuildingPos.y + 13.0, tallestBuildingPos.z)
    ];
    tetherGeo.setFromPoints(tetherPoints);
    var tetherMat = new THREE.LineBasicMaterial({ color: beaconColor, linewidth: 2, transparent: true, opacity: 0.85 });
    var tetherLine = new THREE.Line(tetherGeo, tetherMat);
    cityGroup.add(tetherLine);

    repoBadges.push({
      sprite: bannerSprite,
      line: tetherLine,
      repo: repo,
      isConflict: isConflict,
      hasChanges: hasChanges,
      districtCenter: new THREE.Vector3(posX, 15, posZ),
      tallestPos: tallestBuildingPos.clone(),
      height: maxHeight
    });

    districtData.push({
      index: index,
      repo: repo,
      center: new THREE.Vector3(posX, 15, posZ),
      tallestPos: tallestBuildingPos.clone(),
      height: maxHeight
    });

    cityGroup.add(districtGroup);
  }

  function buildTrafficCars(cols, rows, stepX, stepZ, originX, originZ, totalW, totalD) {
    var carColors = [0x3b82f6, 0xef4444, 0x10b981, 0xf59e0b, 0x8b5cf6, 0xf1f5f9];
    var carGeo = new THREE.BoxGeometry(2.4, 1.4, 4.4);
    var headLightMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    var tailLightMat = new THREE.MeshBasicMaterial({ color: 0xff0055 });
    var lightConeGeo = new THREE.PlaneGeometry(2.6, 6.5);
    var lightConeMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25 });

    var count = 65;
    for (var i = 0; i < count; i++) {
      var isHorizontal = Math.random() > 0.5;
      var colIdx = Math.floor(Math.random() * (cols + 1));
      var rowIdx = Math.floor(Math.random() * (rows + 1));

      var carCol = carColors[i % carColors.length];
      var carMat = new THREE.MeshStandardMaterial({ color: carCol, roughness: 0.4, metalness: 0.6 });
      var carGroup = new THREE.Group();

      var carBody = new THREE.Mesh(carGeo, carMat);
      carBody.position.y = 0.7;
      carGroup.add(carBody);

      var hl1 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.2), headLightMat);
      hl1.position.set(-0.75, 0.6, 2.22);
      carGroup.add(hl1);
      var hl2 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.2), headLightMat);
      hl2.position.set(0.75, 0.6, 2.22);
      carGroup.add(hl2);

      var tl1 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.2), tailLightMat);
      tl1.position.set(-0.75, 0.6, -2.22);
      carGroup.add(tl1);
      var tl2 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.2), tailLightMat);
      tl2.position.set(0.75, 0.6, -2.22);
      carGroup.add(tl2);

      var cone = new THREE.Mesh(lightConeGeo, lightConeMat);
      cone.rotation.x = -Math.PI / 2;
      cone.position.set(0, 0.1, 5.5);
      carGroup.add(cone);

      var dir = (Math.random() > 0.5) ? 1 : -1;
      var speed = 28 + Math.random() * 20;

      var x, z;
      if (isHorizontal) {
        var rz = originZ + (rowIdx - 0.5) * stepZ;
        x = (Math.random() - 0.5) * totalW;
        z = rz + (dir > 0 ? 5.5 : -5.5);
        carGroup.rotation.y = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
      } else {
        var rx = originX + (colIdx - 0.5) * stepX;
        x = rx + (dir > 0 ? 5.5 : -5.5);
        z = (Math.random() - 0.5) * totalD;
        carGroup.rotation.y = dir > 0 ? 0 : Math.PI;
      }

      carGroup.position.set(x, 0, z);
      trafficGroup.add(carGroup);

      trafficCars.push({
        group: carGroup,
        isHorizontal: isHorizontal,
        dir: dir,
        speed: speed,
        totalW: totalW,
        totalD: totalD
      });
    }
  }

  function buildFlightSpline(districts) {
    if (!districts || !districts.length) return;

    var waypoints = [];
    var N = districts.length;

    for (var i = 0; i < N; i++) {
      var d = districts[i];
      var cx = d.center.x;
      var cz = d.center.z;
      var h = Math.max(d.height + 40, 85);
      var r = 85;

      waypoints.push(new THREE.Vector3(cx + r, h + 14, cz + r * 0.8));
      waypoints.push(new THREE.Vector3(cx - r * 0.6, h + 4, cz + r));
      waypoints.push(new THREE.Vector3(cx - r, h, cz - r * 0.6));
      waypoints.push(new THREE.Vector3(cx + r * 0.5, h + 22, cz - r));
    }

    if (waypoints.length < 4) {
      var d0 = districts[0];
      waypoints = [
        new THREE.Vector3(d0.center.x + 100, 95, d0.center.z + 100),
        new THREE.Vector3(d0.center.x - 100, 85, d0.center.z + 100),
        new THREE.Vector3(d0.center.x - 100, 90, d0.center.z - 100),
        new THREE.Vector3(d0.center.x + 100, 105, d0.center.z - 100)
      ];
    }

    flightSpline = new THREE.CatmullRomCurve3(waypoints, true, 'catmullrom', 0.5);
  }

  function calcBankAngle(spline, t) {
    if (!spline) return 0;
    try {
      var p1 = spline.getPointAt(t);
      var p2 = spline.getPointAt((t + 0.02) % 1.0);
      var p3 = spline.getPointAt((t + 0.04) % 1.0);
      var v1x = p2.x - p1.x;
      var v1z = p2.z - p1.z;
      var v2x = p3.x - p2.x;
      var v2z = p3.z - p2.z;
      var ang1 = Math.atan2(v1x, v1z);
      var ang2 = Math.atan2(v2x, v2z);
      var diff = ang2 - ang1;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      return Math.max(-0.6, Math.min(0.6, diff));
    } catch(e) {
      return 0;
    }
  }

  function animate(timestamp) {
    if (!isRunning) return;

    animationId = requestAnimationFrame(animate);

    var dt = Math.min(0.1, (timestamp - lastTimestamp) / 1000);
    lastTimestamp = timestamp;
    totalElapsedTime += dt;

    var targetVal = targetMode === 'night' ? 1.0 : 0.0;
    if (Math.abs(modeTransition - targetVal) > 0.001) {
      modeTransition += (targetVal - modeTransition) * 0.06;

      var skyDay = new THREE.Color(0x94b8e8);
      var skyNight = new THREE.Color(0x060914);
      var curSky = skyDay.clone().lerp(skyNight, modeTransition);
      scene.background = curSky;

      var fogDay = new THREE.Color(0xa8c8ec);
      var fogNight = new THREE.Color(0x070b18);
      scene.fog.color = fogDay.clone().lerp(fogNight, modeTransition);

      sunLight.intensity = (1.0 - modeTransition) * 1.25;
      moonLight.intensity = modeTransition * 0.55;

      var ambDay = new THREE.Color(0x64748b);
      var ambNight = new THREE.Color(0x1e293b);
      ambientLight.color = ambDay.clone().lerp(ambNight, modeTransition);
      ambientLight.intensity = (1.0 - modeTransition) * 0.45 + modeTransition * 0.25;

      hemiLight.intensity = (1.0 - modeTransition) * 0.75 + modeTransition * 0.35;
      hemiLight.color.lerpColors(new THREE.Color(0xcce0ff), new THREE.Color(0x1e293b), modeTransition);
      hemiLight.groundColor.lerpColors(new THREE.Color(0x475569), new THREE.Color(0x0f172a), modeTransition);

      if (starField) {
        starField.material.opacity = modeTransition * 0.92;
      }

      // Building Emissive Window Radiance (1.25x HDR at night, strictly 0.0 in day)
      var currentEmissive = modeTransition * 1.25;
      if (buildingMaterials && buildingMaterials.length > 0) {
        for (var bm = 0; bm < buildingMaterials.length; bm++) {
          buildingMaterials[bm].emissiveIntensity = currentEmissive;
        }
      }

      // Streetlights Night Illumination
      if (streetlightLenses.length > 0) {
        for (var sl = 0; sl < streetlightLenses.length; sl++) {
          streetlightLenses[sl].emissiveIntensity = modeTransition * 2.5;
        }
      }
      if (streetlightGlowDecals.length > 0) {
        for (var sg = 0; sg < streetlightGlowDecals.length; sg++) {
          streetlightGlowDecals[sg].opacity = modeTransition * 0.45;
        }
      }
    }

    // Dynamic LED Billboard wave animation
    updateAnimatedBillboards(totalElapsedTime);

    // Drifting Volumetric Cloud Deck
    if (cloudsGroup && cloudsGroup.children.length > 0) {
      for (var cl = 0; cl < cloudsGroup.children.length; cl++) {
        var cloud = cloudsGroup.children[cl];
        cloud.position.x += dt * (cloud.userData.speed || 5.0);
        if (cloud.position.x > 450) cloud.position.x = -450;
      }
    }

    // Rain Particle Falling
    if (rainPoints && rainPositions) {
      if (isRaining) {
        rainPoints.visible = true;
        for (var r = 0; r < rainCount; r++) {
          rainPositions[r * 3 + 1] -= dt * 260;
          rainPositions[r * 3] -= dt * 22;
          if (rainPositions[r * 3 + 1] < 0) {
            rainPositions[r * 3 + 1] = 250 + Math.random() * 20;
            rainPositions[r * 3] = (Math.random() - 0.5) * 900;
          }
        }
        rainPoints.geometry.attributes.position.needsUpdate = true;
      } else {
        rainPoints.visible = false;
      }
    }

    // Beacon Lights Pulsing
    var beaconScale = 1.0 + 0.35 * Math.sin(totalElapsedTime * 6.0);
    for (var b = 0; b < beaconMeshes.length; b++) {
      beaconMeshes[b].scale.set(beaconScale, beaconScale, beaconScale);
    }

    // Badge floating sine bobbing
    for (var bg = 0; bg < repoBadges.length; bg++) {
      var bItem = repoBadges[bg];
      var bob = Math.sin(totalElapsedTime * 2.0 + bg) * 0.8;
      bItem.sprite.position.y = bItem.tallestPos.y + 14.0 + bob;
    }

    // Traffic Cars Movement
    for (var c = 0; c < trafficCars.length; c++) {
      var car = trafficCars[c];
      if (car.isHorizontal) {
        car.group.position.x += car.dir * car.speed * dt;
        if (Math.abs(car.group.position.x) > car.totalW / 2) {
          car.group.position.x = -car.dir * car.totalW / 2;
        }
      } else {
        car.group.position.z += car.dir * car.speed * dt;
        if (Math.abs(car.group.position.z) > car.totalD / 2) {
          car.group.position.z = -car.dir * car.totalD / 2;
        }
      }
    }

    // Airplane Flight Cruise
    if (isAutoCruising && flightSpline) {
      cruiseProgress = (cruiseProgress + dt * cruiseSpeed * 0.0024) % 1.0;
      var camPos = flightSpline.getPointAt(cruiseProgress);
      camPos.y += Math.sin(totalElapsedTime * 0.55) * 1.6;

      targetBankAngle = -calcBankAngle(flightSpline, cruiseProgress) * 14.0;
      bankAngle += (targetBankAngle - bankAngle) * 0.035;

      if (districtData.length > 0) {
        var activeIdx = Math.floor(cruiseProgress * districtData.length) % districtData.length;
        var actDist = districtData[activeIdx];
        if (actDist) {
          targetLookAt.copy(actDist.tallestPos || actDist.center);
          var hudBadge = document.getElementById('city3dCurrentRepoBadge');
          if (hudBadge && actDist.repo) {
            var stIcon = '✈️';
            if (actDist.repo.status && actDist.repo.status.conflicted) stIcon = '⚠️';
            else if (actDist.repo.status && !actDist.repo.status.clean) stIcon = '⚡';
            hudBadge.textContent = stIcon + ' ' + actDist.repo.name + ' (' + (actDist.repo.totalFiles || 0) + ' files)';
          }
        }
      }

      currentLookAt.lerp(targetLookAt, 0.018);
      camera.position.copy(camPos);
      camera.lookAt(currentLookAt);
      camera.rotateZ(bankAngle * Math.PI / 180);
    } else {
      var ox = orbit.target.x + orbit.radius * Math.sin(orbit.phi) * Math.sin(orbit.theta);
      var oy = orbit.target.y + orbit.radius * Math.cos(orbit.phi);
      var oz = orbit.target.z + orbit.radius * Math.sin(orbit.phi) * Math.cos(orbit.theta);
      camera.position.set(ox, oy, oz);
      camera.lookAt(orbit.target.x, orbit.target.y, orbit.target.z);
    }

    // Mouse Hover Intersections
    if (raycaster && mouse && camera && repoBadges.length > 0) {
      raycaster.setFromCamera(mouse, camera);
      var spriteList = repoBadges.map(function(item) { return item.sprite; });
      var intersects = raycaster.intersectObjects(spriteList, false);
      if (intersects.length > 0) {
        canvasEl.style.cursor = 'pointer';
        hoveredBadge = intersects[0].object;
      } else {
        canvasEl.style.cursor = isDragging ? 'grabbing' : 'grab';
        hoveredBadge = null;
      }
    }

    renderer.render(scene, camera);
  }

  function bindEvents() {
    window.addEventListener('resize', handleResize);

    canvasEl.addEventListener('pointerdown', function(e) {
      isDragging = true;
      previousPointer = { x: e.clientX, y: e.clientY };
      clearTimeout(userInteractionTimer);
    });

    window.addEventListener('pointermove', function(e) {
      var rect = canvasEl.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      if (!isDragging) return;
      var dx = e.clientX - previousPointer.x;
      var dy = e.clientY - previousPointer.y;
      previousPointer = { x: e.clientX, y: e.clientY };

      orbit.theta -= dx * 0.006;
      orbit.phi = Math.max(0.1, Math.min(Math.PI / 2.2, orbit.phi + dy * 0.006));

      if (isAutoCruising) {
        isAutoCruising = false;
        updateFlightButton();
      }
    });

    window.addEventListener('pointerup', function(e) {
      isDragging = false;
      if (hoveredBadge && hoveredBadge.userData && hoveredBadge.userData.repo) {
        openRepoDetail(hoveredBadge.userData.repo);
      }
      clearTimeout(userInteractionTimer);
      userInteractionTimer = setTimeout(function() {
        if (!isAutoCruising) {
          isAutoCruising = true;
          updateFlightButton();
        }
      }, 12000);
    });

    canvasEl.addEventListener('wheel', function(e) {
      e.preventDefault();
      orbit.radius = Math.max(60, Math.min(650, orbit.radius + e.deltaY * 0.3));
      if (isAutoCruising) {
        isAutoCruising = false;
        updateFlightButton();
      }
      clearTimeout(userInteractionTimer);
      userInteractionTimer = setTimeout(function() {
        if (!isAutoCruising) {
          isAutoCruising = true;
          updateFlightButton();
        }
      }, 12000);
    }, { passive: false });
  }

  function bindHudControls() {
    var flightBtn = document.getElementById('city3dFlightBtn');
    if (flightBtn) {
      flightBtn.addEventListener('click', function(e) {
        e.preventDefault();
        toggleFlight();
      });
    }

    var dayNightBtn = document.getElementById('city3dDayNightBtn');
    if (dayNightBtn) {
      dayNightBtn.addEventListener('click', function(e) {
        e.preventDefault();
        manualModeOverride = true;
        toggleDayNight();
      });
    }

    var weatherBtn = document.getElementById('city3dWeatherBtn');
    if (weatherBtn) {
      weatherBtn.addEventListener('click', function(e) {
        e.preventDefault();
        toggleWeather();
      });
    }

    var zenBtn = document.getElementById('city3dZenBtn');
    if (zenBtn) {
      zenBtn.addEventListener('click', function(e) {
        e.preventDefault();
        toggleZenMode();
      });
    }

    var closeCardBtn = document.getElementById('city3dCardCloseBtn');
    if (closeCardBtn) {
      closeCardBtn.addEventListener('click', function(e) {
        e.preventDefault();
        closeRepoDetail();
      });
    }

    var enterRepoBtn = document.getElementById('city3dCardEnterBtn');
    if (enterRepoBtn) {
      enterRepoBtn.addEventListener('click', function(e) {
        e.preventDefault();
        var repoPath = enterRepoBtn.getAttribute('data-repo-path');
        if (repoPath) {
          closeRepoDetail();
          switchRepository(repoPath);
        }
      });
    }
  }

  function toggleFlight() {
    isAutoCruising = !isAutoCruising;
    updateFlightButton();
  }

  function updateFlightButton() {
    var textEl = document.getElementById('city3dFlightText');
    if (textEl) {
      textEl.textContent = isAutoCruising ? (t('city3dCruise') || '巡航中') : (t('city3dCruisePaused') || '已暂停');
    }
  }

  function toggleDayNight() {
    setDayNight(targetMode === 'night' ? 'day' : 'night');
  }

  function setDayNight(mode) {
    targetMode = mode === 'day' ? 'day' : 'night';
    var iconEl = document.getElementById('city3dDayNightIcon');
    var textEl = document.getElementById('city3dDayNightText');
    if (iconEl) iconEl.textContent = targetMode === 'night' ? '🌙' : '☀️';
    if (textEl) textEl.textContent = targetMode === 'night' ? (t('city3dNight') || '夜间') : (t('city3dDay') || '白天');
  }

  function toggleWeather() {
    isRaining = !isRaining;
    var iconEl = document.getElementById('city3dWeatherIcon');
    var textEl = document.getElementById('city3dWeatherText');
    if (iconEl) iconEl.textContent = isRaining ? '🌧️' : '☀️';
    if (textEl) textEl.textContent = isRaining ? (t('city3dRain') || '雨夜') : (t('city3dClear') || '晴空');

    for (var r = 0; r < roadMaterials.length; r++) {
      roadMaterials[r].roughness = isRaining ? 0.18 : 0.85;
      roadMaterials[r].metalness = isRaining ? 0.85 : 0.1;
    }
  }

  function syncWithTheme(themeId) {
    if (manualModeOverride) return;
    if (themeId === 'default') {
      setDayNight('day');
    } else {
      setDayNight('night');
    }
  }

  function toggleZenMode() {
    isZenMode = !isZenMode;
    var homePageEl = document.getElementById('homePage');
    var zenTextEl = document.getElementById('city3dZenText');
    if (homePageEl) {
      homePageEl.classList.toggle('zen-mode', isZenMode);
    }
    if (containerEl) {
      containerEl.classList.toggle('zen-mode', isZenMode);
    }
    if (zenTextEl) {
      zenTextEl.textContent = isZenMode ? (t('city3dOverviewMode') || '恢复概览') : (t('city3dZenMode') || '全景沉浸');
    }
  }

  function openRepoDetail(repo) {
    if (!repoCardEl || !repo) return;
    var nameEl = document.getElementById('city3dCardRepoName');
    var bldEl = document.getElementById('city3dCardBuildings');
    var grnEl = document.getElementById('city3dCardGreens');
    var talEl = document.getElementById('city3dCardTallest');
    var enterBtn = document.getElementById('city3dCardEnterBtn');

    if (nameEl) nameEl.textContent = repo.name || 'Repository';
    if (bldEl) bldEl.textContent = (repo.textCount || 0) + ' ' + (t('city3dBuildings') || '栋建筑');
    if (grnEl) grnEl.textContent = (repo.nonTextCount || 0) + ' ' + (t('city3dGreenSpace') || '处绿化');
    if (talEl) {
      var tName = repo.tallest ? (repo.tallest.name || repo.tallest.path) : '-';
      var tSize = repo.tallest ? formatBytes(repo.tallest.size) : '';
      talEl.textContent = tName + (tSize ? ' (' + tSize + ')' : '');
    }
    if (enterBtn) {
      enterBtn.setAttribute('data-repo-path', repo.path || '');
    }

    repoCardEl.hidden = false;
  }

  function closeRepoDetail() {
    if (repoCardEl) repoCardEl.hidden = true;
  }

  function handleResize() {
    if (!renderer || !camera || !containerEl) return;
    var isSidebarCollapsed = document.body.classList.contains('sidebar-collapsed');
    var width = containerEl.clientWidth || (window.innerWidth - (isSidebarCollapsed ? 0 : 260));
    if (window.innerWidth <= 960) width = window.innerWidth;
    var height = containerEl.clientHeight || window.innerHeight;
    if (width <= 0) width = window.innerWidth;
    if (height <= 0) height = window.innerHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  }

  function pause() {
    isRunning = false;
    if (animationId) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }
  }

  function resume() {
    if (!isInitialized) {
      init();
      return;
    }
    if (!isRunning) {
      isRunning = true;
      lastTimestamp = performance.now();
      handleResize();
      requestAnimationFrame(animate);
    }
    setTimeout(handleResize, 60);
  }

  function fetchCityData() {
    fetch('/api/city-data')
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data && data.cityData) {
          buildCity(data.cityData);
        }
      })
      .catch(function(e) {
        console.warn('Failed to fetch city-data:', e);
      });
  }

  return {
    init: init,
    buildCity: buildCity,
    setDayNight: setDayNight,
    toggleDayNight: toggleDayNight,
    toggleWeather: toggleWeather,
    syncWithTheme: syncWithTheme,
    toggleFlight: toggleFlight,
    toggleZenMode: toggleZenMode,
    pause: pause,
    resume: resume,
    handleResize: handleResize
  };
})();

function setPageTitle(repoPath) {
  var title = repoPath ? ('GMC ' + repoDisplayName(repoPath)) : 'GMC GitWeb';
  document.title = title;
  $('appTitle').textContent = title;
}

setPageTitle(targetRepo);
bindLanguageControls();
bindViewTabs();
bindTaskControls();
bindRepositoryBrowserControls();
applyLanguage();
initSecurityControls();
initThemeControls();

bindHomePageEvents();

if (!targetRepo) {
  setPageTitle('');
  updateRepoLink(t('repoRunning'), null);
  if ($('homePage')) $('homePage').hidden = false;
  if ($('city3dContainer')) $('city3dContainer').hidden = false;
  if ($('gitPage')) $('gitPage').hidden = true;
  if ($('taskPage')) $('taskPage').hidden = true;
  if ($('closeRepoBtn')) $('closeRepoBtn').hidden = true;
  var viewTabsEl = document.querySelector('.view-tabs');
  if (viewTabsEl) viewTabsEl.hidden = true;
  initSidebar();
  if (typeof City3DEngine !== 'undefined') {
    City3DEngine.init();
  }
  loadGitOverview();
} else {
  updateRepoLink(targetRepo, targetRepo);
  if ($('homePage')) $('homePage').hidden = true;
  if ($('gitPage')) $('gitPage').hidden = false;
  if ($('closeRepoBtn')) $('closeRepoBtn').hidden = false;
  var viewTabsEl = document.querySelector('.view-tabs');
  if (viewTabsEl) viewTabsEl.hidden = false;
  initSidebar();
  connectTaskEvents();
  load();
}

window.addEventListener('load', function() {
  if (!targetRepo && typeof City3DEngine !== 'undefined') {
    City3DEngine.init();
  }
});

$('repo').addEventListener('click', openCurrentRepository);
$('quickActions').addEventListener('click', function(e) {
  var btn = e.target.closest('.qa-btn');
  if (!btn) return;
  var agent = btn.getAttribute('data-agent');
  if (agent === 'terminal') {
    openCurrentTerminal(e);
  } else if (agent === 'open-ide') {
    openProjectIde(e);
  } else {
    openAgentTerminal(e, btn);
  }
});
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
  if (state.contributions || state.globalContributions) renderCalendar(state.contributions, state.globalContributions);
  if (!targetRepo && state.gitOverview && state.gitOverview.globalContributions) {
    renderHomeCalendar(state.gitOverview.globalContributions);
  }
});
window.addEventListener('popstate', function() {
  var params = new URLSearchParams(window.location.search);
  var repo = params.get('repo') || '';
  if (repo !== targetRepo) {
    switchRepository(repo, { skipHistory: true, force: true });
  }
});
window.addEventListener('beforeunload', function() {
  cancelTaskSpeech();
  if (state.taskEvents) state.taskEvents.close();
  stopAgentMonitorPolling();
});
document.addEventListener('visibilitychange', function() {
  if (document.hidden) cancelTaskSpeech();
  if (state.activeView === 'tasks' && !state.settingsOpen) {
    if (document.hidden) stopAgentMonitorPolling();
    else startAgentMonitorPolling();
  }
  if (!document.hidden && state.auto && targetRepo && !isDetailPageOpen()) {
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
  if (isDetailPageOpen()) return;
  state.timer = setTimeout(load, document.hidden ? HIDDEN_STATUS_INTERVAL_MS : AUTO_STATUS_INTERVAL_MS);
}

function load(options) {
  options = options || {};
  if (!targetRepo) return Promise.resolve(false);
  if (state.loading) {
    if (options.force) state.pendingForceLoad = true;
    return Promise.resolve(false);
  }
  var repoAtStart = targetRepo;
  performance.mark('gmc-status-start');
  state.loading = true;
  return fetch('/api/status?repo=' + encodeURIComponent(targetRepo), { cache: 'no-store' })
    .then(function(res) { 
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json(); 
    })
    .then(function(data) {
      if (targetRepo !== repoAtStart) return false;
      performance.mark('gmc-status-end');
      performance.measure('gmc-status', 'gmc-status-start', 'gmc-status-end');
      var apiTime = getPerfMeasure('gmc-status');
      console.debug('[gmc:timing] /api/status fetch: ' + apiTime + 'ms (server total: ' + (data.timings && data.timings.total || '?') + 'ms)');
      if (data.timings) {
        var heavy = [];
        Object.keys(data.timings).forEach(function(k) {
          if (data.timings[k] >= 500) heavy.push(k + ': ' + data.timings[k] + 'ms');
        });
        if (heavy.length) console.debug('[gmc:timing] server heavy ops: ' + heavy.join(', '));
      }
      var signature = statusSignature(data);
      if (!options.force && signature === state.statusSignature) {
        return false;
      }
      state.statusSignature = signature;
      render(data);
      return true;
    })
    .catch(function(error) {
      if (targetRepo !== repoAtStart) return;
      updateRepoLink(t('loadingStatusErrorPrefix') + error.message, null);
    })
    .finally(function() {
      if (targetRepo !== repoAtStart) return;
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
    globalContributions: data.globalContributions,
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
  var t0 = performance.now();
  if (data.error) {
    updateRepoLink(t('errorPrefix') + data.error, null);
    return;
  }
  updateRepoLink(data.repository && data.repository.root ? data.repository.root : targetRepo, targetRepo);
  state.currentBranch = data.branch.current;
  $('branchText').textContent = data.branch.current;
  $('upstream').dataset.empty = data.branch.upstream ? 'false' : 'true';
  $('upstream').textContent = data.branch.upstream || t('noUpstream');
  $('ahead').textContent = data.branch.ahead;
  $('btnPush').style.display = data.branch.ahead > 0 ? 'inline-block' : 'none';
  $('btnPush').onclick = function(event) { executeAction('/api/push', t('pushing'), event.currentTarget); };
  
  $('behind').textContent = data.branch.behind;
  $('btnPull').onclick = function(event) { executeAction('/api/pull', t('pulling'), event.currentTarget); };
  
  $('dirty').textContent = data.status.files.length;
  updateGitTabBadge(data.status.files.length);
  
  state.tasks = data.tasks || [];
  updateTaskTabBadge();
  if (!state.tasksLoaded && !state.taskLoading) {
    loadRepositoryTasks();
  }
  state.install = data.install || { hooks: true };
  renderInstallBanner();
  
  state.contributions = data.contributions || {};
  state.globalContributions = data.globalContributions || {};
  renderCalendar(state.contributions, state.globalContributions);
  renderFiles(data.status.files);
  
  processTopology(data);
  renderBranchMenus();
  loadRepositoryBrowser({ force: true });
  renderCommits(state.commits);
  
  clearTimeout(state.graphTimer);
  state.graphTimer = setTimeout(function() { renderGraph(state.commits); }, 50);

  console.debug('[gmc:timing] render(total): ' + (performance.now() - t0).toFixed(1) + 'ms');
}

function renderInstallBanner() {
  var banner = $('installBanner');
  if (!banner) return;
  var needsInstall = !state.install.hooks;
  if (needsInstall) {
    banner.classList.add('visible');
  } else {
    banner.classList.remove('visible');
  }
}

function installGmc() {
  var btn = $('btnInstall');
  if (btn) { btn.disabled = true; btn.textContent = t('installing'); }
  fetch('/api/install?repo=' + encodeURIComponent(targetRepo), { method: 'POST' })
    .then(function(res) { return res.json().then(function(data) { if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status); return data; }); })
    .then(function(data) {
      state.install = data.install || { hooks: true };
      renderInstallBanner();
      if (btn) { btn.textContent = t('installed'); }
    })
    .catch(function(err) {
      if (btn) { btn.disabled = false; btn.textContent = t('installFailed'); }
      alert(t('installFailedPrefix') + err.message);
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

function calendarTooltip(count, globalCount, ds) {
  if (count > 0 && globalCount > count) {
    var tmpl = t('commitsCurrentAndGlobal');
    return tmpl.replace('{current}', count).replace('{global}', globalCount).replace('{date}', ds);
  }
  if (count === 0 && globalCount > 0) {
    var tmpl = t('commitsGlobalOnly');
    return tmpl.replace('{global}', globalCount).replace('{date}', ds);
  }
  return count + ' ' + t('commitsOn') + ' ' + ds;
}

function renderCalendar(contributions, globalContributions, elementId) {
  var cal = $(elementId || 'calendar');
  if (!cal || (!contributions && !globalContributions)) return;
  contributions = contributions || {};
  globalContributions = globalContributions || {};
  var styles = window.getComputedStyle(cal);
  var cellSize = parseFloat(styles.getPropertyValue('--calendar-cell')) || 10;
  var gapSize = parseFloat(styles.getPropertyValue('--calendar-gap')) || 3;
  var labelWidth = parseFloat(styles.getPropertyValue('--calendar-label-width')) || 24;
  var availableWidth = cal.clientWidth || (cal.parentElement && cal.parentElement.clientWidth) || 0;
  var maxColumns = availableWidth > 0 ? Math.floor((availableWidth - labelWidth - 6 + gapSize) / (cellSize + gapSize)) : 48;
  var columns = Math.max(10, Math.min(53, maxColumns || 48));
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

  var lastMonthCol = -4;
  for (var c = 0; c < columns; c++) {
    var weekStart = addCalendarDays(start, c * 7);
    var monthLabel = '';
    for (var mr = 0; mr < 7; mr++) {
      var md = addCalendarDays(weekStart, mr);
      if ((c === 0 && mr === 0) || md.getDate() === 1) {
        if (c - lastMonthCol >= 3) {
          monthLabel = monthNames[md.getMonth()];
          lastMonthCol = c;
        }
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
      var globalCount = globalContributions[ds] != null ? globalContributions[ds] : count;
      var level = count > 10 ? 4 : count > 5 ? 3 : count > 2 ? 2 : count > 0 ? 1 : 0;
      var globalLevel = globalCount > 10 ? 4 : globalCount > 5 ? 3 : globalCount > 2 ? 2 : globalCount > 0 ? 1 : 0;
      var titleText = calendarTooltip(count, globalCount, ds);
      var cellAttrs = 'class="calendar-cell"';
      if (level > 0) {
        cellAttrs += ' data-level="' + level + '"';
      }
      if (globalLevel > 0) {
        cellAttrs += ' data-global-level="' + globalLevel + '"';
      }
      weeksHtml += '<div ' + cellAttrs + ' title="' + escapeHtml(titleText) + '"></div>';
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
  button.textContent = t('working');
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
    .then(function(data) { setCommitStatus(t('successPrefix') + firstLine(data.output), false); })
    .catch(function(err) { setCommitStatus(t('errorPrefix') + err.message, true); })
    .finally(function() {
      state.auto = prevAuto;
      return load({ force: true });
    })
    .finally(function() {
      restoreActionButton(button, buttonState);
    });
}

function renderFiles(files) {
  files = files || [];
  state.files = files;
  updateGitTabBadge(files.length);
  var modified = files.filter(function (file) { return file.worktree !== ' '; });
  var staged = files.filter(function (file) { return file.index !== ' ' && file.index !== '?'; });
  var nextModified = {};
  var nextStaged = {};
  files.forEach(function(f) {
    if (f.worktree !== ' ' && state.selectedModified[f.path]) nextModified[f.path] = true;
    if (f.index !== ' ' && f.index !== '?' && state.selectedStaged[f.path]) nextStaged[f.path] = true;
  });
  state.selectedModified = nextModified;
  state.selectedStaged = nextStaged;

  if (!files.length) {
    $('files').innerHTML = '<div class="meta">' + escapeHtml(t('cleanWorkingTree')) + '</div><div id="commitStatus" class="commit-status"></div>';
    updateCommitControls();
    return;
  }

  $('files').innerHTML = [
    renderFileSection('modified', modified, state.selectedModified),
    renderFileSection('staged', staged, state.selectedStaged),
    '<div id="commitStatus" class="commit-status"></div>'
  ].join('');
  bindFileControls();
}

function renderFileSection(kind, files, selection) {
  var isModified = kind === 'modified';
  var title = isModified ? t('modifiedFiles') : t('stagedFiles');
  var empty = isModified ? t('noModifiedFiles') : t('noStagedFiles');
  var allId = isModified ? 'selectAllModified' : 'selectAllStaged';
  var checkClass = isModified ? 'modified-file-check' : 'staged-file-check';
  var actions = isModified
    ? '<button id="restoreSelected" class="ignore-button" style="color:var(--amber);border-color:var(--line)" type="button">' + escapeHtml(t('restore')) + '</button>' +
      '<button id="ignoreSelected" class="ignore-button" type="button">' + escapeHtml(t('ignore')) + '</button>' +
      '<button id="stageSelected" class="commit-button" type="button">' + escapeHtml(t('stage')) + '</button>' +
      '<button id="commitModified" class="commit-button" type="button">' + escapeHtml(t('commitSelected')) + '</button>'
    : '<button id="unstageSelected" class="ignore-button" type="button">' + escapeHtml(t('unstage')) + '</button>' +
      '<button id="commitSelected" class="commit-button" type="button">' + escapeHtml(t('commitSelected')) + '</button>';
  return '<section class="file-section file-section-' + kind + '">' +
    '<h3 class="file-section-title">' + escapeHtml(title) + ' <span class="meta">(' + files.length + ')</span></h3>' +
    (files.length ? '<div class="file-toolbar">' +
      '<label><input id="' + allId + '" type="checkbox"> ' + escapeHtml(t('all')) + '</label>' +
      '<div class="file-actions">' + actions + '</div>' +
    '</div><div class="files-list">' + files.map(function(f) {
      var checked = selection[f.path] ? ' checked' : '';
      var displayPath = f.displayPath || f.path;
      return '<div class="file-row" title="' + escapeHtml(displayPath) + '">' +
        '<input class="file-check ' + checkClass + '" type="checkbox" value="' + escapeHtml(f.path) + '"' + checked + '>' +
        '<span class="code">' + escapeHtml(f.code) + '</span>' +
        '<button class="file-name file-diff-link" type="button" data-diff-path="' + escapeHtml(f.path) + '">' + escapeHtml(displayPath) + '</button>' +
      '</div>';
    }).join('') + '</div>' : '<div class="meta">' + escapeHtml(empty) + '</div>') +
  '</section>';
}

function bindFileControls() {
  var modifiedBoxes = Array.prototype.slice.call(document.querySelectorAll('.modified-file-check'));
  var stagedBoxes = Array.prototype.slice.call(document.querySelectorAll('.staged-file-check'));

  modifiedBoxes.forEach(function(box) {
    box.addEventListener('change', function() {
      state.selectedModified[box.value] = box.checked;
      updateCommitControls();
    });
  });
  stagedBoxes.forEach(function(box) {
    box.addEventListener('change', function() {
      state.selectedStaged[box.value] = box.checked;
      updateCommitControls();
    });
  });
  bindSelectAll('selectAllModified', modifiedBoxes, state.selectedModified);
  bindSelectAll('selectAllStaged', stagedBoxes, state.selectedStaged);

  if ($('commitModified')) $('commitModified').addEventListener('click', function() { commitSelectedFiles('modified'); });
  if ($('commitSelected')) $('commitSelected').addEventListener('click', function() { commitSelectedFiles('staged'); });
  if ($('ignoreSelected')) $('ignoreSelected').addEventListener('click', ignoreSelectedFiles);
  if ($('stageSelected')) $('stageSelected').addEventListener('click', stageSelectedFilesAction);
  if ($('unstageSelected')) $('unstageSelected').addEventListener('click', unstageSelectedFilesAction);
  var restoreButton = $('restoreSelected');
  if (restoreButton) {
    restoreButton.addEventListener('click', restoreSelectedFilesAction);
  }
  document.querySelectorAll('.file-diff-link').forEach(function(link) {
    link.addEventListener('click', function(event) {
      event.preventDefault();
      event.stopPropagation();
      openDiffDetail(link.getAttribute('data-diff-path'));
    });
  });

  updateCommitControls();
}

function bindSelectAll(id, boxes, selection) {
  var all = $(id);
  if (!all) return;
  all.addEventListener('change', function() {
    boxes.forEach(function(box) {
      box.checked = all.checked;
      selection[box.value] = all.checked;
    });
    updateCommitControls();
  });
}

function updateCommitControls() {
  var modified = selectedPaths(state.selectedModified);
  var staged = selectedPaths(state.selectedStaged);
  var busy = state.committing || state.ignoring || state.restoring || state.staging || state.unstaging;
  if ($('selectedCount')) {
    $('selectedCount').textContent = (modified.length + staged.length) + ' ' + t('selected');
  }
  var button = $('commitSelected');
  if (button) {
    button.disabled = busy || staged.length === 0;
    button.textContent = state.committing ? t('committing') : t('commitSelected');
  }
  var modifiedCommitButton = $('commitModified');
  if (modifiedCommitButton) {
    modifiedCommitButton.disabled = busy || modified.length === 0;
    modifiedCommitButton.textContent = state.committing ? t('committing') : t('commitSelected');
  }
  var ignoreButton = $('ignoreSelected');
  if (ignoreButton) {
    ignoreButton.disabled = busy || modified.length === 0;
    ignoreButton.textContent = state.ignoring ? t('ignoring') : t('ignore');
  }
  var restoreButton = $('restoreSelected');
  if (restoreButton) {
    restoreButton.disabled = busy || modified.length === 0;
    restoreButton.textContent = state.restoring ? t('restoring') : t('restore');
  }
  var stageButton = $('stageSelected');
  if (stageButton) {
    stageButton.disabled = busy || modified.length === 0;
    stageButton.textContent = state.staging ? t('staging') : t('stage');
  }
  var unstageButton = $('unstageSelected');
  if (unstageButton) {
    unstageButton.disabled = busy || staged.length === 0;
    unstageButton.textContent = state.unstaging ? t('unstaging') : t('unstage');
  }
  updateSelectAll('selectAllModified', '.modified-file-check', modified.length);
  updateSelectAll('selectAllStaged', '.staged-file-check', staged.length);
}

function selectedPaths(selection) {
  return Object.keys(selection).filter(function(filePath) { return selection[filePath]; });
}

function updateSelectAll(id, selector, selectedCount) {
  var all = $(id);
  var boxes = Array.prototype.slice.call(document.querySelectorAll(selector));
  if (all && boxes.length) {
    all.checked = selectedCount === boxes.length;
    all.indeterminate = selectedCount > 0 && selectedCount < boxes.length;
  }
}

function setCommitStatus(message, isError) {
  var target = $('commitStatus');
  if (!target) return;
  target.textContent = message || '';
  target.className = 'commit-status' + (isError ? ' error' : '');
}

function commitSelectedFiles(source) {
  var selection = source === 'modified' ? state.selectedModified : state.selectedStaged;
  var files = selectedPaths(selection);
  if (!files.length || state.committing) return;

  if (!state.install.hooks) {
    var choice = confirm(t('installHooksConfirm'));
    if (choice) {
      // Install hooks first, then commit
      var btn = $('btnInstall');
      if (btn) { btn.disabled = true; btn.textContent = t('installing'); }
      setCommitStatus(t('installingHooks'), false);
      fetch('/api/install?repo=' + encodeURIComponent(targetRepo), { method: 'POST' })
        .then(function(res) { return res.json().then(function(data) { if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status); return data; }); })
        .then(function(data) {
          state.install = data.install || { hooks: true };
          renderInstallBanner();
          if (btn) { btn.textContent = t('installed'); }
          doCommit(files, source);
        })
        .catch(function(err) {
          if (btn) { btn.disabled = false; btn.textContent = t('installFailed'); }
          setCommitStatus(t('hookInstallFailedPrefix') + err.message, true);
        });
      return;
    }
    // User declined install, proceed with direct AI commit
  }

  doCommit(files, source);
}

function doCommit(files, source) {
  state.committing = true;
  var statusMsg = state.install.hooks ? t('commitWithHooksStatus') : t('commitWithAiStatus');
  setCommitStatus(statusMsg, false);
  updateCommitControls();

  fetch('/api/commit-selected?repo=' + encodeURIComponent(targetRepo), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: files, language: currentLanguage || 'en', source: source })
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
      if (source === 'modified') state.selectedModified = {};
      else state.selectedStaged = {};
      setCommitStatus(firstLine(data.output) || t('committedSelected'), false);
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
  var files = selectedPaths(state.selectedModified);
  if (!files.length || state.ignoring) return;
  state.ignoring = true;
  setCommitStatus(t('ignoringSelected'), false);
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
      state.selectedModified = {};
      setCommitStatus((data.added || []).length + t('ignoreRulesAddedSuffix'), false);
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
  var files = selectedPaths(state.selectedModified);
  if (!files.length || state.restoring) return;
  if (!confirm(t('restoreConfirmPrefix') + files.length + t('restoreConfirmSuffix'))) return;
  state.restoring = true;
  setCommitStatus(t('restoringSelected'), false);
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
      state.selectedModified = {};
      setCommitStatus(t('restoredPrefix') + (data.restored || []).length + t('restoredSuffix'), false);
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

function stageSelectedFilesAction() {
  runFileSelectionAction('staging', state.selectedModified, '/api/stage-selected', t('stagingSelected'), function(data) {
    state.selectedModified = {};
    return t('stagedPrefix') + (data.staged || []).length + t('stagedSuffix');
  });
}

function unstageSelectedFilesAction() {
  runFileSelectionAction('unstaging', state.selectedStaged, '/api/unstage-selected', t('unstagingSelected'), function(data) {
    state.selectedStaged = {};
    return t('unstagedPrefix') + (data.unstaged || []).length + t('unstagedSuffix');
  });
}

function runFileSelectionAction(flag, selection, endpoint, statusMessage, successMessage) {
  var files = selectedPaths(selection);
  if (!files.length || state[flag]) return;
  state[flag] = true;
  setCommitStatus(statusMessage, false);
  updateCommitControls();
  fetch(endpoint + '?repo=' + encodeURIComponent(targetRepo), {
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
      setCommitStatus(successMessage(data), false);
      load({ force: true });
    })
    .catch(function(error) {
      setCommitStatus(error.message, true);
    })
    .finally(function() {
      state[flag] = false;
      updateCommitControls();
    });
}

function bindRepositoryBrowserControls() {
  ['branch', 'detailBranchButton'].forEach(function(id) {
    var button = $(id);
    if (!button) return;
    button.addEventListener('click', function(event) {
      event.preventDefault();
      event.stopPropagation();
      toggleBranchMenu(id === 'branch' ? 'branchMenu' : 'detailBranchMenu');
    });
  });

  ['branchMenu', 'detailBranchMenu'].forEach(function(id) {
    var menu = $(id);
    if (!menu) return;
    menu.addEventListener('click', function(event) {
      var option = event.target.closest && event.target.closest('[data-checkout-branch]');
      if (!option) return;
      event.preventDefault();
      checkoutSelectedBranch(option.getAttribute('data-checkout-branch'));
    });
  });

  var browser = $('repoBrowser');
  if (browser) {
    browser.addEventListener('click', function(event) {
      var item = event.target.closest && event.target.closest('[data-repo-path]');
      if (!item) return;
      event.preventDefault();
      openFileDetail(item.getAttribute('data-repo-path'), item.getAttribute('data-entry-type'));
    });
  }

  var back = $('backToDashboard');
  if (back) back.addEventListener('click', closeFileDetailPage);
  var diffBack = $('backFromDiff');
  if (diffBack) diffBack.addEventListener('click', closeDiffDetailPage);

  var tree = $('fileTree');
  if (tree) {
    tree.addEventListener('click', function(event) {
      var toggle = event.target.closest && event.target.closest('[data-tree-toggle]');
      if (toggle) {
        event.preventDefault();
        event.stopPropagation();
        toggleFileTreePath(toggle.getAttribute('data-tree-toggle'));
        return;
      }
      var item = event.target.closest && event.target.closest('[data-tree-path]');
      if (!item) return;
      event.preventDefault();
      loadFileView(item.getAttribute('data-tree-path'), item.getAttribute('data-entry-type'));
    });
  }

  ['repoBreadcrumb', 'fileDetailBreadcrumb'].forEach(function(id) {
    var crumb = $(id);
    if (!crumb) return;
    crumb.addEventListener('click', function(event) {
      var button = event.target.closest && event.target.closest('[data-breadcrumb-path]');
      if (!button) return;
      event.preventDefault();
      var crumbPath = button.getAttribute('data-breadcrumb-path') || '';
      if (id === 'repoBreadcrumb') {
        state.repoBrowserPath = crumbPath;
        loadRepositoryBrowser({ force: true });
      } else {
        loadFileView(crumbPath, 'tree');
      }
    });
  });

  document.addEventListener('click', function(event) {
    if (event.target.closest && event.target.closest('.branch-selector-wrap')) return;
    closeBranchMenus();
  });
  document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape') closeBranchMenus();
  });
}

function toggleBranchMenu(menuId) {
  var menu = $(menuId);
  if (!menu) return;
  var shouldOpen = !menu.classList.contains('open');
  closeBranchMenus();
  if (shouldOpen) {
    menu.classList.add('open');
    var button = menuId === 'branchMenu' ? $('branch') : $('detailBranchButton');
    if (button) {
      button.classList.add('open');
      button.setAttribute('aria-expanded', 'true');
    }
  }
}

function closeBranchMenus() {
  ['branchMenu', 'detailBranchMenu'].forEach(function(id) {
    var menu = $(id);
    if (menu) menu.classList.remove('open');
  });
  ['branch', 'detailBranchButton'].forEach(function(id) {
    var button = $(id);
    if (button) {
      button.classList.remove('open');
      button.setAttribute('aria-expanded', 'false');
    }
  });
}

function renderBranchMenus() {
  var branchName = state.currentBranch || (state.sortedBranches.find(function(branch) { return branch.current; }) || {}).name || '...';
  ['branchText', 'detailBranchButtonText'].forEach(function(id) {
    var text = $(id);
    if (text) text.textContent = branchName;
  });

  var html = state.sortedBranches.length ? state.sortedBranches.map(function(branch) {
    var current = branch.current ? ' current' : '';
    var check = branch.current ? '✓' : '';
    return '<button class="branch-option' + current + '" type="button" role="menuitem" data-checkout-branch="' + escapeHtml(branch.name) + '">' +
      '<span aria-hidden="true">' + check + '</span>' +
      '<span class="branch-option-name">' + escapeHtml(branch.name) + '</span>' +
      '<span class="branch-option-type">' + escapeHtml(branch.remote ? t('remoteBranch') : t('localBranch')) + '</span>' +
    '</button>';
  }).join('') : '<div class="repo-browser-empty">' + escapeHtml(t('noBranches')) + '</div>';

  ['branchMenu', 'detailBranchMenu'].forEach(function(id) {
    var menu = $(id);
    if (menu) menu.innerHTML = html;
  });
}

function checkoutSelectedBranch(branchName) {
  if (!branchName || state.branchSwitching) return;
  closeBranchMenus();
  if (branchName === state.currentBranch) return;
  state.branchSwitching = true;
  setRepoBrowserStatus(t('switchingBranch'), false);
  fetch('/api/checkout-branch?repo=' + encodeURIComponent(targetRepo), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch: branchName })
  })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
        return data;
      });
    })
    .then(function(data) {
      state.repoBrowserPath = '';
      state.fileTree = null;
      state.fileTreeExpanded = {};
      render(data);
      if (isFileDetailOpen()) {
        loadFileTree({ force: true });
        loadFileView(state.fileViewPath, state.fileViewType || 'blob');
      } else if (isDiffDetailOpen()) {
        loadDiffView(state.diffViewPath);
      }
      setRepoBrowserStatus('', false);
    })
    .catch(function(error) {
      setRepoBrowserStatus(t('branchSwitchFailed') + error.message, true);
      alert(t('branchSwitchFailed') + error.message);
    })
    .finally(function() {
      state.branchSwitching = false;
      load({ force: true });
    });
}

function loadRepositoryBrowser(options) {
  options = options || {};
  if (!targetRepo || state.repoBrowserLoading) return Promise.resolve(false);
  if (state.repoBrowserLoaded && !options.force) {
    renderRepositoryBrowser();
    return Promise.resolve(true);
  }
  var repoAtStart = targetRepo;
  state.repoBrowserLoading = true;
  renderRepositoryBrowser();
  return fetch('/api/repository-tree?repo=' + encodeURIComponent(targetRepo) + '&path=' + encodeURIComponent(state.repoBrowserPath || ''), { cache: 'no-store' })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
        return data;
      });
    })
    .then(function(data) {
      if (targetRepo !== repoAtStart) return false;
      state.currentBranch = data.branch || state.currentBranch;
      state.repoBrowserPath = data.path || '';
      state.repoBrowserEntries = data.entries || [];
      state.repoBrowserLoaded = true;
      renderBranchMenus();
      renderRepositoryBrowser();
      return true;
    })
    .catch(function(error) {
      if (targetRepo !== repoAtStart) return false;
      setRepoBrowserStatus(t('fileLoadFailed') + error.message, true);
      return false;
    })
    .finally(function() {
      if (targetRepo !== repoAtStart) return;
      state.repoBrowserLoading = false;
      renderRepositoryBrowser();
    });
}

function renderRepositoryBrowser() {
  var target = $('repoBrowser');
  if (!target) return;
  renderBreadcrumb('repoBreadcrumb', state.repoBrowserPath || '');
  var meta = $('repoBrowserMeta');
  if (meta) meta.textContent = (state.repoBrowserEntries || []).length + ' ' + t('filesCount');
  if (state.repoBrowserLoading && !state.repoBrowserLoaded) {
    target.innerHTML = '<div class="repo-browser-loading">' + escapeHtml(t('loadingFiles')) + '</div>';
    return;
  }
  var entries = state.repoBrowserEntries || [];
  if (!entries.length) {
    target.innerHTML = '<div class="repo-browser-empty">' + escapeHtml(t('noRepositoryFiles')) + '</div>';
    return;
  }
  target.innerHTML = entries.map(repositoryEntryHtml).join('');
}

function repositoryEntryHtml(entry) {
  return '<button class="repo-entry" type="button" data-repo-path="' + escapeHtml(entry.path) + '" data-entry-type="' + escapeHtml(entry.type) + '">' +
    entryIcon(entry.type) +
    '<span class="repo-entry-name">' + escapeHtml(entry.name) + '</span>' +
    '<span class="repo-entry-meta">' + escapeHtml(entry.size != null ? formatFileSize(entry.size) : '') + '</span>' +
  '</button>';
}

function setRepoBrowserStatus(message, isError) {
  var target = $('repoBrowserStatus');
  if (!target) return;
  target.textContent = message || '';
  target.className = 'repo-browser-status' + (isError ? ' error' : '');
}

function openFileDetail(filePath, entryType) {
  state.fileViewPath = filePath || '';
  state.fileViewType = entryType === 'tree' ? 'tree' : 'blob';
  if ($('dashboardPage')) $('dashboardPage').hidden = true;
  if ($('fileDetailPage')) $('fileDetailPage').hidden = false;
  if ($('diffDetailPage')) $('diffDetailPage').hidden = true;
  clearTimeout(state.timer);
  loadFileTree({ force: !state.fileTree });
  loadFileView(state.fileViewPath, state.fileViewType);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function closeFileDetailPage() {
  if ($('fileDetailPage')) $('fileDetailPage').hidden = true;
  if ($('dashboardPage')) $('dashboardPage').hidden = false;
  state.fileViewPath = '';
  state.fileViewType = '';
  refreshLayoutSoon();
  schedule();
}

function openDiffDetail(filePath) {
  if (!filePath) return;
  state.diffViewPath = filePath;
  if ($('dashboardPage')) $('dashboardPage').hidden = true;
  if ($('fileDetailPage')) $('fileDetailPage').hidden = true;
  if ($('diffDetailPage')) $('diffDetailPage').hidden = false;
  clearTimeout(state.timer);
  loadDiffView(filePath);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function closeDiffDetailPage() {
  if ($('diffDetailPage')) $('diffDetailPage').hidden = true;
  if ($('dashboardPage')) $('dashboardPage').hidden = false;
  state.diffViewPath = '';
  refreshLayoutSoon();
  schedule();
}

function bindConflictControls() {
  var resolveBtn = $('btnResolveConflict');
  if (resolveBtn) {
    resolveBtn.addEventListener('click', function() {
      resolveConflictWithAI(state.diffViewPath);
    });
  }
  var editBtn = $('btnManualEdit');
  if (editBtn) {
    editBtn.addEventListener('click', function() {
      manualEditConflict(state.diffViewPath);
    });
  }
}

function resolveConflictWithAI(filePath) {
  if (!filePath || state.resolvingConflict) return;
  state.resolvingConflict = true;
  var btn = $('btnResolveConflict');
  var status = $('conflictStatus');
  if (btn) { btn.disabled = true; }
  if (status) { status.textContent = t('resolvingConflict'); status.className = 'meta'; }

  fetch('/api/merge/accept-file?repo=' + encodeURIComponent(targetRepo), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath })
  })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
        return data;
      });
    })
    .then(function(data) {
      if (status) { status.textContent = t('conflictResolved'); status.className = 'meta'; }
      if (btn) { btn.disabled = false; }
      setTimeout(function() { closeDiffDetailPage(); load({ force: true }); }, 800);
    })
    .catch(function(error) {
      if (status) { status.textContent = t('conflictResolveFailed') + error.message; status.className = 'meta error'; }
      if (btn) { btn.disabled = false; }
    })
    .finally(function() {
      state.resolvingConflict = false;
    });
}

function manualEditConflict(filePath) {
  if (!filePath) return;
  fetch('/api/merge/conflict-detail?repo=' + encodeURIComponent(targetRepo) + '&path=' + encodeURIComponent(filePath), { cache: 'no-store' })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
        return data;
      });
    })
    .then(function(detail) {
      showConflictEditor(filePath, detail.conflicted || '');
    })
    .catch(function(error) {
      var status = $('conflictStatus');
      if (status) { status.textContent = error.message; status.className = 'meta error'; }
    });
}

function showConflictEditor(filePath, content) {
  var backdrop = $('tokenConfirmModal');
  if (!backdrop) return;
  backdrop.innerHTML = [
    '<div class="modal" style="width:min(800px,96%);">',
    '  <h2>' + escapeHtml(t('mergeConflict')) + ': ' + escapeHtml(filePath) + '</h2>',
    '  <p style="margin-bottom:12px;color:var(--muted);">' + escapeHtml(t('manualEdit')) + '</p>',
    '  <textarea id="conflictEditor" style="width:100%;min-height:360px;border:1px solid var(--line);border-radius:7px;padding:10px;font-family:monospace;font-size:13px;line-height:1.5;resize:vertical;" spellcheck="false">' + escapeHtml(content) + '</textarea>',
    '  <div class="modal-actions">',
    '    <button id="cancelConflictEdit" class="copy-button" type="button">' + escapeHtml(t('cancel')) + '</button>',
    '    <button id="saveConflictEdit" class="commit-button" type="button">' + escapeHtml(t('editSaveAndAccept')) + '</button>',
    '  </div>',
    '</div>'
  ].join('');
  backdrop.classList.add('visible');

  $('cancelConflictEdit').addEventListener('click', function() {
    backdrop.classList.remove('visible');
  });
  $('saveConflictEdit').addEventListener('click', function() {
    var resolved = $('conflictEditor').value;
    $('saveConflictEdit').disabled = true;
    $('saveConflictEdit').textContent = t('working');
    fetch('/api/merge/accept-file?repo=' + encodeURIComponent(targetRepo), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, content: resolved })
    })
      .then(function(res) {
        return res.json().then(function(d) {
          if (!res.ok || d.error) throw new Error(d.error || 'HTTP ' + res.status);
          return d;
        });
      })
      .then(function() {
        backdrop.classList.remove('visible');
        closeDiffDetailPage();
        load({ force: true });
      })
      .catch(function(error) {
        alert(error.message);
        $('saveConflictEdit').disabled = false;
        $('saveConflictEdit').textContent = t('editSaveAndAccept');
      });
  });
}

function isFileDetailOpen() {
  var page = $('fileDetailPage');
  return !!(page && !page.hidden);
}

function isDiffDetailOpen() {
  var page = $('diffDetailPage');
  return !!(page && !page.hidden);
}

function isDetailPageOpen() {
  return isFileDetailOpen() || isDiffDetailOpen();
}

function loadDiffView(filePath) {
  if (!targetRepo || !filePath || state.diffViewLoading) return Promise.resolve(false);
  state.diffViewLoading = true;
  renderDiffLoading(filePath);
  return fetch('/api/file-diff?repo=' + encodeURIComponent(targetRepo) + '&path=' + encodeURIComponent(filePath), { cache: 'no-store' })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
        return data;
      });
    })
    .then(function(data) {
      renderDiffView(data);
      bindConflictControls();
      return true;
    })
    .catch(function(error) {
      $('diffViewTitle').textContent = fileNameFromPath(filePath);
      $('diffViewMeta').textContent = '';
      $('diffViewContent').innerHTML = '<div class="repo-browser-empty">' + escapeHtml(t('diffLoadFailed') + error.message) + '</div>';
      return false;
    })
    .finally(function() {
      state.diffViewLoading = false;
    });
}

function renderDiffLoading(filePath) {
  renderBreadcrumb('diffBreadcrumb', filePath);
  if ($('diffViewTitle')) $('diffViewTitle').textContent = fileNameFromPath(filePath);
  if ($('diffViewMeta')) $('diffViewMeta').textContent = t('loadingDiff');
  if ($('diffViewContent')) $('diffViewContent').innerHTML = '<div class="repo-browser-loading">' + escapeHtml(t('loadingDiff')) + '</div>';
}

function renderDiffView(data) {
  $('diffViewTitle').textContent = data.displayPath || data.path || state.diffViewPath;
  $('diffViewMeta').textContent = [data.code, data.truncated ? t('truncatedFile') : ''].filter(Boolean).join(' · ');
  renderBreadcrumb('diffBreadcrumb', data.path || state.diffViewPath);
  $('diffViewContent').innerHTML = diffCodeHtml(data.diff || '');

  // Show conflict info for UU (merge conflict) files
  var conflictInfo = $('conflictInfo');
  if (data.mergeConflict && conflictInfo) {
    conflictInfo.hidden = false;
    var mergeInfo = $('conflictMergeInfo');
    if (mergeInfo) {
      mergeInfo.textContent = data.displayPath || data.path || state.diffViewPath;
    }
  } else if (conflictInfo) {
    conflictInfo.hidden = true;
  }
}

function diffCodeHtml(diff) {
  var lines = String(diff || '').split(/\\r?\\n/);
  if (!diff) {
    return '<div class="repo-browser-empty">' + escapeHtml(t('noDiff')) + '</div>';
  }
  return '<pre class="diff-code">' + lines.map(function(line) {
    var cls = 'ctx';
    if (line.indexOf('+++') === 0 || line.indexOf('---') === 0 || line.indexOf('diff --git') === 0 || line.indexOf('index ') === 0) cls = 'meta';
    else if (line.indexOf('@@') === 0) cls = 'hunk';
    else if (line.charAt(0) === '+') cls = 'add';
    else if (line.charAt(0) === '-') cls = 'del';
    return '<span class="diff-line ' + cls + '">' + escapeHtml(line || ' ') + '</span>';
  }).join('') + '</pre>';
}

function loadFileTree(options) {
  options = options || {};
  if (!targetRepo || state.fileTreeLoading) return Promise.resolve(false);
  if (state.fileTree && !options.force) {
    renderFileTree();
    return Promise.resolve(true);
  }
  state.fileTreeLoading = true;
  renderFileTree();
  return fetch('/api/repository-tree?repo=' + encodeURIComponent(targetRepo) + '&recursive=1', { cache: 'no-store' })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
        return data;
      });
    })
    .then(function(data) {
      state.currentBranch = data.branch || state.currentBranch;
      state.fileTree = data.tree || null;
      renderBranchMenus();
      renderFileTree();
      return true;
    })
    .catch(function(error) {
      var tree = $('fileTree');
      if (tree) tree.innerHTML = '<div class="file-tree-empty">' + escapeHtml(t('fileLoadFailed') + error.message) + '</div>';
      return false;
    })
    .finally(function() {
      state.fileTreeLoading = false;
    });
}

function renderFileTree() {
  var target = $('fileTree');
  if (!target) return;
  if (state.fileTreeLoading && !state.fileTree) {
    target.innerHTML = '<div class="file-tree-empty">' + escapeHtml(t('loadingFiles')) + '</div>';
    return;
  }
  if (!state.fileTree || !state.fileTree.children || !state.fileTree.children.length) {
    target.innerHTML = '<div class="file-tree-empty">' + escapeHtml(t('noRepositoryFiles')) + '</div>';
    return;
  }
  target.innerHTML = state.fileTree.children.map(function(child) {
    return fileTreeNodeHtml(child, 0);
  }).join('');
}

function toggleFileTreePath(filePath) {
  if (!filePath) return;
  state.fileTreeExpanded[filePath] = !state.fileTreeExpanded[filePath];
  renderFileTree();
}

function fileTreeNodeHtml(node, depth) {
  var active = node.path === state.fileViewPath ? ' active' : '';
  var isTree = node.type === 'tree';
  var expanded = isTree && state.fileTreeExpanded[node.path] === true;
  var toggle = isTree
    ? '<button class="file-tree-toggle' + (expanded ? ' expanded' : '') + '" type="button" data-tree-toggle="' + escapeHtml(node.path) + '" aria-label="' + escapeHtml((expanded ? 'Collapse ' : 'Expand ') + node.name) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg></button>'
    : '<span class="file-tree-toggle-placeholder"></span>';
  var html = '<div class="file-tree-row' + active + '" role="button" tabindex="0" style="padding-left:' + (6 + depth * 14) + 'px" data-tree-path="' + escapeHtml(node.path) + '" data-entry-type="' + escapeHtml(node.type) + '">' +
    toggle + entryIcon(node.type) +
    '<span class="file-tree-name">' + escapeHtml(node.name) + '</span>' +
  '</div>';
  if (expanded && node.children && node.children.length) {
    html += '<div class="file-tree-group">' + node.children.map(function(child) {
      return fileTreeNodeHtml(child, depth + 1);
    }).join('') + '</div>';
  }
  return html;
}

function loadFileView(filePath, entryType) {
  if (!targetRepo || state.fileViewLoading) return Promise.resolve(false);
  state.fileViewPath = filePath;
  state.fileViewType = entryType === 'tree' ? 'tree' : 'blob';
  state.fileViewLoading = true;
  renderFileTree();
  renderBreadcrumb('fileDetailBreadcrumb', filePath);
  renderFileLoading();
  var url = entryType === 'tree'
    ? '/api/repository-tree?repo=' + encodeURIComponent(targetRepo) + '&path=' + encodeURIComponent(filePath)
    : '/api/repository-file?repo=' + encodeURIComponent(targetRepo) + '&path=' + encodeURIComponent(filePath);
  return fetch(url, { cache: 'no-store' })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
        return data;
      });
    })
    .then(function(data) {
      if (entryType === 'tree') renderDirectoryView(data);
      else renderFileView(data);
      return true;
    })
    .catch(function(error) {
      $('fileViewTitle').textContent = fileNameFromPath(filePath);
      $('fileViewMeta').textContent = '';
      $('fileViewContent').innerHTML = '<div class="repo-browser-empty">' + escapeHtml(t('fileLoadFailed') + error.message) + '</div>';
      return false;
    })
    .finally(function() {
      state.fileViewLoading = false;
      renderFileTree();
    });
}

function renderFileLoading() {
  if ($('fileViewTitle')) $('fileViewTitle').textContent = fileNameFromPath(state.fileViewPath) || state.currentBranch || '...';
  if ($('fileViewMeta')) $('fileViewMeta').textContent = t('loadingFile');
  if ($('fileViewContent')) $('fileViewContent').innerHTML = '<div class="repo-browser-loading">' + escapeHtml(t('loadingFile')) + '</div>';
}

function renderDirectoryView(data) {
  var title = data.path ? fileNameFromPath(data.path) : state.currentBranch;
  $('fileViewTitle').textContent = title || t('repositoryFiles');
  $('fileViewMeta').textContent = (data.entries || []).length + ' ' + t('filesCount');
  $('fileViewContent').innerHTML = '<div class="repo-browser file-view-directory">' +
    ((data.entries || []).length ? data.entries.map(function(entry) {
      return repositoryEntryHtml(entry).replace(/data-repo-path=/g, 'data-tree-path=');
    }).join('') : '<div class="repo-browser-empty">' + escapeHtml(t('noRepositoryFiles')) + '</div>') +
  '</div>';
  $('fileViewContent').querySelectorAll('[data-tree-path]').forEach(function(item) {
    item.addEventListener('click', function(event) {
      event.preventDefault();
      loadFileView(item.getAttribute('data-tree-path'), item.getAttribute('data-entry-type'));
    });
  });
}

function renderFileView(data) {
  $('fileViewTitle').textContent = data.name || fileNameFromPath(data.path);
  $('fileViewMeta').textContent = [formatFileSize(data.size), data.language, data.truncated ? t('truncatedFile') : ''].filter(Boolean).join(' · ');
  renderBreadcrumb('fileDetailBreadcrumb', data.path || state.fileViewPath);
  if (data.dataUrl) {
    $('fileViewContent').innerHTML = '<div class="file-image-preview"><img src="' + escapeHtml(data.dataUrl) + '" alt="' + escapeHtml(data.name || data.path) + '"></div>';
    return;
  }
  if (data.binary) {
    $('fileViewContent').innerHTML = '<div class="file-binary">' + escapeHtml(data.size > 5 * 1024 * 1024 ? t('largeFile') : t('binaryFile')) + '</div>';
    return;
  }
  $('fileViewContent').innerHTML = codeViewHtml(data.content || '');
}

function codeViewHtml(content) {
  var lines = String(content || '').split(/\\r?\\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) lines = [''];
  return '<pre class="code-view">' + lines.map(function(line, index) {
    return '<span class="code-line-no">' + (index + 1) + '</span><span class="code-line-text">' + escapeHtml(line) + '</span>';
  }).join('') + '</pre>';
}

function renderBreadcrumb(targetId, filePath) {
  var target = $(targetId);
  if (!target) return;
  var parts = String(filePath || '').split('/').filter(Boolean);
  var cursor = '';
  var html = '<button type="button" data-breadcrumb-path="">' + escapeHtml(repoDisplayName(targetRepo) || state.currentBranch || 'repo') + '</button>';
  parts.forEach(function(part) {
    cursor = cursor ? (cursor + '/' + part) : part;
    html += '<span>/</span><button type="button" data-breadcrumb-path="' + escapeHtml(cursor) + '">' + escapeHtml(part) + '</button>';
  });
  target.innerHTML = html;
}

function entryIcon(type) {
  if (type === 'tree') {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H10l2 2h5.5A2.5 2.5 0 0 1 20 8.5v7A2.5 2.5 0 0 1 17.5 18h-11A2.5 2.5 0 0 1 4 15.5z"></path></svg>';
  }
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z"></path><path d="M14 2v5h5"></path></svg>';
}

function formatFileSize(size) {
  if (size == null || Number.isNaN(Number(size))) return '';
  var value = Number(size);
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(value < 10 * 1024 ? 1 : 0) + ' KB';
  return (value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
}

function fileNameFromPath(filePath) {
  var parts = String(filePath || '').split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

function renderBranches() {
  var box = $('branches');
  if (!box) return;
  if (!state.sortedBranches.length) { box.innerHTML = '<div class="meta">' + escapeHtml(t('noBranches')) + '</div>'; return; }

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
  if (!commits.length) { box.innerHTML = '<div class="meta">' + escapeHtml(t('noCommits')) + '</div>'; return; }
  box.innerHTML = commits.map(function(c) {
    var date = c.date ? new Date(c.date).toLocaleString() : '';
    var bName = state.commitBranch[c.hash] || '';
    var cColor = getBranchColor(bName);
    var aiStatus = '';
    var task = (state.tasks || []).find(function(t) { return t.targetOid === c.hash; });
    if (task && (task.status === 'pending' || task.status === 'running' || task.status === 'waiting')) {
      aiStatus = '<span class="ai-status" title="' + escapeHtml(t('aiGenerating')) + '" aria-label="' + escapeHtml(t('aiGenerating')) + '">' +
        '<svg class="ai-status-loader" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M21 12a9 9 0 0 0-9-9"></path></svg>' +
        '<svg class="ai-status-sparkles" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l1.8 5.1 5.1 1.8-5.1 1.8-1.8 5.1-1.8-5.1-5.1-1.8 5.1-1.8L12 2.5z"></path><path d="M5.4 14.2l.9 2.5 2.5.9-2.5.9-.9 2.5-.9-2.5-2.5-.9 2.5-.9.9-2.5z"></path></svg>' +
      '</span>';
    }
    return '<article class="commit" role="button" tabindex="0" data-oid="' + escapeHtml(c.hash) + '"><div><div class="subject">' + escapeHtml(c.subject || '(' + t('noSubject') + ')') + aiStatus + '</div><div class="meta"><span class="hash" style="color:' + cColor + '">' + escapeHtml(c.shortHash) + '</span> &bull; ' + escapeHtml(c.author) + ' &bull; ' + escapeHtml(date) + (bName ? ' &bull; ' + escapeHtml(bName) : '') + '</div></div></article>';
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
    svgHTML += '<circle cx="' + cx + '" cy="' + cy + '" r="' + nodeRadius + '" fill="' + node.color + '" stroke="#ffffff" stroke-width="2" class="node" role="button" tabindex="0" data-oid="' + escapeHtml(node.hash) + '" />';
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
  state.detailPinned = !!pinned;
  clearTimeout(state.hideTimer);
  var token = ++state.detailToken;
  positionCommitDrawer(trigger);
  fetch('/api/commit?oid=' + encodeURIComponent(oid) + '&repo=' + encodeURIComponent(targetRepo))
    .then(function(res) { return res.json(); })
    .then(function(detail) {
      if (token !== state.detailToken) return;
      $('drawerTitle').textContent = oid.slice(0, 12);
      $('drawerMeta').textContent = t('commitDetail');
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
      $('drawerMeta').textContent = t('copied');
    }).catch(function() {
      $('drawerMeta').textContent = t('selectTextAndCopy');
    });
    return;
  }
  $('drawerMeta').textContent = t('selectTextAndCopy');
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
.repo-line { display: block; margin-top: 4px; }
.repo { display: block; min-width: 0; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; overflow-wrap: anywhere; text-decoration: none; }
.repo[href]:hover { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
.agent-bar { display: flex; align-items: center; gap: 4px; margin-top: 6px; flex-wrap: wrap; }
.agent-bar[hidden] { display: none; }
.agent-btn { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px 3px 6px; border: 1px solid var(--line); border-radius: 6px; color: var(--muted); background: transparent; cursor: pointer; font-size: 11px; font-weight: 500; white-space: nowrap; transition: color .16s, background .16s, border-color .16s; }
.agent-btn:hover { color: var(--accent); background: var(--accent-soft); border-color: var(--accent); }
.agent-btn svg { width: 14px; height: 14px; flex-shrink: 0; pointer-events: none; }
.agent-btn[hidden] { display: none; }
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
.quick-actions { display: flex; gap: 10px; align-items: stretch; margin-top: 10px; flex-wrap: wrap; }
.quick-actions[hidden] { display: none; }
.qa-btn { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; width: 62px; height: 56px; padding: 6px 3px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--muted); cursor: pointer; transition: color .16s, background .16s, border-color .16s, transform .16s; }
.qa-btn:hover { color: var(--accent); background: var(--accent-soft); border-color: var(--accent); transform: translateY(-1px); }
.qa-btn svg, .qa-icon { width: 20px; height: 20px; flex-shrink: 0; pointer-events: none; }
.qa-icon { display: block; object-fit: contain; }
.qa-btn span { font-size: 9px; font-weight: 650; line-height: 1.1; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.qa-ide-btn[hidden] { display: none; }
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
      <div class="repo-line">
        <a id="repo" class="repo"></a>
      </div>
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
  var FETCH_TIMEOUT_MS = 30000;
  window.fetch = function(input, init) {
    init = init || {};
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, FETCH_TIMEOUT_MS);
    if (init.signal) {
      init.signal.addEventListener('abort', function() { controller.abort(); });
    }
    init.signal = controller.signal;
    var headers = new Headers(init.headers || {});
    var fetchUrl = new URL(typeof input === 'string' ? input : input.url, window.location.href);
    if (GMC_AUTH_TOKEN && fetchUrl.origin === window.location.origin) headers.set('X-GMC-Auth', GMC_AUTH_TOKEN);
    init.headers = headers;
    return nativeFetch(input, init).finally(function() { clearTimeout(timer); });
  };
})();
var urlParams = new URLSearchParams(window.location.search);
var targetRepo = urlParams.get('repo') || '';
var bodyEl = document.getElementById('readmeBody');
var README_I18N = {
  'zh-CN': {
    back: '返回 GitWeb',
    loading: '正在加载 README...',
    noRepositorySelected: '未选择仓库',
    failedPrefix: 'README 加载失败：',
    openInFinderPrefix: '在 Finder 中打开：',
    finderLocalOnly: '仅从 127.0.0.1 访问时可以在 Finder 中打开。',
    openFinderFailed: '在 Finder 中打开失败：',
    openTerminal: '在终端中打开',
    openTerminalPrefix: '在终端中打开：',
    terminalLocalOnly: '仅从 127.0.0.1 访问时可以打开终端。',
    openTerminalFailed: '打开终端失败：'
  },
  en: {
    back: 'Back to GitWeb',
    loading: 'Loading README...',
    noRepositorySelected: 'No repository selected',
    failedPrefix: 'Failed to load README: ',
    openInFinderPrefix: 'Open in Finder: ',
    finderLocalOnly: 'Finder opening is available only from 127.0.0.1.',
    openFinderFailed: 'Open in Finder failed: ',
    openTerminal: 'Open in Terminal',
    openTerminalPrefix: 'Open in Terminal: ',
    terminalLocalOnly: 'Terminal opening is available only from 127.0.0.1.',
    openTerminalFailed: 'Open in Terminal failed: '
  },
  ja: {
    back: 'GitWeb に戻る',
    loading: 'README を読み込み中...',
    noRepositorySelected: 'リポジトリが選択されていません',
    failedPrefix: 'README の読み込みに失敗しました: ',
    openInFinderPrefix: 'Finder で開く: ',
    finderLocalOnly: 'Finder で開く操作は 127.0.0.1 からのアクセス時のみ利用できます。',
    openFinderFailed: 'Finder で開けませんでした: ',
    openTerminal: 'ターミナルで開く',
    openTerminalPrefix: 'ターミナルで開く: ',
    terminalLocalOnly: 'ターミナルを開く操作は 127.0.0.1 からのアクセス時のみ利用できます。',
    openTerminalFailed: 'ターミナルを開けませんでした: '
  },
  ko: {
    back: 'GitWeb으로 돌아가기',
    loading: 'README 불러오는 중...',
    noRepositorySelected: '선택된 저장소 없음',
    failedPrefix: 'README를 불러오지 못했습니다: ',
    openInFinderPrefix: 'Finder에서 열기: ',
    finderLocalOnly: 'Finder에서 열기는 127.0.0.1에서 접속한 경우에만 사용할 수 있습니다.',
    openFinderFailed: 'Finder에서 열기 실패: ',
    openTerminal: '터미널에서 열기',
    openTerminalPrefix: '터미널에서 열기: ',
    terminalLocalOnly: '터미널 열기는 127.0.0.1에서 접속한 경우에만 사용할 수 있습니다.',
    openTerminalFailed: '터미널 열기 실패: '
  },
  es: {
    back: 'Volver a GitWeb',
    loading: 'Cargando README...',
    noRepositorySelected: 'No hay repositorio seleccionado',
    failedPrefix: 'Error al cargar README: ',
    openInFinderPrefix: 'Abrir en Finder: ',
    finderLocalOnly: 'Abrir en Finder solo está disponible desde 127.0.0.1.',
    openFinderFailed: 'Error al abrir en Finder: ',
    openTerminal: 'Abrir en Terminal',
    openTerminalPrefix: 'Abrir en Terminal: ',
    terminalLocalOnly: 'Abrir Terminal solo está disponible desde 127.0.0.1.',
    openTerminalFailed: 'Error al abrir Terminal: '
  },
  fr: {
    back: 'Retour à GitWeb',
    loading: 'Chargement du README...',
    noRepositorySelected: 'Aucun dépôt sélectionné',
    failedPrefix: 'Échec du chargement du README : ',
    openInFinderPrefix: 'Ouvrir dans Finder : ',
    finderLocalOnly: 'L’ouverture dans Finder n’est disponible que depuis 127.0.0.1.',
    openFinderFailed: 'Échec d’ouverture dans Finder : ',
    openTerminal: 'Ouvrir dans Terminal',
    openTerminalPrefix: 'Ouvrir dans Terminal : ',
    terminalLocalOnly: 'L’ouverture du Terminal n’est disponible que depuis 127.0.0.1.',
    openTerminalFailed: 'Échec d’ouverture du Terminal : '
  }
};
var README_LANGUAGE_ALIASES = {
  zh: 'zh-CN',
  'zh-cn': 'zh-CN',
  'zh-hans': 'zh-CN',
  en: 'en',
  ja: 'ja',
  jp: 'ja',
  ko: 'ko',
  kr: 'ko',
  es: 'es',
  fr: 'fr'
};
var currentLanguage = normalizeReadmeLanguage(localStorage.getItem('gmc_language') || navigator.language || '');
document.documentElement.lang = currentLanguage;
document.getElementById('backLink').textContent = rt('back');
bodyEl.innerHTML = '<div class="meta">' + escapeHtml(rt('loading')) + '</div>';
updateRepoLink(targetRepo || rt('noRepositorySelected'), targetRepo);
document.getElementById('backLink').href = targetRepo ? '/?repo=' + encodeURIComponent(targetRepo) : '/';
document.getElementById('repo').addEventListener('click', openCurrentRepository);

if (!targetRepo) {
  bodyEl.innerHTML = '<div class="meta">' + escapeHtml(rt('noRepositorySelected')) + '</div>';
} else {
  fetch('/api/readme?repo=' + encodeURIComponent(targetRepo), { cache: 'no-store' })
    .then(function(res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(renderReadme)
    .catch(function(err) {
      bodyEl.innerHTML = '<div class="meta">' + escapeHtml(rt('failedPrefix') + err.message) + '</div>';
    });
}

function rt(key) {
  var table = README_I18N[currentLanguage] || README_I18N.en;
  return table[key] || README_I18N.en[key] || key;
}

function normalizeReadmeLanguage(value) {
  var normalized = String(value || '').toLowerCase().replace(/_/g, '-');
  if (README_LANGUAGE_ALIASES[normalized]) return README_LANGUAGE_ALIASES[normalized];
  var base = normalized.split('-')[0];
  return README_LANGUAGE_ALIASES[base] || 'en';
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
    link.title = rt('openInFinderPrefix') + repoPath;
  } else {
    link.removeAttribute('href');
    if (repoPath) {
      link.title = rt('finderLocalOnly');
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
      alert(rt('openFinderFailed') + error.message);
    });
}

function openCurrentTerminal(event) {
  if (event) event.preventDefault();
  if (!targetRepo) return;
  if (!canOpenRepositoryLocally()) return;
  fetch('/api/open-terminal?repo=' + encodeURIComponent(targetRepo), { method: 'POST' })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
        return data;
      });
    })
    .catch(function(error) {
      alert(rt('openTerminalFailed') + error.message);
    });
}

function openProjectIde(event) {
  if (event) event.preventDefault();
  if (!targetRepo) return;
  if (!canOpenRepositoryLocally()) return;
  fetch('/api/open-ide?repo=' + encodeURIComponent(targetRepo), { method: 'POST' })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
        return data;
      });
    })
    .catch(function(error) {
      alert('Failed to open IDE: ' + error.message);
    });
}

function openAgentTerminal(event, btn) {
  console.log('openAgentTerminal called');
  if (event) event.preventDefault();
  if (!targetRepo) { console.log('no targetRepo'); return; }
  if (!canOpenRepositoryLocally()) { console.log('not local'); return; }
  var agent = btn.getAttribute('data-agent');
  console.log('agent:', agent);
  if (!agent) { console.log('no agent'); return; }
  var url = '/api/open-agent?repo=' + encodeURIComponent(targetRepo) + '&agent=' + encodeURIComponent(agent);
  console.log('fetching:', url);
  fetch(url, { method: 'POST' })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
        console.log('response:', data);
        return data;
      });
    })
    .catch(function(error) {
      console.error('fetch error:', error);
      alert(rt('openTerminalFailed') + agent + ': ' + error.message);
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

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  var k = 1024;
  var sizes = ['B', 'KB', 'MB', 'GB'];
  var i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
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
    req.setTimeout(5000, function () {
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
