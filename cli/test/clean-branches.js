'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gmc-clean-branches-test-'));
var fakeHome = path.join(testRoot, 'home');
var repo = path.join(testRoot, 'test-repo');

fs.mkdirSync(fakeHome, { recursive: true });
fs.mkdirSync(repo, { recursive: true });
repo = fs.realpathSync(repo);
os.homedir = function () { return fakeHome; };

var git = require('../lib/git');
var web = require('../lib/web');

async function run() {
  var info;
  try {
    // 1. Initialize git repo
    childProcess.execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
    childProcess.execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo, stdio: 'ignore' });
    childProcess.execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' });

    // Initial commit on main
    fs.writeFileSync(path.join(repo, 'main.txt'), 'hello main\n');
    childProcess.execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
    childProcess.execFileSync('git', ['commit', '-m', 'initial commit on main'], { cwd: repo, stdio: 'ignore' });

    // Create a feature branch that gets merged into main
    childProcess.execFileSync('git', ['switch', '-c', 'feat/merged-feature'], { cwd: repo, stdio: 'ignore' });
    fs.writeFileSync(path.join(repo, 'feature.txt'), 'feature content\n');
    childProcess.execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
    childProcess.execFileSync('git', ['commit', '-m', 'feat: add merged feature'], { cwd: repo, stdio: 'ignore' });

    // Switch back to main and merge it
    childProcess.execFileSync('git', ['switch', 'main'], { cwd: repo, stdio: 'ignore' });
    childProcess.execFileSync('git', ['merge', 'feat/merged-feature', '--no-ff', '-m', 'merge feat/merged-feature'], { cwd: repo, stdio: 'ignore' });

    // Create an unmerged feature branch
    childProcess.execFileSync('git', ['switch', '-c', 'feat/unmerged-work'], { cwd: repo, stdio: 'ignore' });
    fs.writeFileSync(path.join(repo, 'wip.txt'), 'wip content\n');
    childProcess.execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
    childProcess.execFileSync('git', ['commit', '-m', 'feat: unmerged commit'], { cwd: repo, stdio: 'ignore' });

    // Switch back to main
    childProcess.execFileSync('git', ['switch', 'main'], { cwd: repo, stdio: 'ignore' });

    // Test git.getDefaultBranch
    var defBranch = git.getDefaultBranch(repo);
    assert.strictEqual(defBranch, 'main');

    // Test git.getCleanableBranches
    var cleanInfo = git.getCleanableBranches(repo, { baseBranch: 'main' });
    assert.strictEqual(cleanInfo.baseBranch, 'main');
    assert.strictEqual(cleanInfo.currentBranch, 'main');

    var mergedBranch = cleanInfo.branches.find(function(b) { return b.name === 'feat/merged-feature'; });
    assert.ok(mergedBranch, 'feat/merged-feature should exist');
    assert.strictEqual(mergedBranch.isMerged, true);
    assert.strictEqual(mergedBranch.status, 'merged');
    assert.strictEqual(mergedBranch.canClean, true);

    var unmergedBranch = cleanInfo.branches.find(function(b) { return b.name === 'feat/unmerged-work'; });
    assert.ok(unmergedBranch, 'feat/unmerged-work should exist');
    assert.strictEqual(unmergedBranch.isMerged, false);
    assert.strictEqual(unmergedBranch.status, 'unmerged');
    assert.strictEqual(unmergedBranch.canClean, false);

    var mainBranch = cleanInfo.branches.find(function(b) { return b.name === 'main'; });
    assert.ok(mainBranch, 'main should exist');
    assert.strictEqual(mainBranch.isProtected, true);
    assert.strictEqual(mainBranch.canClean, false);

    assert.strictEqual(cleanInfo.summary.mergedCount, 1);
    assert.strictEqual(cleanInfo.summary.unmergedCount, 1);
    assert.strictEqual(cleanInfo.summary.cleanableCount, 1);

    // Test Web server endpoints
    info = await web.start(repo, { noOpen: true, port: 45199 });
    var serviceUrl = new URL(info.url);
    var token = serviceUrl.searchParams.get('gmc_auth');

    // 1. GET /api/cleanable-branches
    var getUrl = new URL('/api/cleanable-branches?repo=' + encodeURIComponent(repo) + '&base=main', info.url);
    var getRes = await fetch(getUrl, { headers: { 'X-GMC-Auth': token } });
    assert.strictEqual(getRes.status, 200);
    var getJson = await getRes.json();
    assert.strictEqual(getJson.baseBranch, 'main');
    assert.ok(Array.isArray(getJson.branches));
    assert.strictEqual(getJson.summary.cleanableCount, 1);

    // 2. POST /api/clean-branches (Delete merged branch safely)
    var postUrl = new URL('/api/clean-branches?repo=' + encodeURIComponent(repo), info.url);
    var postRes = await fetch(postUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GMC-Auth': token
      },
      body: JSON.stringify({
        branches: ['feat/merged-feature'],
        force: false
      })
    });
    assert.strictEqual(postRes.status, 200);
    var postJson = await postRes.json();
    assert.strictEqual(postJson.status, 'ok');
    assert.strictEqual(postJson.totalDeleted, 1);
    assert.strictEqual(postJson.deleted[0].name, 'feat/merged-feature');
    assert.ok(postJson.deleted[0].hash, 'deleted hash should be recorded for recovery');

    // Verify it is actually deleted from git
    assert.strictEqual(git.branchExists('feat/merged-feature', repo), false);

    // 3. POST /api/clean-branches trying to delete unmerged without force (should fail)
    var failPostRes = await fetch(postUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GMC-Auth': token
      },
      body: JSON.stringify({
        branches: ['feat/unmerged-work'],
        force: false
      })
    });
    assert.strictEqual(failPostRes.status, 200);
    var failJson = await failPostRes.json();
    assert.strictEqual(failJson.totalFailed, 1);
    assert.strictEqual(failJson.totalDeleted, 0);
    assert.strictEqual(git.branchExists('feat/unmerged-work', repo), true);

    // 4. POST /api/clean-branches with force: true for unmerged
    var forcePostRes = await fetch(postUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GMC-Auth': token
      },
      body: JSON.stringify({
        branches: ['feat/unmerged-work'],
        force: true
      })
    });
    assert.strictEqual(forcePostRes.status, 200);
    var forceJson = await forcePostRes.json();
    assert.strictEqual(forceJson.totalDeleted, 1);
    assert.strictEqual(git.branchExists('feat/unmerged-work', repo), false);

    // 5. Test protected branch deletion rejection (main)
    var protPostRes = await fetch(postUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GMC-Auth': token
      },
      body: JSON.stringify({
        branches: ['main'],
        force: true
      })
    });
    var protJson = await protPostRes.json();
    assert.strictEqual(protJson.totalFailed, 1);
    assert.strictEqual(git.branchExists('main', repo), true);

    console.log('Clean branches tests passed.');
  } finally {
    if (info && info.server) {
      await web.quit(45199);
    }
    try {
      fs.rmSync(testRoot, { recursive: true, force: true });
    } catch (e) { }
  }
}

run().catch(function(err) {
  console.error('Test failed:', err);
  process.exit(1);
});
