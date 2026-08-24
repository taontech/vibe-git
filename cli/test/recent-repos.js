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

    // Test /api/git-overview endpoint
    var overviewUrl = new URL('/api/git-overview', info.url);
    var overviewRes = await fetch(overviewUrl, {
      headers: { 'X-GMC-Auth': serviceUrl.searchParams.get('gmc_auth') }
    });
    assert.strictEqual(overviewRes.status, 200);
    var overviewJson = await overviewRes.json();
    assert.ok(overviewJson.version, 'overview should have git version');
    assert.ok(overviewJson.execPath || overviewJson.gitBin, 'overview should have git executable path');
    assert.ok(overviewJson.globalContributions, 'overview should have globalContributions');
    assert.strictEqual(overviewJson.repositoriesCount, 2);

    // Test /api/git-config endpoint
    var configUrl = new URL('/api/git-config', info.url);
    var setConfigRes = await fetch(configUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GMC-Auth': serviceUrl.searchParams.get('gmc_auth')
      },
      body: JSON.stringify({ key: 'gmc.testkey', value: 'hello-test-val' })
    });
    assert.strictEqual(setConfigRes.status, 200);
    var setConfigJson = await setConfigRes.json();
    assert.strictEqual(setConfigJson.status, 'ok');
    assert.ok(setConfigJson.overview, 'response should include updated overview');

    // Clean up the test config key
    await fetch(configUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GMC-Auth': serviceUrl.searchParams.get('gmc_auth')
      },
      body: JSON.stringify({ key: 'gmc.testkey', value: null })
    });

    // Verify dashboard HTML contains SPA repo switching, close button, home page, and scroll preservation
    var pageRes = await fetch(info.url, {
      headers: { 'X-GMC-Auth': serviceUrl.searchParams.get('gmc_auth') }
    });
    assert.strictEqual(pageRes.status, 200);
    var html = await pageRes.text();
    assert.ok(html.indexOf('function switchRepository(') >= 0, 'HTML should include switchRepository function');
    assert.ok(html.indexOf('function exitToHome(') >= 0, 'HTML should include exitToHome function');
    assert.ok(html.indexOf('function updateSidebarActive(') >= 0, 'HTML should include updateSidebarActive function');
    assert.ok(html.indexOf('openRepoFromHistory(item.getAttribute(\'data-repo\'))') >= 0, 'HTML should bind openRepoFromHistory on click');
    assert.ok(html.indexOf('prevScroll = list.scrollTop') >= 0, 'renderSidebar should preserve scroll position');
    assert.ok(html.indexOf('id="homePage"') >= 0, 'HTML should contain homePage container');
    assert.ok(html.indexOf('id="closeRepoBtn"') >= 0, 'HTML should contain closeRepoBtn button');
    assert.ok(html.indexOf('id="homeCalendar"') >= 0, 'HTML should contain homeCalendar grid');
    assert.ok(html.indexOf('id="globalConfigForm"') >= 0, 'HTML should contain globalConfigForm');
    assert.ok(html.indexOf('data-launch-app="vscode"') >= 0, 'HTML should contain VS Code launcher button');
    assert.ok(html.indexOf('data-launch-app="xcode"') >= 0, 'HTML should contain Xcode launcher button');
    assert.ok(html.indexOf('data-launch-app="android-studio"') >= 0, 'HTML should contain Android Studio launcher button');
    assert.ok(html.indexOf('data-launch-app="sublime"') >= 0, 'HTML should contain Sublime Text launcher button');
    assert.ok(html.indexOf('data-launch-app="cursor"') >= 0, 'HTML should contain Cursor launcher button');
    assert.ok(html.indexOf('data-launch-app="terminal"') >= 0, 'HTML should contain Terminal launcher button');

    console.log('Recent repository sorting, global overview homepage, contributions, config editor, and SPA switching tests passed.');
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
