'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');
var vm = require('vm');

var originalHomedir = os.homedir;
var testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gmc-task-content-'));
var fakeHome = path.join(testRoot, 'home');
var repoRoot = path.join(testRoot, 'repo');
fs.mkdirSync(fakeHome, { recursive: true });
fs.mkdirSync(repoRoot, { recursive: true });
os.homedir = function () { return fakeHome; };

var taskStatus = require('../lib/task-status');
var web = require('../lib/web');

function request(info, pathname, options) {
  var serviceUrl = new URL(info.url);
  var target = new URL(pathname, info.url);
  var headers = Object.assign({}, options && options.headers);
  headers['X-GMC-Auth'] = serviceUrl.searchParams.get('gmc_auth');
  return fetch(target, Object.assign({}, options, { headers: headers }));
}

async function run() {
  var info;
  try {
    childProcess.execFileSync('git', ['init', repoRoot], { stdio: 'ignore' });

    var decomposition = taskStatus.parseTaskDecomposition(JSON.stringify({
      tasks: [
        { content: 'Implement the UI.' },
        { content: 'Verify the behavior.' }
      ]
    }));
    assert.deepStrictEqual(decomposition, [
      { content: 'Implement the UI.' },
      { content: 'Verify the behavior.' }
    ]);
    assert.deepStrictEqual(taskStatus.taskForPrompt({
      id: 'GMC-0001',
      title: 'Legacy title',
      status: 'todo',
      content: 'Task content'
    }), {
      id: 'GMC-0001',
      status: 'todo',
      content: 'Task content'
    });

    info = await web.start(repoRoot, { noOpen: true, port: 45120 });

    var htmlResponse = await request(info, '/?repo=' + encodeURIComponent(repoRoot));
    var html = await htmlResponse.text();
    var inlineScriptPattern = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g;
    var match;
    var scriptIndex = 0;
    while ((match = inlineScriptPattern.exec(html))) {
      scriptIndex += 1;
      if (match[1].trim()) new vm.Script(match[1], { filename: 'inline-script-' + scriptIndex + '.js' });
    }
    assert.strictEqual(html.indexOf('taskTitleInput'), -1);
    assert.ok(html.indexOf('taskSpeechButton') >= 0);
    assert.ok(html.indexOf('recognition.continuous = true') >= 0);
    assert.ok(html.indexOf('recognition.interimResults = true') >= 0);
    assert.strictEqual(html.indexOf("event.key !== 'F8'"), -1);
    assert.strictEqual(html.indexOf('isTaskSpeechShortcut'), -1);
    assert.strictEqual(html.indexOf('Alt+S'), -1);
    assert.ok(html.indexOf('<kbd>Ctrl</kbd>') >= 0);
    assert.ok(html.indexOf('TASK_SPEECH_CTRL_HOLD_MS = 400') >= 0);
    assert.ok(html.indexOf("event.key === 'Control'") >= 0);
    assert.ok(html.indexOf('taskSpeech.shortcutTimer = window.setTimeout') >= 0);

    var createResponse = await request(info, '/api/tasks/create?repo=' + encodeURIComponent(repoRoot), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Create a content-only task.', title: 'Ignored title' })
    });
    assert.strictEqual(createResponse.status, 200);
    var created = await createResponse.json();
    assert.strictEqual(created.task.content, 'Create a content-only task.');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(created.task, 'title'), false);

    var newTaskPath = path.join(repoRoot, '.gmc', 'tasks', created.task.id + '.md');
    var newTaskMarkdown = fs.readFileSync(newTaskPath, 'utf8');
    assert.strictEqual(/^title:/m.test(newTaskMarkdown), false);

    var statusResponse = await request(info, '/api/tasks/update?repo=' + encodeURIComponent(repoRoot), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: created.task.id, status: 'done', title: 'Still ignored' })
    });
    assert.strictEqual(statusResponse.status, 200);
    var statusUpdate = await statusResponse.json();
    assert.strictEqual(Object.prototype.hasOwnProperty.call(statusUpdate.task, 'title'), false);
    assert.strictEqual(/^title:/m.test(fs.readFileSync(newTaskPath, 'utf8')), false);

    var legacyPath = path.join(repoRoot, '.gmc', 'tasks', 'GMC-0099.md');
    fs.writeFileSync(legacyPath, [
      '---',
      'id: GMC-0099',
      'title: "Legacy title"',
      'status: todo',
      'created: "2026-01-01T00:00:00.000Z"',
      'updated: "2026-01-01T00:00:00.000Z"',
      '---',
      '',
      'Legacy content.',
      ''
    ].join('\n'));

    var updateResponse = await request(info, '/api/tasks/update?repo=' + encodeURIComponent(repoRoot), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'GMC-0099', title: 'Changed title', content: 'Updated content.' })
    });
    assert.strictEqual(updateResponse.status, 200);
    var updated = await updateResponse.json();
    assert.strictEqual(updated.task.title, 'Legacy title');
    assert.strictEqual(updated.task.content, 'Updated content.');
    assert.ok(/^title: "Legacy title"$/m.test(fs.readFileSync(legacyPath, 'utf8')));

    var emptyResponse = await request(info, '/api/tasks/create?repo=' + encodeURIComponent(repoRoot), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '' })
    });
    assert.notStrictEqual(emptyResponse.status, 200);

    console.log('Content-only task tests passed.');
  } finally {
    os.homedir = originalHomedir;
    if (info && info.server) {
      await new Promise(function (resolve) { info.server.close(resolve); });
    }
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

run().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
