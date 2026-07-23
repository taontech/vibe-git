'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var http = require('http');
var net = require('net');
var os = require('os');
var path = require('path');
var agentMonitor = require('../lib/agent-monitor');

async function main() {
  var tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmc-agent-monitor-test-'));
  var fakeServerPath = path.join(tempDir, 'server.js');
  var missingDependencyPath = path.join(tempDir, 'missing-dependency.js');
  var external = null;
  var conflictServer = null;

  fs.writeFileSync(fakeServerPath, fakeServerSource());
  fs.writeFileSync(
    missingDependencyPath,
    "console.error(\"ModuleNotFoundError: No module named 'fastapi'\");\nprocess.exit(1);\n"
  );

  try {
    console.log('Testing disabled Agent Monitor mode...');
    await testDisabled();
    console.log('Testing missing Python degradation...');
    await testMissingPython(tempDir, fakeServerPath);
    console.log('Testing missing Python dependency degradation...');
    await testMissingDependency(tempDir, missingDependencyPath);
    console.log('Testing GMC-owned Agent Monitor lifecycle...');
    await testOwnedLifecycle(tempDir, fakeServerPath);
    console.log('Testing compatible Agent Monitor reuse...');
    external = await testReuse(tempDir, fakeServerPath);
    await stopProcess(external);
    external = null;
    console.log('Testing incompatible Agent Monitor port handling...');
    conflictServer = await testPortConflict(tempDir, fakeServerPath);
    await closeServer(conflictServer);
    conflictServer = null;
    console.log('Testing foreground GMC Web quit cleanup...');
    await testForegroundWebCleanup(tempDir, fakeServerPath, false);
    console.log('Testing foreground GMC Web signal cleanup...');
    await testForegroundWebCleanup(tempDir, fakeServerPath, true);
    console.log('Testing background GMC Web restart and quit cleanup...');
    await testBackgroundWebLifecycle(tempDir, fakeServerPath);
    console.log('Agent Monitor lifecycle tests passed.');
  } finally {
    if (external) await stopProcess(external);
    if (conflictServer) await closeServer(conflictServer);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testDisabled() {
  var manager = agentMonitor.createManager({
    env: {
      GMC_AGENT_MONITOR_DISABLED: '1'
    }
  });
  var state = await manager.start();
  assert.strictEqual(state.status, 'disabled');
  assert.strictEqual(state.enabled, false);
  assert.strictEqual(state.owned, false);
}

async function testMissingPython(tempDir, fakeServerPath) {
  var port = await freePort();
  var manager = agentMonitor.createManager({
    env: {},
    port: port,
    serverPath: fakeServerPath,
    pythonPath: path.join(tempDir, 'missing-python'),
    startTimeoutMs: 1000,
    logPath: path.join(tempDir, 'missing-python.log')
  });
  var state = await manager.start();
  assert.strictEqual(state.status, 'unavailable');
  assert.strictEqual(state.reason, 'python_not_found');
  assert.strictEqual(state.owned, false);
}

async function testMissingDependency(tempDir, missingDependencyPath) {
  var port = await freePort();
  var manager = agentMonitor.createManager({
    env: {},
    port: port,
    serverPath: missingDependencyPath,
    pythonPath: process.execPath,
    startTimeoutMs: 1000,
    logPath: path.join(tempDir, 'missing-dependency.log')
  });
  var state = await manager.start();
  assert.strictEqual(state.status, 'unavailable');
  assert.strictEqual(state.reason, 'dependency_missing');
  assert.strictEqual(state.owned, false);
}

async function testOwnedLifecycle(tempDir, fakeServerPath) {
  var port = await freePort();
  var manager = agentMonitor.createManager({
    env: {},
    port: port,
    serverPath: fakeServerPath,
    pythonPath: process.execPath,
    startTimeoutMs: 3000,
    stopTimeoutMs: 1000,
    logPath: path.join(tempDir, 'owned.log')
  });
  var state = await manager.start();
  assert.strictEqual(state.status, 'running');
  assert.strictEqual(state.healthy, true);
  assert.strictEqual(state.owned, true);
  assert.ok(state.pid);
  assert.strictEqual((await agentMonitor.probeHealth(port)).compatible, true);

  await manager.stop();
  await waitForUnhealthy(port);
  assert.strictEqual((await agentMonitor.probeHealth(port)).compatible, false);
}

async function testReuse(tempDir, fakeServerPath) {
  var port = await freePort();
  var external = childProcess.spawn(process.execPath, [
    fakeServerPath,
    '--host', '127.0.0.1',
    '--port', String(port)
  ], {
    stdio: 'ignore'
  });
  await waitForHealthy(port);

  var manager = agentMonitor.createManager({
    env: {},
    port: port,
    serverPath: fakeServerPath,
    pythonPath: process.execPath,
    startTimeoutMs: 3000,
    logPath: path.join(tempDir, 'reuse.log')
  });
  var state = await manager.start();
  assert.strictEqual(state.status, 'reused');
  assert.strictEqual(state.owned, false);

  await manager.stop();
  assert.strictEqual(external.exitCode, null);
  assert.strictEqual((await agentMonitor.probeHealth(port)).compatible, true);
  return external;
}

async function testPortConflict(tempDir, fakeServerPath) {
  var port = await freePort();
  var server = http.createServer(function (req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'other-service' }));
  });
  await listen(server, port);

  var manager = agentMonitor.createManager({
    env: {},
    port: port,
    serverPath: fakeServerPath,
    pythonPath: process.execPath,
    startTimeoutMs: 1000,
    logPath: path.join(tempDir, 'conflict.log')
  });
  var state = await manager.start();
  assert.strictEqual(state.status, 'unavailable');
  assert.strictEqual(state.reason, 'port_conflict');
  assert.strictEqual(state.owned, false);
  return server;
}

