'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');

function getCandidateDirs() {
  var home = os.homedir();
  var candidates = [];

  if (home) {
    candidates.push(path.join(home, '.local', 'bin'));
    candidates.push(path.join(home, '.cargo', 'bin'));
    candidates.push(path.join(home, '.gemini', 'antigravity-cli', 'bin'));
    candidates.push(path.join(home, '.antigravity', 'antigravity', 'bin'));
    candidates.push(path.join(home, '.lmstudio', 'bin'));
  }

  if (process.platform === 'darwin' || process.platform === 'linux') {
    candidates.push('/opt/homebrew/bin');
    candidates.push('/opt/homebrew/sbin');
    candidates.push('/usr/local/bin');
    candidates.push('/usr/local/sbin');
    candidates.push('/usr/bin');
    candidates.push('/bin');
    candidates.push('/usr/sbin');
    candidates.push('/sbin');
  }

  return candidates;
}

function ensurePath(targetEnv) {
  var envObj = targetEnv || process.env;
  var currentPath = envObj.PATH || '';
  var delimiter = path.delimiter;
  var parts = currentPath ? currentPath.split(delimiter).filter(Boolean) : [];
  var normalizedParts = parts.map(function (p) {
    return path.resolve(p);
  });

  var candidates = getCandidateDirs();
  var toPrepend = [];

  for (var i = 0; i < candidates.length; i++) {
    var dir = candidates[i];
    try {
      if (fs.existsSync(dir)) {
        var resolved = path.resolve(dir);
        if (normalizedParts.indexOf(resolved) === -1 && toPrepend.indexOf(resolved) === -1) {
          toPrepend.push(resolved);
        }
      }
    } catch (e) {
      // Ignore filesystem access errors
    }
  }

  if (toPrepend.length > 0) {
    envObj.PATH = toPrepend.concat(parts).join(delimiter);
  }
  return envObj.PATH;
}

function isExecutable(filePath) {
  try {
    var stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return false;
    }
    if (process.platform === 'win32') {
      return true;
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (e) {
    return false;
  }
}

function resolveCommand(command, customPath) {
  if (!command || typeof command !== 'string') {
    return command;
  }

  if (command.indexOf(path.sep) !== -1 || (path.delimiter === ';' && command.indexOf('/') !== -1)) {
    return isExecutable(command) ? path.resolve(command) : command;
  }

  ensurePath();

  var searchPath = customPath || process.env.PATH || '';
  var parts = searchPath.split(path.delimiter).filter(Boolean);
  var extensions = [''];
  if (process.platform === 'win32') {
    var pathext = process.env.PATHEXT ? process.env.PATHEXT.split(';') : ['.EXE', '.CMD', '.BAT', '.COM'];
    for (var e = 0; e < pathext.length; e++) {
      var ext = pathext[e].trim();
      if (ext && extensions.indexOf(ext) === -1) {
        extensions.push(ext);
        extensions.push(ext.toLowerCase());
      }
    }
  }

  for (var i = 0; i < parts.length; i++) {
    var dir = parts[i];
    for (var j = 0; j < extensions.length; j++) {
      var candidate = path.join(dir, command + extensions[j]);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  var fallbackCandidates = getCandidateDirs();
  for (var k = 0; k < fallbackCandidates.length; k++) {
    var fdir = fallbackCandidates[k];
    for (var l = 0; l < extensions.length; l++) {
      var fcandidate = path.join(fdir, command + extensions[l]);
      if (isExecutable(fcandidate)) {
        return fcandidate;
      }
    }
  }

  return command;
}

// Ensure PATH upon module load
ensurePath();

module.exports = {
  ensurePath: ensurePath,
  resolveCommand: resolveCommand,
  getCandidateDirs: getCandidateDirs,
  isExecutable: isExecutable
};
