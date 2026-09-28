'use strict';

var assert = require('assert');
var stream = require('stream');
var CommitHud = require('../lib/commit-hud');
var git = require('../lib/git');
var gmc = require('../bin/gmc');

function createMockStream(isTTY) {
  var chunks = [];
  var mock = new stream.Writable({
    write: function (chunk, encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    }
  });
  mock.isTTY = Boolean(isTTY);
  mock.columns = 80;
  mock.getOutput = function () {
    return chunks.join('');
  };
  mock.clear = function () {
    chunks = [];
  };
  return mock;
}

function run() {
  console.log('Testing commit HUD utility...');

  // 1. Instantiation
  var hud1 = new CommitHud({
    branch: 'feat/test',
    selectedAgent: 'codex'
  });
  assert.ok(hud1 instanceof CommitHud, 'new CommitHud should create instance');

  var hud2 = CommitHud({
    branch: 'feat/test',
    selectedAgent: 'codex'
  });
  assert.ok(hud2 instanceof CommitHud, 'CommitHud() without new should create instance');

  // 2. Non-TTY stream behavior
  var nonTtyStream = createMockStream(false);
  var nonTtyHud = new CommitHud({
    stream: nonTtyStream,
    branch: 'feat/non-tty',
    selectedAgent: 'claude',
    stagedSummary: {
      filesCount: 2,
      additions: 15,
      deletions: 3,
      files: [{ path: 'lib/app.js', additions: 15, deletions: 3 }]
    },
    binding: {
      issue: 'GMC-101',
      title: 'Fix edge cases'
    }
  });

  nonTtyHud.start();
  var startOutput = nonTtyStream.getOutput();
  assert.ok(startOutput.indexOf('GMC Commit: feat/non-tty using claude') !== -1, 'Non-TTY start should print banner');
  assert.ok(startOutput.indexOf('Staged: 2 files (+15 / -3)') !== -1, 'Non-TTY start should print staged count');

  nonTtyStream.clear();
  nonTtyHud.setStage(2);
  assert.ok(nonTtyStream.getOutput().indexOf('[2/4]') !== -1, 'Non-TTY setStage should log stage number');

  nonTtyStream.clear();
  nonTtyHud.succeed({
    message: 'feat(core): enhance non-tty output\n\n- Improved logging'
  });
  assert.ok(nonTtyStream.getOutput().indexOf('feat(core): enhance non-tty output') !== -1, 'Non-TTY succeed should write commit message');

  nonTtyStream.clear();
  nonTtyHud.committed('[main 1234abc] feat(core): enhance non-tty output');
  assert.ok(nonTtyStream.getOutput().indexOf('Commit successfully applied') !== -1, 'Non-TTY committed should print success notice');

  // 3. TTY stream behavior & dynamic rendering
  var ttyStream = createMockStream(true);
  var ttyHud = new CommitHud({
    stream: ttyStream,
    branch: 'main',
    selectedAgent: 'codex',
    model: 'o3-mini',
    stagedSummary: {
      filesCount: 1,
      additions: 5,
      deletions: 1,
      files: [{ path: 'lib/agent.js', additions: 5, deletions: 1 }]
    },
    binding: {
      issue: 'GMC-200',
      title: 'Add cyber HUD'
    },
    interval: 50
  });

  ttyHud.start();
  assert.strictEqual(ttyHud.stopped, false);
  assert.ok(ttyStream.getOutput().indexOf('\x1b[?25l') !== -1, 'TTY should hide cursor on start');

  // Update thinking activity
  ttyHud.setStage(3);
  ttyHud.updateAgentActivity({
    type: 'thinking',
    text: 'Examining staged AST for commit scope and format'
  });
  assert.ok(ttyHud.thinkingLines.length > 0, 'Should record thinking lines');
  assert.ok(ttyHud.thinkingLines[0].indexOf('Examining staged AST') !== -1);

  // Update usage tokens
  ttyHud.updateAgentActivity({
    type: 'usage',
    usage: { total_tokens: 1540 }
  });
  assert.strictEqual(ttyHud.tokenUsage.total_tokens, 1540);

  // Succeed
  ttyHud.succeed({
    message: 'feat(cli): add interactive cyber HUD\n\n- Stream agent thoughts'
  });
  assert.strictEqual(ttyHud.stopped, true);
  assert.ok(ttyStream.getOutput().indexOf('\x1b[?25h') !== -1, 'TTY should restore cursor on succeed');
  assert.ok(ttyStream.getOutput().indexOf('GENERATED COMMIT MESSAGE') !== -1, 'Output should render commit message card');

  // 4. Git stagedSummary test
  var staged = git.stagedSummary(process.cwd());
  assert.ok(typeof staged.filesCount === 'number', 'filesCount should be a number');
  assert.ok(typeof staged.additions === 'number', 'additions should be a number');
  assert.ok(typeof staged.deletions === 'number', 'deletions should be a number');
  assert.ok(Array.isArray(staged.files), 'files should be an array');

  // 5. Plain CLI flag test
  var plainParsed = gmc.parseArgs(['commit', '--plain']);
  assert.strictEqual(plainParsed.flags.plain, true, '--plain should set flags.plain to true');

  // 6. Test zero vertical cursor drift across multiple render cycles
  var multiFrameStream = createMockStream(true);
  var cursorY = 0;
  var originalWrite = multiFrameStream.write;
  multiFrameStream.write = function (chunk, encoding, callback) {
    var str = chunk.toString();
    var newlines = (str.match(/\n/g) || []).length;
    cursorY += newlines;
    var moveUpMatches = str.match(/\x1b\[(\d+)A/g);
    if (moveUpMatches) {
      moveUpMatches.forEach(function (m) {
        var count = parseInt(m.slice(2, -1), 10);
        cursorY -= count;
      });
    }
    return originalWrite.call(multiFrameStream, chunk, encoding, callback);
  };

  var driftHud = new CommitHud({
    stream: multiFrameStream,
    branch: 'main',
    selectedAgent: 'codex'
  });

  driftHud.render();
  var frame1Cursor = cursorY;
  driftHud.render();
  var frame2Cursor = cursorY;
  driftHud.render();
  var frame3Cursor = cursorY;

  assert.strictEqual(frame1Cursor, frame2Cursor, 'Cursor Y position must not drift between frames 1 and 2');
  assert.strictEqual(frame2Cursor, frame3Cursor, 'Cursor Y position must not drift between frames 2 and 3');

  driftHud.stop();
  assert.strictEqual(cursorY, 0, 'Stopping HUD must return cursor Y to origin 0');

  // 7. Thinking box borders must align with content rows
  var alignHud = new CommitHud({
    stream: createMockStream(true),
    branch: 'main',
    selectedAgent: 'codex',
    stagedSummary: {
      filesCount: 1,
      additions: 1,
      deletions: 0,
      files: [{ path: 'lib/app.js', additions: 1, deletions: 0 }]
    }
  });
  alignHud.setStage(3);
  alignHud.updateAgentActivity({ type: 'thinking', text: 'Inspecting diff topology for semantic changes' });

  var thinkingBox = alignHud.buildThinkingBox(74).map(function (line) {
    return line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  });
  thinkingBox.forEach(function (line) {
    assert.strictEqual(line.length, thinkingBox[0].length, 'Thinking box lines must share the same width: ' + JSON.stringify(thinkingBox));
  });

  console.log('Commit HUD utility tests passed.');
}

run();