async function testForegroundWebCleanup(tempDir, fakeServerPath, useSignal) {
  var webPort = await freePort();
  var monitorPort = await freePort();
  var testName = useSignal ? 'signal' : 'quit';
  var testDir = path.join(tempDir, testName);
  var env = webEnvironment(testDir, fakeServerPath, monitorPort);
  var child = spawnGmc(['web', '--port', String(webPort), '--no-open'], env);

  try {
    await waitForWeb(webPort, testDir, child);
    await waitForHealthy(monitorPort);
    await assertPausedAgentMonitor(webPort, testDir);
    await assertAgentMonitorWebSocket(webPort, testDir);
    if (useSignal) {
      child.kill('SIGTERM');
    } else {
      await quitWeb(webPort, testDir);
    }
    var result = await waitForChild(child, 5000);
    assert.strictEqual(result.code, 0, result.output);
    await waitForPortClosed(webPort);
    await waitForUnhealthy(monitorPort);
  } finally {
    if (child.exitCode == null && !child.signalCode) {
      child.kill('SIGKILL');
      await waitForChild(child, 2000);
    }
  }
}

async function testBackgroundWebLifecycle(tempDir, fakeServerPath) {
  var webPort = await freePort();
  var monitorPort = await freePort();
  var testDir = path.join(tempDir, 'background');
  var env = webEnvironment(testDir, fakeServerPath, monitorPort);
  var firstPid;
  var secondPid;

  try {
    await runGmc(['web', '--start', '--port', String(webPort)], env);
    await waitForWeb(webPort, testDir);
    await waitForHealthy(monitorPort);
    await assertPausedAgentMonitor(webPort, testDir);
    firstPid = await waitForMonitorPid(testDir, 1);
    assert.strictEqual(processIsAlive(firstPid), true);

    await runGmc(['web', '--restart', '--port', String(webPort)], env);
    await waitForWeb(webPort, testDir);
    await waitForHealthy(monitorPort);
    await assertPausedAgentMonitor(webPort, testDir);
    secondPid = await waitForMonitorPid(testDir, 2);
    assert.notStrictEqual(secondPid, firstPid);
    await waitForProcessExit(firstPid);
    assert.strictEqual(processIsAlive(secondPid), true);

    await runGmc(['web', '--quit', '--port', String(webPort)], env);
    await waitForPortClosed(webPort);
    await waitForUnhealthy(monitorPort);
    await waitForProcessExit(secondPid);
  } finally {
    if (await portIsOpen(webPort)) {
      try {
        await runGmc(['web', '--quit', '--port', String(webPort)], env);
      } catch (ignore) {
        // The assertions above report the primary failure.
      }
    }
    [firstPid, secondPid].filter(Boolean).forEach(function (pid) {
      if (processIsAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (ignore) {
          // The process already exited.
        }
      }
    });
  }
}

