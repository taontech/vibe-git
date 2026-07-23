#!/usr/bin/env node
/**
 * Post-install setup for Agent Monitor Python service.
 *
 * Creates a virtual environment and installs dependencies so the service
 * is ready to run on first start without interactive setup.
 *
 * This is a best-effort script — failures are logged but never block
 * npm install. Systems without Python, or where the venv tool is
 * unavailable, simply skip the Agent Monitor (it will fall back to
 * lazy setup on first `start.sh` run).
 */

'use strict';

var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');

function resolveServiceDir() {
  // When running as npm postinstall inside the published package,
  // package.json's location is the package root (cli/ in dev,
  // node_modules/gmc/ when installed).
  var candidates = [
    path.resolve(__dirname, '../agent-monitor'),
    path.resolve(__dirname, '../../agent-monitor'),
  ];
  for (var i = 0; i < candidates.length; i++) {
    if (fs.existsSync(path.join(candidates[i], 'requirements.txt'))) {
      return candidates[i];
    }
  }
  return null;
}

function log(message) {
  try {
    fs.appendFileSync(
      path.join(osHomeDir(), '.config', 'gmc', 'agent-monitor-setup.log'),
      new Date().toISOString() + ' ' + message + '\n'
    );
  } catch (_) {
    // Best effort logging — ignore failures
  }
}

function osHomeDir() {
  return process.env.HOME ||
    process.env.USERPROFILE ||
    process.env.HOMEPATH ||
    '/tmp';
}

function run(cmd, args, opts) {
  return new Promise(function (resolve, reject) {
    var child = childProcess.spawn(cmd, args, opts);
    var stderr = '';
    child.stderr && child.stderr.setEncoding('utf8');
    child.stderr && child.stderr.on('data', function (c) { stderr += c; });
    child.on('close', function (code) {
      if (code === 0) resolve();
      else reject(new Error('exit code ' + code + ': ' + stderr.slice(-300)));
    });
    child.on('error', reject);
  });
}

function main() {
  var serviceDir = resolveServiceDir();
  if (!serviceDir) {
    // No service to set up — silently skip
    return Promise.resolve();
  }

  var venvDir = path.join(serviceDir, '.venv');
  var venvPython = path.join(venvDir, 'bin', 'python3');
  var venvPip = path.join(venvDir, 'bin', 'pip');

  if (fs.existsSync(venvPython)) {
    log('venv already exists at ' + venvDir);
    return Promise.resolve();
  }

  log('creating venv at ' + venvDir);
  return run('python3', ['-m', 'venv', venvDir], { stdio: 'ignore' })
    .then(function () {
      log('installing requirements');
      return run(venvPip, ['install', '-q', '-r',
        path.join(serviceDir, 'requirements.txt')], {
        stdio: 'ignore',
        cwd: serviceDir
      });
    })
    .then(function () {
      log('setup complete');
    })
    .catch(function (err) {
      log('setup skipped: ' + (err && err.message));
      // Best effort — do not fail npm install
    });
}

main().then(function () {
  process.exit(0);
}).catch(function () {
  process.exit(0);  // Always exit cleanly — setup is optional
});
