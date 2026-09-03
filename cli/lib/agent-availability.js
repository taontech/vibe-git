'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');

var DEFAULT_AGENTS = [
  { agentId: 'codex', name: 'Codex', enabled: true },
  { agentId: 'claude', name: 'Claude', enabled: true },
  { agentId: 'antigravity', name: 'Antigravity', enabled: true },
  { agentId: 'opencode', name: 'OpenCode', enabled: true }
];

var SUPPORTED_AGENT_MAP = {
  codex: 'Codex',
  claude: 'Claude',
  antigravity: 'Antigravity',
  opencode: 'OpenCode'
};

var SUPPORTED_AGENT_IDS = ['codex', 'claude', 'antigravity', 'opencode'];

function normalizeAgentId(agentId) {
  if (typeof agentId !== 'string') {
    throw new TypeError('agentId must be a string, got ' + (agentId === null ? 'null' : typeof agentId));
  }
  var trimmed = agentId.trim().toLowerCase();
  if (!trimmed) {
    throw new Error('agentId cannot be empty');
  }
  if (!Object.prototype.hasOwnProperty.call(SUPPORTED_AGENT_MAP, trimmed)) {
    throw new Error('Unsupported agent: "' + agentId + '". Supported agents are: ' + SUPPORTED_AGENT_IDS.join(', '));
  }
  return trimmed;
}

function validateEnabled(enabled) {
  if (typeof enabled !== 'boolean') {
    throw new TypeError('enabled must be a boolean, got ' + (enabled === null ? 'null' : typeof enabled));
  }
  return enabled;
}

function isSupportedAgent(agentId) {
  if (typeof agentId !== 'string') {
    return false;
  }
  var trimmed = agentId.trim().toLowerCase();
  return Boolean(trimmed && Object.prototype.hasOwnProperty.call(SUPPORTED_AGENT_MAP, trimmed));
}

function configFilePath(customPath) {
  if (customPath && typeof customPath === 'string') {
    return customPath;
  }
  return path.join(os.homedir(), '.config', 'gmc', 'config.json');
}

function readConfigFile(customPath) {
  var file = configFilePath(customPath);
  if (!fs.existsSync(file)) {
    return {};
  }
  try {
    var raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    return {};
  }
}

function writeConfigFile(metadata, customPath) {
  var file = configFilePath(customPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(metadata, null, 2) + '\n');
  return metadata;
}

function createAgentConfig(agentId, enabled, name) {
  var normalizedId = normalizeAgentId(agentId);
  var validEnabled = validateEnabled(enabled);
  var displayName = (name && typeof name === 'string' && name.trim())
    ? name.trim()
    : (SUPPORTED_AGENT_MAP[normalizedId] || normalizedId);
  return {
    agentId: normalizedId,
    name: displayName,
    enabled: validEnabled
  };
}

function getDefaultAgentAvailability() {
  return DEFAULT_AGENTS.map(function (item) {
    return {
      agentId: item.agentId,
      name: item.name,
      enabled: item.enabled
    };
  });
}

function parseConfiguredMap(raw) {
  var map = {};
  if (!raw) {
    return map;
  }
  if (Array.isArray(raw)) {
    raw.forEach(function (item) {
      if (item && typeof item === 'object' && typeof item.agentId === 'string') {
        var id = item.agentId.trim().toLowerCase();
        if (id) {
          map[id] = {
            enabled: Boolean(item.enabled),
            name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : null
          };
        }
      }
    });
    return map;
  }
  if (typeof raw === 'object') {
    Object.keys(raw).forEach(function (key) {
      var id = key.trim().toLowerCase();
      if (!id) return;
      var val = raw[key];
      if (typeof val === 'boolean') {
        map[id] = { enabled: val, name: null };
      } else if (val && typeof val === 'object') {
        map[id] = {
          enabled: Boolean(val.enabled),
          name: typeof val.name === 'string' && val.name.trim() ? val.name.trim() : null
        };
      }
    });
  }
  return map;
}

function listAgentAvailability(options) {
  options = options || {};
  var metadata = readConfigFile(options.configPath);
  var configured = parseConfiguredMap(metadata.agentAvailability);

  return DEFAULT_AGENTS.map(function (def) {
    var agentId = def.agentId;
    var userSetting = configured[agentId];
    return {
      agentId: agentId,
      name: (userSetting && userSetting.name) ? userSetting.name : def.name,
      enabled: userSetting ? Boolean(userSetting.enabled) : def.enabled
    };
  });
}