function fakeServerSource() {
  return [
    "'use strict';",
    "var crypto = require('crypto');",
    "var fs = require('fs');",
    "var http = require('http');",
    "var args = process.argv.slice(2);",
    "var port = Number(args[args.indexOf('--port') + 1]);",
    "if (process.env.FAKE_MONITOR_PID_FILE) {",
    "  fs.appendFileSync(process.env.FAKE_MONITOR_PID_FILE, String(process.pid) + '\\n');",
    "}",
    "var server = http.createServer(function (req, res) {",
    "  if (req.url === '/health') {",
    "    res.writeHead(200, { 'Content-Type': 'application/json' });",
    "    res.end(JSON.stringify({ ok: true, hostname: 'test-host', ip: '127.0.0.1' }));",
    "    return;",
    "  }",
    "  if (req.url === '/agents') {",
    "    res.writeHead(200, { 'Content-Type': 'application/json' });",
    "    res.end(JSON.stringify([{",
    "      agent_id: 'codex-cli',",
    "      display_name: 'Codex CLI',",
    "      status: 'paused',",
    "      process_count: 1,",
    "      total_cpu_percent: 0.5,",
    "      total_memory_mb: 42,",
    "      max_uptime_seconds: 120",
    "    }]));",
    "    return;",
    "  }",
    "  res.writeHead(404);",
    "  res.end();",
    "});",
    "server.on('upgrade', function (req, socket) {",
    "  if (req.url !== '/ws/status') { socket.destroy(); return; }",
    "  var key = req.headers['sec-websocket-key'] || '';",
    "  var accept = crypto.createHash('sha1')",
    "    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')",
    "    .digest('base64');",
    "  var payload = Buffer.from(JSON.stringify({ version: 1, agents: [{",
    "    agent_id: 'codex-cli',",
    "    display_name: 'Codex CLI',",
    "    status: 'paused',",
    "    process_count: 1,",
    "    total_cpu_percent: 0.5,",
    "    total_memory_mb: 42,",
    "    max_uptime_seconds: 120",
    "  }] }));",
    "  var header = Buffer.alloc(payload.length < 126 ? 2 : 4);",
    "  header[0] = 0x81;",
    "  if (payload.length < 126) {",
    "    header[1] = payload.length;",
    "  } else {",
    "    header[1] = 126;",
    "    header.writeUInt16BE(payload.length, 2);",
    "  }",
    "  socket.write('HTTP/1.1 101 Switching Protocols\\r\\n' +",
    "    'Upgrade: websocket\\r\\nConnection: Upgrade\\r\\n' +",
    "    'Sec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');",
    "  socket.write(Buffer.concat([header, payload]));",
    "});",
    "server.listen(port, '127.0.0.1');",
    "function stop() { server.close(function () { process.exit(0); }); }",
    "process.on('SIGTERM', stop);",
    "process.on('SIGINT', stop);"
  ].join('\n') + '\n';
}

function freePort() {
  return new Promise(function (resolve, reject) {
    var server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', function () {
      var port = server.address().port;
      server.close(function () {
        resolve(port);
      });
    });
  });
}

