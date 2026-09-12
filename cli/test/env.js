'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var env = require('../lib/env');

function run() {
  console.log('Testing env utility...');

  // 1. getCandidateDirs
  var candidates = env.getCandidateDirs();
  assert.ok(Array.isArray(candidates), 'getCandidateDirs should return an array');
  assert.ok(candidates.length > 0, 'getCandidateDirs should return at least one path');
  candidates.forEach(function (c) {
    assert.strictEqual(typeof c, 'string');
  });

  // 2. ensurePath on custom environment object
  var testEnv = { PATH: '/usr/bin' + path.delimiter + '/bin' };
  var updatedPath = env.ensurePath(testEnv);
  assert.strictEqual(testEnv.PATH, updatedPath);

  // Existing directories in candidates should be present in updatedPath
  var parts = testEnv.PATH.split(path.delimiter).map(function (p) {
    return path.resolve(p);
  });
  assert.ok(parts.indexOf(path.resolve('/usr/bin')) !== -1);
  assert.ok(parts.indexOf(path.resolve('/bin')) !== -1);

  candidates.forEach(function (cand) {
    if (fs.existsSync(cand)) {
      assert.ok(
        parts.indexOf(path.resolve(cand)) !== -1,
        'Existing candidate dir ' + cand + ' should be added to PATH'
      );
    }
  });

  // Calling ensurePath again should not duplicate directories
  var secondParts = env.ensurePath(testEnv).split(path.delimiter);
  assert.strictEqual(secondParts.length, parts.length, 'ensurePath should be idempotent');

  // 3. resolveCommand
  // Testing with an executable in a temporary directory
  var tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmc-env-test-'));
  var mockBin = path.join(tempDir, 'mock-agent-bin');
  fs.writeFileSync(mockBin, '#!/bin/sh\necho ok\n');
  fs.chmodSync(mockBin, 0o755);

  try {
    // Resolve via explicit search PATH
    var resolvedFromSearch = env.resolveCommand('mock-agent-bin', tempDir);
    assert.strictEqual(path.resolve(resolvedFromSearch), path.resolve(mockBin));

    // Resolve when given full relative/absolute path
    var resolvedFromPath = env.resolveCommand(mockBin);
    assert.strictEqual(path.resolve(resolvedFromPath), path.resolve(mockBin));

    // Resolve nonexistent command
    var nonExistent = env.resolveCommand('definitely-nonexistent-command-xyz-12345');
    assert.strictEqual(nonExistent, 'definitely-nonexistent-command-xyz-12345');

    // System command resolution (e.g., node or git)
    var resolvedGit = env.resolveCommand('git');
    assert.ok(fs.existsSync(resolvedGit), 'git should be resolved to an existing path');
  } finally {
    try {
      fs.unlinkSync(mockBin);
      fs.rmdirSync(tempDir);
    } catch (e) {}
  }

  console.log('Env utility tests passed.');
}

run();
