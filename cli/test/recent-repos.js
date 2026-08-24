'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var originalHomedir = os.homedir;
var testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gmc-recent-repos-test-'));
var fakeHome = path.join(testRoot, 'home');
var repoA = path.join(testRoot, 'repoA');
var repoB = path.join(testRoot, 'repoB');

fs.mkdirSync(fakeHome, { recursive: true });
fs.mkdirSync(repoA, { recursive: true });
fs.mkdirSync(repoB, { recursive: true });
repoA = fs.realpathSync(repoA);
repoB = fs.realpathSync(repoB);
os.homedir = function () { return fakeHome; };

var web = require('../lib/web');

async function run() {
  var info;
  try {
    // Init git repo A
    childProcess.execFileSync('git', ['init', repoA], { stdio: 'ignore' });
    childProcess.execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoA, stdio: 'ignore' });
    childProcess.execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoA, stdio: 'ignore' });
    fs.writeFileSync(path.join(repoA, 'fileA.txt'), 'hello A');
    childProcess.execFileSync('git', ['add', '.'], { cwd: repoA, stdio: 'ignore' });
    childProcess.execFileSync('git', ['commit', '-m', 'commit A', '--date=2026-07-27T10:00:00Z'], { cwd: repoA, stdio: 'ignore' });

    // Init git repo B
    childProcess.execFileSync('git', ['init', repoB], { stdio: 'ignore' });
    childProcess.execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoB, stdio: 'ignore' });
    childProcess.execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoB, stdio: 'ignore' });
    fs.writeFileSync(path.join(repoB, 'fileB.txt'), 'hello B');
    childProcess.execFileSync('git', ['add', '.'], { cwd: repoB, stdio: 'ignore' });
    childProcess.execFileSync('git', ['commit', '-m', 'commit B', '--date=2026-07-27T08:00:00Z'], { cwd: repoB, stdio: 'ignore' });

    // Set up recent-repos.json directly
    var recentFile = path.join(fakeHome, '.config', 'gmc', 'recent-repos.json');
    fs.mkdirSync(path.dirname(recentFile), { recursive: true });
    var data = {
      repositories: [
        { name: 'repoA', path: repoA, lastVisited: 1000 },
        { name: 'repoB', path: repoB, lastVisited: 2000 }
      ]
    };
    fs.writeFileSync(recentFile, JSON.stringify(data, null, 2));

    info = await web.start(repoA, { noOpen: true, port: 45121 });

    var serviceUrl = new URL(info.url);
    var targetUrl = new URL('/api/repositories', info.url);
    var res = await fetch(targetUrl, {
      headers: { 'X-GMC-Auth': serviceUrl.searchParams.get('gmc_auth') }
    });
    assert.strictEqual(res.status, 200);
    var json = await res.json();
    assert.ok(Array.isArray(json.repositories));
    assert.strictEqual(json.repositories.length, 2);

    // Repo A has commit at 10:00:00, Repo B has commit at 08:00:00
    // Even though Repo B has larger lastVisited (2000 vs 1000), Repo A should be first due to latest commit order.
    assert.strictEqual(json.repositories[0].path, repoA);
    assert.strictEqual(json.repositories[1].path, repoB);

    // Test /api/status returns both current contributions and aggregated globalContributions
    var statusUrl = new URL('/api/status?repo=' + encodeURIComponent(repoA), info.url);
    var statusRes = await fetch(statusUrl, {
      headers: { 'X-GMC-Auth': serviceUrl.searchParams.get('gmc_auth') }
    });
    assert.strictEqual(statusRes.status, 200);
    var statusJson = await statusRes.json();
    assert.ok(statusJson.contributions, 'status should have contributions');
    assert.ok(statusJson.globalContributions, 'status should have globalContributions');

    // Find the date key for repoA's commit
    var dateKeys = Object.keys(statusJson.contributions);
    assert.ok(dateKeys.length >= 1, 'should have at least one contribution date');
    var commitDate = dateKeys[0];
    assert.strictEqual(statusJson.contributions[commitDate], 1, 'repoA has 1 commit');
    assert.strictEqual(statusJson.globalContributions[commitDate], 2, 'repoA + repoB has 2 commits aggregated in globalContributions');

    console.log('Recent repository sorting and global contributions tests passed.');
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