function listen(server, port) {
  return new Promise(function (resolve, reject) {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

function closeServer(server) {
  return new Promise(function (resolve) {
    server.close(resolve);
  });
}

function stopProcess(child) {
  return new Promise(function (resolve) {
    if (!child || child.exitCode != null || child.signalCode) {
      resolve();
      return;
    }
    child.once('close', resolve);
    child.kill('SIGTERM');
  });
}

function webEnvironment(testDir, fakeServerPath, monitorPort) {
  var homeDir = path.join(testDir, 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  return Object.assign({}, process.env, {
    HOME: homeDir,
    USERPROFILE: homeDir,
    GMC_AGENT_MONITOR_PORT: String(monitorPort),
    GMC_AGENT_MONITOR_PYTHON: process.execPath,
    GMC_AGENT_MONITOR_SERVER: fakeServerPath,
    GMC_AGENT_MONITOR_START_TIMEOUT_MS: '3000',
    GMC_AGENT_MONITOR_STOP_TIMEOUT_MS: '1000',
    GMC_AGENT_MONITOR_LOG: path.join(testDir, 'agent-monitor.log'),
    FAKE_MONITOR_PID_FILE: path.join(testDir, 'monitor-pids')
  });
}

function spawnGmc(args, env) {
  var child = childProcess.spawn(process.execPath, [
    path.resolve(__dirname, '../bin/gmc.js')
  ].concat(args), {
    cwd: path.resolve(__dirname, '../..'),
    env: env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', function (chunk) { child.output += chunk; });
  child.stderr.on('data', function (chunk) { child.output += chunk; });
  return child;
}

function runGmc(args, env) {
  return new Promise(function (resolve, reject) {
    var child = spawnGmc(args, env);
    var timer = setTimeout(function () {
      child.kill('SIGKILL');
      reject(new Error('gmc ' + args.join(' ') + ' timed out.\n' + child.output));
    }, 8000);
    child.on('close', function (code, signal) {
      clearTimeout(timer);
      if (code === 0) {
        resolve(child.output);
      } else {
        reject(new Error(
          'gmc ' + args.join(' ') + ' exited ' +
          (signal || code) + '.\n' + child.output
        ));
      }
    });
  });
}

function waitForChild(child, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var timer;
    function finish(code, signal) {
      clearTimeout(timer);
      resolve({ code: code, signal: signal, output: child.output });
    }
    if (child.exitCode != null || child.signalCode) {
      resolve({
        code: child.exitCode,
        signal: child.signalCode,
        output: child.output
      });
      return;
    }
    child.once('close', finish);
    timer = setTimeout(function () {
      child.removeListener('close', finish);
      reject(new Error('Timed out waiting for gmc Web to exit.\n' + child.output));
    }, timeoutMs);
  });
}

async function waitForWeb(port, testDir, child) {
  var deadline = Date.now() + 5000;
  var tokenPath = path.join(testDir, 'home', '.config', 'gmc', 'gitweb-token');
  while (Date.now() < deadline) {
    if (child && (child.exitCode != null || child.signalCode)) {
      throw new Error('gmc Web exited before becoming ready.\n' + child.output);
    }
    if (fs.existsSync(tokenPath)) {
      var token = fs.readFileSync(tokenPath, 'utf8').trim();
      var response = await request(port, 'GET', '/api/ping', token);
      if (response.statusCode === 200) return;
    }
    await delay(50);
  }
  throw new Error('Timed out waiting for gmc Web on port ' + port);
}

async function quitWeb(port, testDir) {
  var tokenPath = path.join(testDir, 'home', '.config', 'gmc', 'gitweb-token');
  var token = fs.readFileSync(tokenPath, 'utf8').trim();
  var response = await request(port, 'POST', '/api/quit', token);
  assert.strictEqual(response.statusCode, 200, response.body);
}

async function assertPausedAgentMonitor(port, testDir) {
  var tokenPath = path.join(testDir, 'home', '.config', 'gmc', 'gitweb-token');
  var token = fs.readFileSync(tokenPath, 'utf8').trim();
  var response = await request(port, 'GET', '/api/agent-monitor', token);
  assert.strictEqual(response.statusCode, 200, response.body);
  var body = JSON.parse(response.body);
  assert.strictEqual(body.available, true, response.body);
  assert.strictEqual(body.agents.length, 1, response.body);
  assert.strictEqual(body.agents[0].status, 'paused', response.body);
}

async function assertAgentMonitorWebSocket(port, testDir) {
  var tokenPath = path.join(testDir, 'home', '.config', 'gmc', 'gitweb-token');
  var token = fs.readFileSync(tokenPath, 'utf8').trim();
  var response = await requestWebSocket(port, token);
  assert.ok(response.indexOf('HTTP/1.1 101 Switching Protocols') >= 0, response);
  assert.ok(response.indexOf('"status":"paused"') >= 0, response);
}

function requestWebSocket(port, token) {
  return new Promise(function (resolve) {
    var settled = false;
    var chunks = [];
    var timer;
    var socket = net.connect(port, '127.0.0.1', function () {
      socket.write([
        'GET /api/agent-monitor/ws HTTP/1.1',
        'Host: 127.0.0.1:' + port,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: Z21jLWFnZW50LW1vbml0b3I=',
        'Sec-WebSocket-Version: 13',
        'X-GMC-Auth: ' + token,
        '',
        ''
      ].join('\r\n'));
    });
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      var response = Buffer.concat(chunks).toString('utf8');
      socket.destroy();
      resolve(response);
    }
    socket.on('data', function (chunk) {
      chunks.push(chunk);
      var response = Buffer.concat(chunks).toString('utf8');
      if (response.indexOf('"status":"paused"') >= 0) finish();
    });
    socket.on('error', finish);
    socket.on('close', finish);
    timer = setTimeout(finish, 1500);
  });
}

function request(port, method, requestPath, token) {
  return new Promise(function (resolve) {
    var settled = false;
    var req = http.request({
      hostname: '127.0.0.1',
      port: port,
      path: requestPath,
      method: method,
      headers: {
        'X-GMC-Auth': token,
        'Connection': 'close'
      }
    }, function (res) {
      var body = '';
      res.setEncoding('utf8');
      res.on('data', function (chunk) { body += chunk; });
      res.on('end', function () {
        if (settled) return;
        settled = true;
        resolve({ statusCode: res.statusCode, body: body });
      });
    });
    req.on('error', function () {
      if (settled) return;
      settled = true;
      resolve({ statusCode: 0, body: '' });
    });
    req.setTimeout(500, function () {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve({ statusCode: 0, body: '' });
    });
    req.end();
  });
}

async function waitForPortClosed(port) {
  var deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!(await portIsOpen(port))) return;
    await delay(50);
  }
  throw new Error('Timed out waiting for port ' + port + ' to close');
}

function portIsOpen(port) {
  return new Promise(function (resolve) {
    var socket = net.connect({ host: '127.0.0.1', port: port });
    var settled = false;
    function finish(open) {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    }
    socket.once('connect', function () { finish(true); });
    socket.once('error', function () { finish(false); });
    socket.setTimeout(300, function () { finish(false); });
  });
}

async function waitForMonitorPid(testDir, count) {
  var pidPath = path.join(testDir, 'monitor-pids');
  var deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (fs.existsSync(pidPath)) {
      var pids = fs.readFileSync(pidPath, 'utf8').trim().split(/\r?\n/)
        .filter(Boolean).map(Number);
      if (pids.length >= count) return pids[count - 1];
    }
    await delay(50);
  }
  throw new Error('Timed out waiting for Agent Monitor process ' + count);
}

async function waitForProcessExit(pid) {
  var deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    await delay(50);
  }
  throw new Error('Process ' + pid + ' did not exit');
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function waitForHealthy(port) {
  var deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if ((await agentMonitor.probeHealth(port)).compatible) return;
    await delay(50);
  }
  throw new Error('Timed out waiting for fake Agent Monitor on port ' + port);
}

async function waitForUnhealthy(port) {
  var deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!(await agentMonitor.probeHealth(port)).compatible) return;
    await delay(50);
  }
  throw new Error('Timed out waiting for fake Agent Monitor to stop on port ' + port);
}

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

var testTimeout = setTimeout(function () {
  console.error('Agent Monitor lifecycle tests timed out.');
  process.exit(1);
}, 30000);

main().then(function () {
  clearTimeout(testTimeout);
}).catch(function (error) {
  clearTimeout(testTimeout);
  console.error(error.stack || error.message);
  process.exit(1);
});
