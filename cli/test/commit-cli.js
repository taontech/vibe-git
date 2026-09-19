'use strict';

var assert = require('assert');
var gmc = require('../bin/gmc');

function run() {
  console.log('Testing commit CLI flags...');

  var defaultCommit = gmc.parseArgs(['commit']);
  assert.strictEqual(defaultCommit.command, 'commit');
  assert.strictEqual(defaultCommit.flags.edit, false, 'edit flag should be false by default');
  assert.strictEqual(defaultCommit.flags.noEdit, false, 'noEdit flag should be false by default');

  var editCommit = gmc.parseArgs(['commit', '--edit']);
  assert.strictEqual(editCommit.flags.edit, true, '--edit should set edit flag to true');
  assert.strictEqual(editCommit.flags.noEdit, false);

  var shortEditCommit = gmc.parseArgs(['commit', '-e']);
  assert.strictEqual(shortEditCommit.flags.edit, true, '-e should set edit flag to true');

  var noEditCommit = gmc.parseArgs(['commit', '--no-edit']);
  assert.strictEqual(noEditCommit.flags.noEdit, true, '--no-edit should set noEdit to true');
  assert.strictEqual(noEditCommit.flags.edit, false);

  console.log('Commit CLI flag tests passed.');
}

run();
