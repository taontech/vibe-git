'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');
var vm = require('vm');

var originalHomedir = os.homedir;
var testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gmc-agent-availability-'));
var fakeHome = path.join(testRoot, 'home');
var repoRoot = path.join(testRoot, 'repo');

fs.mkdirSync(fakeHome, { recursive: true });
fs.mkdirSync(repoRoot, { recursive: true });
os.homedir = function () { return fakeHome; };

var agentAvailability = require('../lib/agent-availability');
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

    // 1. Data model and default configuration
    var defaultAgents = agentAvailability.getDefaultAgentAvailability();
    assert.strictEqual(Array.isArray(defaultAgents), true);
    assert.strictEqual(defaultAgents.length, 4);

    var expectedAgents = ['codex', 'claude', 'antigravity', 'opencode'];
    expectedAgents.forEach(function (id) {
      var found = defaultAgents.find(function (a) { return a.agentId === id; });
      assert.ok(found, 'Default agent ' + id + ' should be defined');
      assert.strictEqual(typeof found.name, 'string');
      assert.strictEqual(found.enabled, true, 'Default agent ' + id + ' should be enabled');
    });

    // Verify immutability of returned defaults
    defaultAgents[0].enabled = false;
    var freshDefaults = agentAvailability.getDefaultAgentAvailability();
    assert.strictEqual(freshDefaults[0].enabled, true);

    // 2. Initial load without configuration file on disk
    var configFile = path.join(fakeHome, '.config', 'gmc', 'config.json');
    assert.strictEqual(fs.existsSync(configFile), false);

    var initialList = config.listAgentAvailability();
    assert.strictEqual(initialList.length, 4);
    assert.strictEqual(initialList.every(function (a) { return a.enabled === true; }), true);

    var codexInitial = config.getAgentAvailability('codex');
    assert.deepStrictEqual(codexInitial, {
      agentId: 'codex',
      name: 'Codex',
      enabled: true
    });
    assert.strictEqual(config.isAgentEnabled('codex'), true);

    // Case-insensitivity and trimming
    var trimmedCodex = config.getAgentAvailability('  CODEX  ');
    assert.strictEqual(trimmedCodex.agentId, 'codex');

    // 3. Input validation & exception handling
    assert.throws(function () {
      config.normalizeAgentId(null);
    }, TypeError);

    assert.throws(function () {
      config.normalizeAgentId(123);
    }, TypeError);

    assert.throws(function () {
      config.normalizeAgentId('');
    }, /agentId cannot be empty/);

    assert.throws(function () {
      config.normalizeAgentId('   ');
    }, /agentId cannot be empty/);

    assert.throws(function () {
      config.normalizeAgentId('unsupported-agent');
    }, /Unsupported agent/);

    assert.throws(function () {
      config.validateEnabled('true');
    }, TypeError);

    assert.throws(function () {
      config.validateEnabled(1);
    }, TypeError);

    assert.throws(function () {
      config.validateEnabled(null);
    }, TypeError);

    assert.throws(function () {
      config.setAgentAvailability('unsupported', true);
    }, /Unsupported agent/);

    assert.throws(function () {
      config.setAgentAvailability('codex', 'invalid');
    }, TypeError);

    assert.throws(function () {
      config.setAllAgentAvailability('not an object or array');
    }, TypeError);

    assert.throws(function () {
      config.setAllAgentAvailability([ { agentId: 'codex', enabled: 'not-a-bool' } ]);
    }, TypeError);

    assert.throws(function () {
      config.setAllAgentAvailability({ codex: 'not-a-bool' });
    }, TypeError);

    // 4. Single item update and persistence to disk
    var updatedClaude = config.setAgentAvailability('claude', false);
    assert.deepStrictEqual(updatedClaude, {
      agentId: 'claude',
      name: 'Claude',
      enabled: false
    });
    assert.strictEqual(config.isAgentEnabled('claude'), false);
    assert.strictEqual(config.isAgentEnabled('codex'), true);

    // Verify persisted on disk
    assert.strictEqual(fs.existsSync(configFile), true);
    var savedRaw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.ok(savedRaw.agentAvailability);
    var savedClaude = savedRaw.agentAvailability.find(function (a) { return a.agentId === 'claude'; });
    assert.strictEqual(savedClaude.enabled, false);

    // Re-read via fresh listAgentAvailability call
    var listAfterDisable = config.listAgentAvailability();
    var claudeItem = listAfterDisable.find(function (a) { return a.agentId === 'claude'; });
    assert.strictEqual(claudeItem.enabled, false);
    var codexItem = listAfterDisable.find(function (a) { return a.agentId === 'codex'; });
    assert.strictEqual(codexItem.enabled, true);

    // Object signature: setAgentAvailability({ agentId, enabled })
    config.setAgentAvailability({ agentId: 'opencode', enabled: false });
    assert.strictEqual(config.isAgentEnabled('opencode'), false);

    // Re-enable claude
    config.setAgentAvailability('claude', true);
    assert.strictEqual(config.isAgentEnabled('claude'), true);

    // 5. Batch update
    var batchResult = config.setAllAgentAvailability([
      { agentId: 'codex', enabled: false },
      { agentId: 'antigravity', enabled: false }
    ]);
    assert.strictEqual(Array.isArray(batchResult), true);
    assert.strictEqual(config.isAgentEnabled('codex'), false);
    assert.strictEqual(config.isAgentEnabled('antigravity'), false);
    assert.strictEqual(config.isAgentEnabled('claude'), true);

    // Object map batch update
    config.setAllAgentAvailability({
      codex: true,
      antigravity: true,
      opencode: true
    });
    assert.strictEqual(config.isAgentEnabled('codex'), true);
    assert.strictEqual(config.isAgentEnabled('antigravity'), true);
    assert.strictEqual(config.isAgentEnabled('opencode'), true);

    // Atomic validation check: if any entry in batch is invalid, disk is not corrupted
    var beforeBatch = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.throws(function () {
      config.setAllAgentAvailability([
        { agentId: 'codex', enabled: false },
        { agentId: 'invalid-agent', enabled: false }
      ]);
    }, /Unsupported agent/);
    var afterFailedBatch = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.deepStrictEqual(beforeBatch, afterFailedBatch);
    assert.strictEqual(config.isAgentEnabled('codex'), true);

    // 6. Reset to default
    config.setAgentAvailability('codex', false);
    assert.strictEqual(config.isAgentEnabled('codex'), false);
    var resetList = config.resetAgentAvailability();
    assert.strictEqual(resetList.every(function (a) { return a.enabled === true; }), true);
    assert.strictEqual(config.isAgentEnabled('codex'), true);

    // 7. HTTP API Integration tests
    info = await web.start(repoRoot, { noOpen: true, port: 45125 });

    // GET /api/agent-availability (all)
    var getRes = await request(info, '/api/agent-availability');
    assert.strictEqual(getRes.status, 200);
    var getData = await getRes.json();
    assert.ok(Array.isArray(getData.agents));
    assert.strictEqual(getData.agents.length, 4);

    // GET /api/agent-availability?agentId=codex (single)
    var getSingleRes = await request(info, '/api/agent-availability?agentId=codex');
    assert.strictEqual(getSingleRes.status, 200);
    var getSingleData = await getSingleRes.json();
    assert.strictEqual(getSingleData.agent.agentId, 'codex');
    assert.strictEqual(getSingleData.agent.name, 'Codex');
    assert.strictEqual(getSingleData.agent.enabled, true);

    // GET /api/agent-availability?agentId=invalid (error)
    var getInvalidRes = await request(info, '/api/agent-availability?agentId=invalid');
    assert.strictEqual(getInvalidRes.status, 400);

    // POST /api/agent-availability (single update)
    var postSingleRes = await request(info, '/api/agent-availability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'claude', enabled: false })
    });
    assert.strictEqual(postSingleRes.status, 200);
    var postSingleData = await postSingleRes.json();
    assert.strictEqual(postSingleData.status, 'ok');
    assert.strictEqual(postSingleData.agent.agentId, 'claude');
    assert.strictEqual(postSingleData.agent.enabled, false);
    assert.strictEqual(config.isAgentEnabled('claude'), false);

    // GET /api/agent includes availableAgents
    var getAgentRes = await request(info, '/api/agent');
    assert.strictEqual(getAgentRes.status, 200);
    var getAgentData = await getAgentRes.json();
    assert.ok(Array.isArray(getAgentData.availableAgents));
    var claudeInAgentData = getAgentData.availableAgents.find(function (a) { return a.agentId === 'claude'; });
    assert.strictEqual(claudeInAgentData.enabled, false);

    // POST /api/agent-availability (batch update)
    var postBatchRes = await request(info, '/api/agent-availability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agents: [
          { agentId: 'claude', enabled: true },
          { agentId: 'antigravity', enabled: false }
        ]
      })
    });
    assert.strictEqual(postBatchRes.status, 200);
    var postBatchData = await postBatchRes.json();
    assert.strictEqual(postBatchData.status, 'ok');
    assert.strictEqual(config.isAgentEnabled('claude'), true);
    assert.strictEqual(config.isAgentEnabled('antigravity'), false);

    // POST /api/agent with scope 'availability'
    var postScopeRes = await request(info, '/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'antigravity',
        enabled: true,
        scope: 'availability'
      })
    });
    assert.strictEqual(postScopeRes.status, 200);
    var postScopeData = await postScopeRes.json();
    assert.strictEqual(postScopeData.status, 'ok');
    assert.strictEqual(postScopeData.agent.enabled, true);
    assert.strictEqual(config.isAgentEnabled('antigravity'), true);

    // POST /api/agent-availability with invalid input (missing params)
    var postInvalidRes = await request(info, '/api/agent-availability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.strictEqual(postInvalidRes.status, 400);

    // 8. Web dashboard UI & Settings page markup verification
    var indexRes = await request(info, '/');
    assert.strictEqual(indexRes.status, 200);
    var indexHtml = await indexRes.text();
    assert.ok(indexHtml.indexOf('id="availableAgentsSelector"') !== -1, 'HTML should contain availableAgentsSelector');
    assert.ok(indexHtml.indexOf('id="availableAgentsList"') !== -1, 'HTML should contain availableAgentsList');
    assert.ok(indexHtml.indexOf('id="availableAgentsStatus"') !== -1, 'HTML should contain availableAgentsStatus');
    assert.ok(indexHtml.indexOf('data-i18n="availableAgentsSetting"') !== -1, 'HTML should contain i18n attribute for availableAgentsSetting');
    assert.ok(indexHtml.indexOf('data-i18n="availableAgentsSettingHelp"') !== -1, 'HTML should contain i18n attribute for availableAgentsSettingHelp');
    assert.ok(indexHtml.indexOf('function loadAvailableAgents') !== -1, 'Script should contain loadAvailableAgents function');
    assert.ok(indexHtml.indexOf('function renderAvailableAgents') !== -1, 'Script should contain renderAvailableAgents function');
    assert.ok(indexHtml.indexOf('function updateAgentAvailability') !== -1, 'Script should contain updateAgentAvailability function');
    assert.ok(indexHtml.indexOf('availableAgentsSetting:') !== -1, 'Script should contain availableAgentsSetting translations');

    // 9. Task Board Agent filtering and polling tests (GMC-0027)
    // 9.1 Markup and script verification
    assert.ok(indexHtml.indexOf('INITIAL_AVAILABLE_AGENTS') !== -1, 'HTML should contain INITIAL_AVAILABLE_AGENTS');
    assert.ok(indexHtml.indexOf('function isAgentAvailable') !== -1, 'Script should contain isAgentAvailable function');
    assert.ok(indexHtml.indexOf('function getVisibleTaskBoardStatuses') !== -1, 'Script should contain getVisibleTaskBoardStatuses function');
    assert.ok(indexHtml.indexOf('function getEnabledAgentIds') !== -1, 'Script should contain getEnabledAgentIds function');
    assert.ok(indexHtml.indexOf('function filterAgentMonitorAgents') !== -1, 'Script should contain filterAgentMonitorAgents function');
    assert.ok(indexHtml.indexOf('function filterAgentMonitorUsage') !== -1, 'Script should contain filterAgentMonitorUsage function');

    // 9.2 Backend /api/agent-monitor status check blocking and filtering
    config.setAgentAvailability('codex', false);
    assert.strictEqual(config.isAgentEnabled('codex'), false);

    // Direct query for disabled agent is blocked
    var disabledCodexRes = await request(info, '/api/agent-monitor?agent=codex');
    assert.strictEqual(disabledCodexRes.status, 200);
    var disabledCodexData = await disabledCodexRes.json();
    assert.strictEqual(disabledCodexData.status, 'disabled');
    assert.strictEqual(disabledCodexData.available, false);
    assert.strictEqual(disabledCodexData.reason, 'agent_disabled');
    assert.strictEqual(disabledCodexData.agent, 'codex');

    // Query for enabled agent claude is not blocked as agent_disabled
    var enabledClaudeRes = await request(info, '/api/agent-monitor?agent=claude');
    assert.strictEqual(enabledClaudeRes.status, 200);
    var enabledClaudeData = await enabledClaudeRes.json();
    assert.notStrictEqual(enabledClaudeData.reason, 'agent_disabled');

    // General /api/agent-monitor does not include disabled codex in agents or usage
    var monitorRes = await request(info, '/api/agent-monitor');
    assert.strictEqual(monitorRes.status, 200);
    var monitorData = await monitorRes.json();
    if (monitorData.agents) {
      var foundCodexAgent = monitorData.agents.some(function (a) {
        return a.agentId === 'codex' || a.agentId === 'codex-cli' || a.agentId === 'codex-app';
      });
      assert.strictEqual(foundCodexAgent, false, 'Disabled codex must not appear in /api/agent-monitor agents');
    }
    if (monitorData.usage) {
      assert.strictEqual(Boolean(monitorData.usage.codex), false, 'Disabled codex must not appear in /api/agent-monitor usage');
    }

    // Disable all agents
    config.setAllAgentAvailability({
      codex: false,
      claude: false,
      antigravity: false,
      opencode: false
    });
    var allDisabledRes = await request(info, '/api/agent-monitor');
    assert.strictEqual(allDisabledRes.status, 200);
    var allDisabledData = await allDisabledRes.json();
    assert.strictEqual(allDisabledData.status, 'ok');
    assert.deepStrictEqual(allDisabledData.agents, []);
    assert.strictEqual(allDisabledData.usage, null);

    // Re-enable codex
    config.setAgentAvailability('codex', true);
    assert.strictEqual(config.isAgentEnabled('codex'), true);
    var reEnabledCodexRes = await request(info, '/api/agent-monitor?agent=codex');
    assert.strictEqual(reEnabledCodexRes.status, 200);
    var reEnabledCodexData = await reEnabledCodexRes.json();
    assert.notStrictEqual(reEnabledCodexData.reason, 'agent_disabled');

    // Reset agents to default
    config.resetAgentAvailability();

    // 9.3 In-browser task board simulation using VM
    var scriptMatches = indexHtml.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g) || [];
    var mainScript = scriptMatches.find(function (s) {
      return s.indexOf('getVisibleTaskBoardStatuses') !== -1;
    });
    assert.ok(mainScript, 'Main script tag should contain getVisibleTaskBoardStatuses');
    var scriptContent = mainScript.replace(/^<script(?:\s[^>]*)?>/, '').replace(/<\/script>$/, '');

    var sandbox = {
      window: {
        location: { href: 'http://localhost:45125/?repo=' + encodeURIComponent(repoRoot), search: '?repo=' + encodeURIComponent(repoRoot), host: 'localhost:45125', protocol: 'http:' },
        localStorage: { getItem: function () { return null; }, setItem: function () {} },
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        addEventListener: function () {},
        removeEventListener: function () {},
        fetch: function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } }); }
      },
      document: {
        documentElement: { lang: 'en', setAttribute: function () {} },
        getElementById: function () {
          return {
            textContent: '',
            innerHTML: '',
            style: {},
            setAttribute: function () {},
            getAttribute: function () { return ''; },
            removeAttribute: function () {},
            appendChild: function () {},
            removeChild: function () {},
            focus: function () {},
            blur: function () {},
            click: function () {},
            querySelector: function () { return null; },
            querySelectorAll: function () { return []; },
            setProperty: function () {},
            dataset: {},
            classList: { add: function () {}, remove: function () {}, toggle: function () {} },
            addEventListener: function () {},
            removeEventListener: function () {}
          };
        },
        querySelectorAll: function () { return []; },
        querySelector: function () { return null; },
        addEventListener: function () {}
      },
      navigator: { language: 'en' },
      localStorage: { getItem: function () { return null; }, setItem: function () {} },
      Headers: function () {},
      URL: URL,
      URLSearchParams: URLSearchParams,
      AbortController: AbortController,
      fetch: function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } }); },
      console: console,
      setTimeout: setTimeout,
      clearTimeout: clearTimeout,
      performance: { mark: function () {}, measure: function () {}, getEntriesByName: function () { return []; }, now: function () { return Date.now(); } }
    };
    sandbox.window.window = sandbox.window;
    var vmContext = vm.createContext(sandbox);
    var vmScript = new vm.Script(scriptContent);
    vmScript.runInContext(vmContext);

    function toPlain(obj) {
      return JSON.parse(JSON.stringify(obj));
    }

    // Test getVisibleTaskBoardStatuses in sandbox
    var initialVisible = vmContext.getVisibleTaskBoardStatuses();
    assert.strictEqual(initialVisible.length, 5, 'Initially all 5 columns should be visible');
    assert.deepStrictEqual(toPlain(initialVisible.map(function (c) { return c.id; })), ['todo', 'codex', 'claude', 'antigravity', 'done']);

    // Disable codex in sandbox
    vmContext.state.availableAgents = [
      { agentId: 'codex', name: 'Codex', enabled: false },
      { agentId: 'claude', name: 'Claude', enabled: true },
      { agentId: 'antigravity', name: 'Antigravity', enabled: true },
      { agentId: 'opencode', name: 'OpenCode', enabled: true }
    ];
    var visibleAfterDisableCodex = vmContext.getVisibleTaskBoardStatuses();
    assert.strictEqual(visibleAfterDisableCodex.length, 4, 'Codex should be removed when disabled');
    assert.deepStrictEqual(toPlain(visibleAfterDisableCodex.map(function (c) { return c.id; })), ['todo', 'claude', 'antigravity', 'done']);
    assert.strictEqual(vmContext.isAgentAvailable('codex'), false);
    assert.strictEqual(vmContext.isAgentAvailable('claude'), true);

    // Filter agents check
    var sampleAgents = [
      { agentId: 'codex-cli', displayName: 'Codex CLI' },
      { agentId: 'claude-code', displayName: 'Claude Code' },
      { agentId: 'antigravity', displayName: 'Antigravity' }
    ];
    var filteredAgents = vmContext.filterAgentMonitorAgents(sampleAgents);
    assert.strictEqual(filteredAgents.length, 2);
    assert.strictEqual(filteredAgents.some(function (a) { return a.agentId === 'codex-cli'; }), false);

    // Filter usage check
    var sampleUsage = {
      codex: { status: 'ok' },
      'claude-code': { status: 'ok' }
    };
    var filteredUsage = vmContext.filterAgentMonitorUsage(sampleUsage);
    assert.strictEqual(filteredUsage.codex, undefined);
    assert.ok(filteredUsage['claude-code']);

    // Querying disabled codex returns disabled state immediately
    vmContext.state.activeView = 'tasks';
    var loadCodexResult = await vmContext.loadAgentMonitor({ agent: 'codex' });
    assert.strictEqual(loadCodexResult.status, 'disabled');
    assert.strictEqual(loadCodexResult.reason, 'agent_disabled');

    // Disable all agents in sandbox
    vmContext.state.availableAgents = [
      { agentId: 'codex', enabled: false },
      { agentId: 'claude', enabled: false },
      { agentId: 'antigravity', enabled: false },
      { agentId: 'opencode', enabled: false }
    ];
    var visibleAllDisabled = vmContext.getVisibleTaskBoardStatuses();
    assert.strictEqual(visibleAllDisabled.length, 2);
    assert.deepStrictEqual(toPlain(visibleAllDisabled.map(function (c) { return c.id; })), ['todo', 'done']);
    assert.deepStrictEqual(toPlain(vmContext.getEnabledAgentIds()), []);

    // Load agent monitor with all disabled
    var allDisabledMonitor = await vmContext.loadAgentMonitor();
    assert.strictEqual(allDisabledMonitor.status, 'ok');
    assert.deepStrictEqual(toPlain(allDisabledMonitor.agents), []);

    // Re-enable codex and claude
    vmContext.state.availableAgents = [
      { agentId: 'codex', enabled: true },
      { agentId: 'claude', enabled: true },
      { agentId: 'antigravity', enabled: false },
      { agentId: 'opencode', enabled: false }
    ];
    var reEnabledVisible = vmContext.getVisibleTaskBoardStatuses();
    assert.strictEqual(reEnabledVisible.length, 4);
    assert.deepStrictEqual(toPlain(reEnabledVisible.map(function (c) { return c.id; })), ['todo', 'codex', 'claude', 'done']);
    assert.deepStrictEqual(toPlain(vmContext.getEnabledAgentIds()), ['codex', 'claude']);

    console.log('Agent availability tests passed.');
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
