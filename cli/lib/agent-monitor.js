'use strict';

var childProcess = require('child_process');
var fs = require('fs');
var http = require('http');
var net = require('net');
var os = require('os');
var path = require('path');

var DEFAULT_PORT = 8898;
var DEFAULT_START_TIMEOUT_MS = 15000;
var DEFAULT_STOP_TIMEOUT_MS = 2000;
var PROBE_TIMEOUT_MS = 800;
var PROBE_INTERVAL_MS = 200;
var MAX_HEALTH_BYTES = 64 * 1024;
var OUTPUT_TAIL_BYTES = 16 * 1024;

function createManager(options) {
  options = options || {};

  var env = options.env || process.env;
  var state = {
    enabled: true,
    status: 'idle',
    healthy: false,
    available: false,
    owned: false,
    port: null,
    url: null,
    reason: null,
    detail: null,
    pid: null,
    logPath: null
  };
  var child = null;
  var childExited = false;
  var childError = null;
  var outputTail = '';
  var logStream = null;
  var startPromise = null;
  var stopPromise = null;
  var stopping = false;
  var exitHandlerInstalled = false;

  function start() {
    if (startPromise) {
      return startPromise;
    }
    startPromise = startInternal().catch(function (error) {
      return fail('unavailable', error && error.message);
    });
    return startPromise;
  }

  function startInternal() {
    if (isDisabled(env)) {
      updateState({
        enabled: false,
        status: 'disabled',
        reason: 'disabled'
      });
      return Promise.resolve(state);
    }

    var port = resolvePort(options.port || env.GMC_AGENT_MONITOR_PORT);
    if (!port) {
      return Promise.resolve(fail('invalid_configuration', 'Invalid Agent Monitor port.'));
    }

    updateState({
      status: 'probing',
      port: port,
      url: 'http://127.0.0.1:' + port
    });

    return probeHealth(port).then(function (probe) {
      if (probe.compatible) {
        return reuse();
      }
      return portIsOccupied(port).then(function (occupied) {
        if (occupied) {
          return fail('port_conflict', 'Port ' + port + ' is used by an incompatible service.');
        }
        return spawnService(port);
      });
    });
  }

  function spawnService(port) {
    var serverPath = resolveServerPath(options, env);
    if (!serverPath) {
      return Promise.resolve(fail(
        'service_missing',
        'Packaged Agent Monitor server.py was not found.'
      ));
    }

    var pythonPath = resolvePythonPath(options, env, path.dirname(serverPath));
    var timeoutMs = positiveNumber(
      options.startTimeoutMs || env.GMC_AGENT_MONITOR_START_TIMEOUT_MS,
      DEFAULT_START_TIMEOUT_MS
    );
    var args = [
      serverPath,
      '--host', '127.0.0.1',
      '--port', String(port)
    ];
    var childEnv = copyEnvironment(env);
    childEnv.PYTHONUNBUFFERED = '1';

    outputTail = '';
    childExited = false;
    childError = null;
    openLog(options.logPath || env.GMC_AGENT_MONITOR_LOG);
    writeLog('[gmc] starting Agent Monitor: ' + pythonPath + ' ' + args.join(' ') + '\n');
    updateState({
      status: 'starting',
      reason: null,
      detail: null
    });

    try {
      child = (options.spawn || childProcess.spawn)(pythonPath, args, {
        cwd: path.dirname(serverPath),
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      childError = error;
      childExited = true;
      closeLog();
      return Promise.resolve(fail(classifyFailure(), error.message));
    }

    state.owned = true;
    state.pid = child.pid || null;
    installExitHandler();
    captureOutput(child.stdout);
    captureOutput(child.stderr);
    child.on('error', function (error) {
      childError = error;
      writeLog('[gmc] Agent Monitor spawn error: ' + error.message + '\n');
    });
    child.on('close', function (code, signal) {
      childExited = true;
      writeLog(
        '[gmc] Agent Monitor exited' +
        (signal ? ' from ' + signal : ' with code ' + code) + '\n'
      );
      if (child && child.pid === state.pid) {
        child = null;
      }
      state.pid = null;
      removeExitHandler();
      closeLog();
      if (!stopping && state.healthy) {
        fail('process_exited', 'The GMC-managed Agent Monitor process exited unexpectedly.');
      }
    });

    return waitForReady(port, Date.now() + timeoutMs);
  }

  function waitForReady(port, deadline) {
    return probeHealth(port).then(function (probe) {
      if (probe.compatible) {
        if (childExited) {
          return reuse();
        }
        return delay(100).then(function () {
          if (childExited) {
            return probeHealth(port).then(function (confirmed) {
              return confirmed.compatible ? reuse() : finishFailedStart();
            });
          }
          updateState({
            enabled: true,
            status: 'running',
            healthy: true,
            available: true,
            owned: true,
            reason: null,
            detail: null
          });
          return state;
        });
      }

      if (childExited || childError) {
        return finishFailedStart();
      }
      if (Date.now() >= deadline) {
        return terminateOwned().then(function () {
          return fail('timeout', 'Agent Monitor did not become healthy before the startup timeout.');
        });
      }
      return delay(PROBE_INTERVAL_MS).then(function () {
        return waitForReady(port, deadline);
      });
    });
  }

  function finishFailedStart() {
    var reason = classifyFailure();
    var detail = failureDetail(reason);
    return terminateOwned().then(function () {
      return fail(reason, detail);
    });
  }

  function reuse() {
    if (child && !childExited) {
      stopping = true;
      return terminateOwned().then(function () {
        stopping = false;
        return markReused();
      });
    }
    return markReused();
  }

  function markReused() {
    updateState({
      enabled: true,
      status: 'reused',
      healthy: true,
      available: true,
      owned: false,
      reason: null,
      detail: null,
      pid: null
    });
    return state;
  }

  function stop() {
    if (stopPromise) {
      return stopPromise;
    }
    stopping = true;
    stopPromise = terminateOwned().then(function () {
      updateState({
        status: 'stopped',
        healthy: false,
        available: false,
        owned: false,
        reason: 'stopped',
        pid: null
      });
      removeExitHandler();
      closeLog();
      return state;
    });
    return stopPromise;
  }

  function terminateOwned() {
    var target = child;
    if (!state.owned || !target || target.exitCode != null || target.signalCode) {
      child = null;
      state.pid = null;
      return Promise.resolve();
    }

    return new Promise(function (resolve) {
      var settled = false;
      var timer;

      function finish() {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (child === target) child = null;
        state.pid = null;
        resolve();
      }

      target.once('close', finish);
      try {
        target.kill('SIGTERM');
      } catch (error) {
        finish();
        return;
      }
      timer = setTimeout(function () {
        try {
          if (target.exitCode == null && !target.signalCode) {
            target.kill('SIGKILL');
          }
        } catch (ignore) {
          // The process already exited.
        }
        finish();
      }, positiveNumber(
        options.stopTimeoutMs || env.GMC_AGENT_MONITOR_STOP_TIMEOUT_MS,
        DEFAULT_STOP_TIMEOUT_MS
      ));
    });
  }

  function fail(reason, detail) {
    updateState({
      enabled: true,
      status: 'unavailable',
      healthy: false,
      available: false,
      owned: false,
      reason: reason || 'unavailable',
      detail: detail || null,
      pid: null
    });
    return state;
  }

  function classifyFailure() {
    var code = childError && childError.code;
    if (code === 'ENOENT') {
      return 'python_not_found';
    }
    if (/No module named|ModuleNotFoundError|ImportError/i.test(outputTail)) {
      return 'dependency_missing';
    }
    if (/address already in use|EADDRINUSE|Errno 48|Errno 98/i.test(outputTail)) {
      return 'port_conflict';
    }
    return 'process_exited';
  }

  function failureDetail(reason) {
    if (reason === 'python_not_found') {
      return 'Python executable was not found.';
    }
    if (reason === 'dependency_missing') {
      return 'Agent Monitor Python dependencies are missing.';
    }
    if (reason === 'port_conflict') {
      return 'Port ' + state.port + ' is already in use.';
    }
    return lastOutputLine() || 'Agent Monitor exited before becoming healthy.';
  }

  function captureOutput(stream) {
    if (!stream) return;
    stream.setEncoding('utf8');
    stream.on('data', function (chunk) {
      outputTail = (outputTail + chunk).slice(-OUTPUT_TAIL_BYTES);
      writeLog(chunk);
    });
  }

  function openLog(configuredPath) {
    var logPath = configuredPath || path.join(os.homedir(), '.config', 'gmc', 'agent-monitor.log');
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      logStream = fs.createWriteStream(logPath, { flags: 'a' });
      logStream.on('error', function () {
        logStream = null;
      });
      state.logPath = logPath;
    } catch (error) {
      logStream = null;
      state.logPath = null;
    }
  }

  function writeLog(value) {
    if (logStream) {
      logStream.write(value);
    }
  }

  function closeLog() {
    if (!logStream) return;
    logStream.end();
    logStream = null;
  }

  function installExitHandler() {
    if (exitHandlerInstalled) return;
    exitHandlerInstalled = true;
    process.once('exit', stopSync);
  }

  function removeExitHandler() {
    if (!exitHandlerInstalled) return;
    exitHandlerInstalled = false;
    process.removeListener('exit', stopSync);
  }

  function stopSync() {
    if (!state.owned || !child || child.exitCode != null || child.signalCode) return;
    try {
      child.kill('SIGTERM');
    } catch (ignore) {
      // Best effort during synchronous process exit.
    }
  }

  function updateState(values) {
    Object.keys(values).forEach(function (key) {
      state[key] = values[key];
    });
  }

  function lastOutputLine() {
    var lines = String(outputTail || '').trim().split(/\r?\n/);
    return lines[lines.length - 1] || '';
  }

  return {
    start: start,
    stop: stop,
    getState: function () {
      return state;
    }
  };
}

function probeHealth(port) {
  return new Promise(function (resolve) {
    var settled = false;
    var size = 0;
    var chunks = [];
    var req = http.request({
      hostname: '127.0.0.1',
      port: port,
      path: '/health',
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Connection': 'close'
      }
    }, function (res) {
      res.on('data', function (chunk) {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_HEALTH_BYTES) {
          settled = true;
          req.destroy();
          resolve({ compatible: false, reason: 'invalid_response' });
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', function () {
        if (settled) return;
        settled = true;
        var body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (error) {
          resolve({ compatible: false, reason: 'invalid_response' });
          return;
        }
        var legacyHealth = body && body.ok === true &&
          typeof body.hostname === 'string' && typeof body.ip === 'string';
        var identifiedHealth = body && body.service === 'agent-monitor' &&
          (body.ok === true || body.status === 'ok');
        resolve({
          compatible: res.statusCode >= 200 && res.statusCode < 300 &&
            (legacyHealth || identifiedHealth),
          reason: 'incompatible_service'
        });
      });
    });
    req.on('error', function () {
      if (settled) return;
      settled = true;
      resolve({ compatible: false, reason: 'unavailable' });
    });
    req.setTimeout(PROBE_TIMEOUT_MS, function () {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve({ compatible: false, reason: 'timeout' });
    });
    req.end();
  });
}

