'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var originalHomedir = os.homedir;
var testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gmc-quick-actions-test-'));
var fakeHome = path.join(testRoot, 'home');
var repo = path.join(testRoot, 'test-repo');
fs.mkdirSync(fakeHome, { recursive: true });
fs.mkdirSync(repo, { recursive: true });
os.homedir = function () { return fakeHome; };

var quickActions = require('../lib/quick-actions');
var web = require('../lib/web');

async function run() {
  var info;
  try {
    // 1. Defaults
    var defaults = quickActions.getDefaultQuickActions();
    assert.strictEqual(Array.isArray(defaults), true);
    assert.strictEqual(defaults.length, 6);
    var ids = defaults.map(function (item) { return item.id; });
    assert.deepStrictEqual(ids, ['terminal', 'opencode', 'claude', 'codex', 'antigravity', 'open-ide']);

    // Immutability
    defaults[0].enabled = false;
    var fresh = quickActions.getDefaultQuickActions();
    assert.strictEqual(fresh[0].enabled, true);

    // 2. listQuickActions with no config file
    var list = quickActions.listQuickActions();
    assert.strictEqual(list.length, 6);

    // 3. saveQuickActions
    var customActions = [
      {
        id: 'terminal',
        name: 'Warp Terminal',
        type: 'app',
        appPath: '/Applications/Warp.app',
        args: '{repo}',
        runInTerminal: false,
        icon: 'terminal',
        enabled: true
      },
      {
        id: 'cursor',
        name: 'Cursor',
        type: 'app',
        appPath: '/Applications/Cursor.app',
        args: '{repo}',
        runInTerminal: false,
        icon: 'cursor',
        enabled: true
      }
    ];

    var saved = quickActions.saveQuickActions(customActions);
    assert.strictEqual(saved.length, 2);
    assert.strictEqual(saved[0].name, 'Warp Terminal');
    assert.strictEqual(saved[1].name, 'Cursor');

    // Read back
    var reloaded = quickActions.listQuickActions();
    assert.strictEqual(reloaded.length, 2);
    assert.strictEqual(reloaded[0].name, 'Warp Terminal');
    assert.strictEqual(reloaded[1].name, 'Cursor');

    // 4. resetQuickActions
    var resetList = quickActions.resetQuickActions();
    assert.strictEqual(resetList.length, 6);
    assert.strictEqual(resetList[0].id, 'terminal');
    assert.strictEqual(resetList[0].name, 'Terminal');

    // 5. Placeholder interpolation
    var interpolated = quickActions.interpolatePlaceholders('{repo}/sub --branch {branch}', '/Users/test/project', 'feature-1');
    assert.strictEqual(interpolated, '/Users/test/project/sub --branch feature-1');

    var interpolatedDollar = quickActions.interpolatePlaceholders('$REPO/sub --branch $BRANCH', '/Users/test/project', 'main');
    assert.strictEqual(interpolatedDollar, '/Users/test/project/sub --branch main');

    // 6. Command line args parsing
    var parsed = quickActions.parseCommandLineArgs('--flag "hello world" \'single quoted\' plain');
    assert.deepStrictEqual(parsed, ['--flag', 'hello world', 'single quoted', 'plain']);

    // 7. Web Server API integration tests
    childProcess.execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
    info = await web.start(repo, { noOpen: true, port: 45288 });
    var serviceUrl = new URL(info.url);
    var token = serviceUrl.searchParams.get('gmc_auth');
    var headers = {
      'Content-Type': 'application/json',
      'X-GMC-Auth': token
    };

    // GET /api/quick-actions
    var getRes = await fetch(new URL('/api/quick-actions', info.url), { headers: headers });
    assert.strictEqual(getRes.status, 200);
    var getJson = await getRes.json();
    assert.ok(Array.isArray(getJson.actions));
    assert.strictEqual(getJson.actions.length, 6);

    // POST /api/quick-actions
    var postRes = await fetch(new URL('/api/quick-actions', info.url), {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ actions: customActions })
    });
    assert.strictEqual(postRes.status, 200);
    var postJson = await postRes.json();
    assert.strictEqual(postJson.status, 'ok');
    assert.strictEqual(postJson.actions.length, 2);

    // Verify GET reflects the saved actions
    var getAfterSave = await fetch(new URL('/api/quick-actions', info.url), { headers: headers });
    var afterJson = await getAfterSave.json();
    assert.strictEqual(afterJson.actions.length, 2);
    assert.strictEqual(afterJson.actions[0].name, 'Warp Terminal');

    // POST /api/quick-actions/reset
    var resetRes = await fetch(new URL('/api/quick-actions/reset', info.url), {
      method: 'POST',
      headers: headers
    });
    assert.strictEqual(resetRes.status, 200);
    var resetJson = await resetRes.json();
    assert.strictEqual(resetJson.status, 'ok');
    assert.strictEqual(resetJson.actions.length, 6);

    // GET /api/app-icon (missing app)
    var missingIconRes = await fetch(new URL('/api/app-icon?name=non_existent_app', info.url), { headers: headers });
    assert.strictEqual(missingIconRes.status, 404);

    console.log('Quick actions tests passed.');
  } finally {
    if (info && info.server) {
      await new Promise(function (resolve) { info.server.close(resolve); });
    }
    os.homedir = originalHomedir;
    try {
      fs.rmSync(testRoot, { recursive: true, force: true });
    } catch (e) {}
  }
}

run().catch(function(err) {
  console.error('Quick actions test failed:', err);
  process.exit(1);
});