function getAgentAvailability(agentId, options) {
  var normalizedId = normalizeAgentId(agentId);
  var list = listAgentAvailability(options);
  for (var i = 0; i < list.length; i++) {
    if (list[i].agentId === normalizedId) {
      return list[i];
    }
  }
  return {
    agentId: normalizedId,
    name: SUPPORTED_AGENT_MAP[normalizedId] || normalizedId,
    enabled: true
  };
}

function isAgentEnabled(agentId, options) {
  var item = getAgentAvailability(agentId, options);
  return Boolean(item.enabled);
}

function setAgentAvailability(agentId, enabled, options) {
  if (agentId && typeof agentId === 'object' && !Array.isArray(agentId)) {
    options = enabled;
    enabled = agentId.enabled;
    agentId = agentId.agentId;
  }
  var normalizedId = normalizeAgentId(agentId);
  var validEnabled = validateEnabled(enabled);
  options = options || {};

  var metadata = readConfigFile(options.configPath);
  var currentList = listAgentAvailability(options);

  var updatedList = currentList.map(function (item) {
    if (item.agentId === normalizedId) {
      return {
        agentId: item.agentId,
        name: item.name,
        enabled: validEnabled
      };
    }
    return {
      agentId: item.agentId,
      name: item.name,
      enabled: item.enabled
    };
  });

  metadata.agentAvailability = updatedList;
  writeConfigFile(metadata, options.configPath);

  for (var i = 0; i < updatedList.length; i++) {
    if (updatedList[i].agentId === normalizedId) {
      return updatedList[i];
    }
  }
  return {
    agentId: normalizedId,
    name: SUPPORTED_AGENT_MAP[normalizedId] || normalizedId,
    enabled: validEnabled
  };
}

function setAllAgentAvailability(configs, options) {
  options = options || {};
  if (!configs || typeof configs !== 'object') {
    throw new TypeError('configs must be an array or object');
  }

  var updates = {};
  if (Array.isArray(configs)) {
    for (var i = 0; i < configs.length; i++) {
      var entry = configs[i];
      if (!entry || typeof entry !== 'object') {
        throw new TypeError('Each config entry must be an object');
      }
      var id = normalizeAgentId(entry.agentId);
      var en = validateEnabled(entry.enabled);
      updates[id] = en;
    }
  } else {
    var keys = Object.keys(configs);
    for (var j = 0; j < keys.length; j++) {
      var key = keys[j];
      var val = configs[key];
      var normId = normalizeAgentId(key);
      var validEn;
      if (typeof val === 'boolean') {
        validEn = val;
      } else if (val && typeof val === 'object') {
        validEn = validateEnabled(val.enabled);
      } else {
        throw new TypeError('Value for ' + key + ' must be boolean or object with enabled property');
      }
      updates[normId] = validEn;
    }
  }

  var metadata = readConfigFile(options.configPath);
  var currentList = listAgentAvailability(options);

  var updatedList = currentList.map(function (item) {
    if (Object.prototype.hasOwnProperty.call(updates, item.agentId)) {
      return {
        agentId: item.agentId,
        name: item.name,
        enabled: updates[item.agentId]
      };
    }
    return {
      agentId: item.agentId,
      name: item.name,
      enabled: item.enabled
    };
  });

  metadata.agentAvailability = updatedList;
  writeConfigFile(metadata, options.configPath);
  return updatedList;
}

function resetAgentAvailability(options) {
  options = options || {};
  var metadata = readConfigFile(options.configPath);
  delete metadata.agentAvailability;
  writeConfigFile(metadata, options.configPath);
  return getDefaultAgentAvailability();
}

module.exports = {
  DEFAULT_AGENTS: DEFAULT_AGENTS,
  DEFAULT_AGENT_CONFIGS: DEFAULT_AGENTS,
  SUPPORTED_AGENT_IDS: SUPPORTED_AGENT_IDS,
  SUPPORTED_AGENT_MAP: SUPPORTED_AGENT_MAP,
  createAgentConfig: createAgentConfig,
  normalizeAgentId: normalizeAgentId,
  validateEnabled: validateEnabled,
  isSupportedAgent: isSupportedAgent,
  getDefaultAgentAvailability: getDefaultAgentAvailability,
  listAgentAvailability: listAgentAvailability,
  getAgentAvailability: getAgentAvailability,
  isAgentEnabled: isAgentEnabled,
  setAgentAvailability: setAgentAvailability,
  setAllAgentAvailability: setAllAgentAvailability,
  resetAgentAvailability: resetAgentAvailability,
  configFilePath: configFilePath
};
