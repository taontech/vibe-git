'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gmc-foreground-task-'));
var repoRoot = path.join(testRoot, 'repo');
fs.mkdirSync(repoRoot, { recursive: true });

var autogmc = require('../lib/autogmc');

async function run() {
  try {
    childProcess.execFileSync('git', ['init', repoRoot], { stdio: 'ignore' });
    childProcess.execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot, stdio: 'ignore' });
    childProcess.execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoRoot, stdio: 'ignore' });
    fs.writeFileSync(path.join(repoRoot, 'README.md'), 'hello');
    childProcess.execFileSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
    childProcess.execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoRoot, stdio: 'ignore' });

    var oid = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    assert.ok(oid, 'expected a commit oid');

    autogmc.recordForegroundCommit(repoRoot, {
      targetOid: oid,
      startedAt: '2026-09-30T01:00:00.000Z',
      completedAt: '2026-09-30T01:00:05.000Z',
      message: 'feat: foreground commit\n\nbody line',
      agent: 'opencode'
    });

    var taskFile = path.join(repoRoot, '.git', 'gmc', 'tasks', oid + '.json');
    assert.ok(fs.existsSync(taskFile), 'task json should exist');
    var task = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
    assert.strictEqual(task.status, 'done');
    assert.strictEqual(task.targetOid, oid);
    assert.strictEqual(task.newOid, oid);
    assert.strictEqual(task.message, 'feat: foreground commit\n\nbody line');
    assert.strictEqual(task.createdAt, '2026-09-30T01:00:00.000Z');
    assert.strictEqual(task.completedAt, '2026-09-30T01:00:05.000Z');

    var logFile = path.join(repoRoot, '.git', task.logPath);
    assert.ok(fs.existsSync(logFile), 'task log should exist');
    var logText = fs.readFileSync(logFile, 'utf8');
    assert.ok(logText.indexOf('opencode') >= 0, 'log should mention the agent');

    var summaries = autogmc.taskSummaries(repoRoot, 5);
    assert.strictEqual(summaries.length, 1);
    assert.strictEqual(summaries[0].targetOid, oid);
    assert.strictEqual(summaries[0].status, 'done');
    assert.strictEqual(summaries[0].message, 'feat: foreground commit\n\nbody line');
    assert.ok(summaries[0].logPath.indexOf(oid + '.log') >= 0, 'summary should expose the log path');

    autogmc.recordForegroundCommit(repoRoot, { message: 'missing oid' });
    assert.strictEqual(autogmc.taskSummaries(repoRoot, 5).length, 1, 'missing oid must be ignored');

    console.log('Foreground commit task recording tests passed.');
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

run().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