function portIsOccupied(port) {
  return new Promise(function (resolve) {
    var settled = false;
    var socket = net.connect({ host: '127.0.0.1', port: port });

    function finish(occupied) {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(occupied);
    }

    socket.once('connect', function () {
      finish(true);
    });
    socket.once('error', function (error) {
      finish(error && error.code !== 'ECONNREFUSED');
    });
    socket.setTimeout(PROBE_TIMEOUT_MS, function () {
      finish(true);
    });
  });
}

function resolveServerPath(options, env) {
  var configured = options.serverPath || env.GMC_AGENT_MONITOR_SERVER;
  var candidates = [
    configured,
    path.resolve(__dirname, '../agent-monitor/server.py'),
    path.resolve(__dirname, 'agent-monitor/server.py'),
    path.resolve(__dirname, '../../agent-monitor/server.py')
  ].filter(Boolean);

  for (var i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i])) {
      return path.resolve(candidates[i]);
    }
  }
  return null;
}

function resolvePythonPath(options, env, serviceDir) {
  if (options.pythonPath || env.GMC_AGENT_MONITOR_PYTHON) {
    return options.pythonPath || env.GMC_AGENT_MONITOR_PYTHON;
  }
  var candidates = process.platform === 'win32'
    ? [path.join(serviceDir, '.venv', 'Scripts', 'python.exe')]
    : [
      path.join(serviceDir, '.venv', 'bin', 'python3'),
      path.join(serviceDir, '.venv', 'bin', 'python')
    ];
  for (var i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i])) {
      return candidates[i];
    }
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

function resolvePort(value) {
  var port = Number(value || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return port;
}

function isDisabled(env) {
  return truthy(env.GMC_AGENT_MONITOR_DISABLED) ||
    truthy(env.GMC_AGENT_MONITOR_DISABLE) ||
    String(env.GMC_AGENT_MONITOR_ENABLED || '').toLowerCase() === 'false' ||
    env.GMC_AGENT_MONITOR_ENABLED === '0';
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ''));
}

function positiveNumber(value, fallback) {
  var number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function copyEnvironment(env) {
  var copied = {};
  Object.keys(env || {}).forEach(function (key) {
    copied[key] = env[key];
  });
  return copied;
}

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function describe(state) {
  if (!state) return 'unavailable';
  var message = state.reason || state.status || 'unavailable';
  if (state.detail) message += ': ' + state.detail;
  if (state.logPath) message += ' (log: ' + state.logPath + ')';
  return message;
}

module.exports = {
  createManager: createManager,
  describe: describe,
  probeHealth: probeHealth,
  DEFAULT_PORT: DEFAULT_PORT
};
