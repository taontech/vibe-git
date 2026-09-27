'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var originalHomedir = os.homedir;
var testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gmc-terminal-config-'));
var fakeHome = path.join(testRoot, 'home');
var repoRoot = path.join(testRoot, 'repo');

fs.mkdirSync(fakeHome, { recursive: true });
fs.mkdirSync(repoRoot, { recursive: true });
os.homedir = function () { return fakeHome; };

var config = require('../lib/config');
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

    // 1. Default terminal configuration is vibetermi
    assert.strictEqual(config.DEFAULT_TERMINAL, 'vibetermi');
    var defaultTerm = config.currentTerminal();
    assert.strictEqual(defaultTerm, 'vibetermi', 'Default terminal should be vibetermi');

    // 2. Set terminal to iterm
    var setRes = config.setTerminal('iterm');
    assert.strictEqual(setRes, 'iterm');
    assert.strictEqual(config.currentTerminal(), 'iterm');

    // 3. Reset terminal to vibetermi
    config.setTerminal('vibetermi');
    assert.strictEqual(config.currentTerminal(), 'vibetermi');

    // 4. Start web server and test APIs
    info = await web.start(repoRoot, { noOpen: true, port: 45136 });

    // GET /api/terminal
    var termRes = await request(info, '/api/terminal');
    assert.strictEqual(termRes.status, 200);
    var termData = await termRes.json();
    assert.strictEqual(termData.terminal, 'vibetermi');
    assert.strictEqual(Array.isArray(termData.installedTerminals), true);

    // GET /api/agent includes terminal info
    var agentRes = await request(info, '/api/agent');
    assert.strictEqual(agentRes.status, 200);
    var agentData = await agentRes.json();
    assert.strictEqual(agentData.terminal, 'vibetermi');
    assert.strictEqual(Array.isArray(agentData.installedTerminals), true);

    // POST /api/terminal
    var postRes = await request(info, '/api/terminal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal: 'terminal' })
    });
    assert.strictEqual(postRes.status, 200);
    var postData = await postRes.json();
    assert.strictEqual(postData.terminal, 'terminal');
    assert.strictEqual(config.currentTerminal(), 'terminal');

    // POST /api/agent with scope=terminal
    var postAgentRes = await request(info, '/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'terminal', agent: 'vibetermi' })
    });
    assert.strictEqual(postAgentRes.status, 200);
    var postAgentData = await postAgentRes.json();
    assert.strictEqual(postAgentData.terminal, 'vibetermi');
    assert.strictEqual(config.currentTerminal(), 'vibetermi');

    // Check HTML index page contains terminal settings elements
    var pageRes = await request(info, '/');
    assert.strictEqual(pageRes.status, 200);
    var html = await pageRes.text();
    assert.strictEqual(html.indexOf('id="terminalSettingsCard"') !== -1, true, 'HTML should contain terminalSettingsCard');
    assert.strictEqual(html.indexOf('id="terminalOptions"') !== -1, true, 'HTML should contain terminalOptions');
    assert.strictEqual(html.indexOf('INITIAL_TERMINAL') !== -1, true, 'HTML should contain INITIAL_TERMINAL');

    console.log('Terminal configuration and API tests passed.');
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

run().catch(function (error) {
  console.error(error);
  process.exit(1);
});
