'use strict';

var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var DEFAULT_QUICK_ACTIONS = [
  {
    id: 'terminal',
    name: 'Terminal',
    type: 'builtin',
    builtinId: 'terminal',
    appPath: '/System/Applications/Utilities/Terminal.app',
    command: 'open',
    args: '-a Terminal {repo}',
    runInTerminal: false,
    icon: 'terminal',
    enabled: true
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    type: 'builtin',
    builtinId: 'opencode',
    appPath: '',
    command: 'opencode',
    args: '',
    runInTerminal: true,
    icon: 'opencode',
    enabled: true
  },
  {
    id: 'claude',
    name: 'Claude',
    type: 'builtin',
    builtinId: 'claude',
    appPath: '',
    command: 'claude',
    args: '',
    runInTerminal: true,
    icon: 'claude',
    enabled: true
  },
  {
    id: 'codex',
    name: 'Codex',
    type: 'builtin',
    builtinId: 'codex',
    appPath: '',
    command: 'codex',
    args: '--cd {repo}',
    runInTerminal: true,
    icon: 'codex',
    enabled: true
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    type: 'builtin',
    builtinId: 'antigravity',
    appPath: '',
    command: 'agy',
    args: '',
    runInTerminal: true,
    icon: 'antigravity',
    enabled: true
  },
  {
    id: 'open-ide',
    name: 'VS Code',
    type: 'builtin',
    builtinId: 'open-ide',
    appPath: 'Visual Studio Code',
    command: 'code',
    args: '{repo}',
    runInTerminal: false,
    icon: 'vscode',
    enabled: true
  }
];

var DEFAULT_ACTIONS_MAP = {};
DEFAULT_QUICK_ACTIONS.forEach(function (item) {
  DEFAULT_ACTIONS_MAP[item.id] = item;
});

function configFilePath(customPath) {
  if (customPath && typeof customPath === 'string') {
    return customPath;
  }
  return path.join(os.homedir(), '.config', 'gmc', 'quick-actions.json');
}

function cloneAction(action) {
  var def = (action.builtinId && DEFAULT_ACTIONS_MAP[action.builtinId]) || DEFAULT_ACTIONS_MAP[action.id] || null;
  var command = (action.command !== undefined && action.command !== null && String(action.command) !== '')
    ? String(action.command)
    : (def ? def.command : '');
  var args = (action.args !== undefined && action.args !== null && String(action.args) !== '')
    ? String(action.args)
    : (def ? def.args : '');
  var appPath = (action.appPath !== undefined && action.appPath !== null && String(action.appPath) !== '')
    ? String(action.appPath)
    : (def ? def.appPath : '');
  var runInTerminal = (action.runInTerminal !== undefined && action.runInTerminal !== null)
    ? Boolean(action.runInTerminal)
    : (def ? def.runInTerminal : false);

  var cloned = {
    id: String(action.id || ''),
    name: String(action.name || (def ? def.name : '')),
    type: String(action.type || (def ? def.type : 'app')),
    appPath: appPath,
    command: command,
    args: args,
    runInTerminal: runInTerminal,
    icon: action.icon ? String(action.icon) : (def ? def.icon : 'app'),
    enabled: action.enabled !== false
  };
  if (action.builtinId) {
    cloned.builtinId = String(action.builtinId);
  }
  return cloned;
}

function getDefaultQuickActions() {
  return DEFAULT_QUICK_ACTIONS.map(cloneAction);
}

function readConfigFile(customPath) {
  var file = configFilePath(customPath);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    var raw = fs.readFileSync(file, 'utf8');
    var parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed && Array.isArray(parsed.actions)) {
      return parsed.actions;
    }
    return null;
  } catch (error) {
    return null;
  }
}

function writeConfigFile(actions, customPath) {
  var file = configFilePath(customPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(actions, null, 2) + '\n');
  return actions;
}

function listQuickActions(options) {
  options = options || {};
  var stored = readConfigFile(options.configPath);
  if (!stored) {
    return getDefaultQuickActions();
  }
  return stored.map(cloneAction);
}

function saveQuickActions(actions, options) {
  options = options || {};
  if (!Array.isArray(actions)) {
    throw new TypeError('Actions must be an array');
  }
  var sanitized = actions.map(function (item, index) {
    if (!item || typeof item !== 'object') {
      throw new TypeError('Action item at index ' + index + ' must be an object');
    }
    var id = String(item.id || ('qa_' + Date.now() + '_' + index)).trim();
    var name = String(item.name || '').trim();
    if (!name) {
      name = 'Action ' + (index + 1);
    }
    var type = String(item.type || 'app').trim();
    var result = {
      id: id,
      name: name,
      type: type,
      appPath: item.appPath ? String(item.appPath).trim() : '',
      command: item.command ? String(item.command).trim() : '',
      args: item.args ? String(item.args).trim() : '',
      runInTerminal: Boolean(item.runInTerminal),
      icon: item.icon ? String(item.icon).trim() : 'app',
      enabled: item.enabled !== false
    };
    if (item.builtinId) {
      result.builtinId = String(item.builtinId).trim();
    }
    return result;
  });
  writeConfigFile(sanitized, options.configPath);
  return sanitized;
}

function resetQuickActions(options) {
  options = options || {};
  var defaults = getDefaultQuickActions();
  writeConfigFile(defaults, options.configPath);
  return defaults;
}

function extractAppIcon(appPath) {
  if (process.platform !== 'darwin' || !appPath) return null;
  var resolved = path.resolve(String(appPath).trim());
  if (!fs.existsSync(resolved)) {
    var candidates = [
      path.join('/Applications', appPath + '.app'),
      path.join('/Applications', appPath),
      path.join('/System/Applications', appPath + '.app'),
      path.join('/System/Applications/Utilities', appPath + '.app')
    ];
    for (var c = 0; c < candidates.length; c++) {
      if (fs.existsSync(candidates[c])) {
        resolved = candidates[c];
        break;
      }
    }
  }
  if (!fs.existsSync(resolved)) return null;

  var appBase = path.basename(resolved).replace(/\.app$/i, '');
  var safeName = appBase.replace(/[^a-zA-Z0-9_\-\.]/g, '_').toLowerCase();
  var iconCacheDir = path.join(os.homedir(), '.config', 'gmc', 'icons');
  try {
    fs.mkdirSync(iconCacheDir, { recursive: true });
  } catch (e) {}

  var cacheFile = path.join(iconCacheDir, safeName + '.png');
  if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 0) {
    return '/api/app-icon?name=' + encodeURIComponent(safeName);
  }

  // 1. Try finding .icns in Contents/Resources
  var icnsPath = null;
  var plistPath = path.join(resolved, 'Contents', 'Info.plist');
  if (fs.existsSync(plistPath)) {
    try {
      var plRes = childProcess.spawnSync('plutil', ['-extract', 'CFBundleIconFile', 'raw', '-o', '-', plistPath], { encoding: 'utf8' });
      if (!plRes.error && plRes.status === 0 && plRes.stdout && plRes.stdout.trim()) {
        var iconFile = plRes.stdout.trim();
        if (!iconFile.endsWith('.icns')) iconFile += '.icns';
        var cand = path.join(resolved, 'Contents', 'Resources', iconFile);
        if (fs.existsSync(cand)) icnsPath = cand;
      }
    } catch (err) {}
  }

  if (!icnsPath) {
    var resDir = path.join(resolved, 'Contents', 'Resources');
    if (fs.existsSync(resDir)) {
      try {
        var entries = fs.readdirSync(resDir);
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].toLowerCase().endsWith('.icns')) {
            icnsPath = path.join(resDir, entries[i]);
            break;
          }
        }
      } catch (e) {}
    }
  }

  if (icnsPath) {
    try {
      var sipsRes = childProcess.spawnSync('sips', ['-s', 'format', 'png', icnsPath, '-Z', '64', '--out', cacheFile], { encoding: 'utf8' });
      if (!sipsRes.error && sipsRes.status === 0 && fs.existsSync(cacheFile)) {
        return '/api/app-icon?name=' + encodeURIComponent(safeName);
      }
    } catch (e) {}
  }

  // 2. Fallback: Cocoa NSWorkspace via swift
  try {
    var swiftScript = 'import Cocoa; let p = CommandLine.arguments[1]; let o = CommandLine.arguments[2]; let i = NSWorkspace.shared.icon(forFile: p); i.size = NSSize(width: 64, height: 64); if let t = i.tiffRepresentation, let r = NSBitmapImageRep(data: t), let b = r.representation(using: .png, properties: [:]) { try? b.write(to: URL(fileURLWithPath: o)) }';
    var swiftRes = childProcess.spawnSync('swift', ['-e', swiftScript, resolved, cacheFile], { encoding: 'utf8', timeout: 5000 });
    if (!swiftRes.error && swiftRes.status === 0 && fs.existsSync(cacheFile)) {
      return '/api/app-icon?name=' + encodeURIComponent(safeName);
    }
  } catch (e) {}

  return null;
}

function chooseAppPath() {
  return new Promise(function (resolve, reject) {
    if (process.platform !== 'darwin') {
      return reject(new Error('Choosing applications is only supported on macOS.'));
    }
    var script = [
      'try',
      '  set chosenItem to (choose file of type {"com.apple.application-bundle", "app"} default location (path to applications folder) with prompt "请选择要添加的应用程序")',
      '  return POSIX path of chosenItem',
      'on error',
      '  return ""',
      'end try'
    ].join('\n');

    childProcess.execFile('osascript', ['-e', script], { encoding: 'utf8' }, function (error, stdout, stderr) {
      if (error) {
        return resolve({ canceled: true });
      }
      var appPath = (stdout || '').trim();
      if (!appPath) {
        return resolve({ canceled: true });
      }
      var base = path.basename(appPath);
      var appName = base.replace(/\.app$/i, '');
      var extractedIcon = extractAppIcon(appPath);
      resolve({
        canceled: false,
        path: appPath,
        name: appName,
        icon: extractedIcon || 'app'
      });
    });
  });
}

function interpolatePlaceholders(str, repoRoot, branch) {
  str = String(str || '');
  return str
    .replace(/\{repo\}/gi, repoRoot)
    .replace(/\$REPO\b/g, repoRoot)
    .replace(/\{branch\}/gi, branch || '')
    .replace(/\$BRANCH\b/g, branch || '');
}

function parseCommandLineArgs(argString) {
  argString = (argString || '').trim();
  if (!argString) return [];
  var args = [];
  var regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  var match;
  while ((match = regex.exec(argString)) !== null) {
    if (match[1] !== undefined) {
      args.push(match[1]);
    } else if (match[2] !== undefined) {
      args.push(match[2]);
    } else {
      args.push(match[0]);
    }
  }
  return args;
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function launchCustomAction(action, repoRoot, branch, helpers) {
  repoRoot = path.resolve(repoRoot || process.cwd());
  helpers = helpers || {};
  var env = Object.assign({}, process.env);

  if (action.runInTerminal) {
    var cmdToRun = '';
    if (action.command) {
      var intCmd = interpolatePlaceholders(action.command, repoRoot, branch);
      var intArgs = interpolatePlaceholders(action.args, repoRoot, branch);
      cmdToRun = 'cd ' + shellQuote(repoRoot) + ' && ' + intCmd + (intArgs ? ' ' + intArgs : '');
    } else if (action.appPath) {
      var appTarget = interpolatePlaceholders(action.args || '{repo}', repoRoot, branch);
      cmdToRun = 'cd ' + shellQuote(repoRoot) + ' && open -a ' + shellQuote(action.appPath) + ' ' + appTarget;
    } else {
      throw new Error('No command or application path specified for this action');
    }
    if (typeof helpers.openTerminal === 'function') {
      return helpers.openTerminal(repoRoot, cmdToRun);
    }
    throw new Error('Terminal opener not configured');
  }

  // Not in terminal:
  if (action.type === 'app' || action.appPath) {
    if (process.platform === 'darwin') {
      var openArgs = ['-a', action.appPath];
      if (action.args && action.args.trim()) {
        var parsedArgs = parseCommandLineArgs(interpolatePlaceholders(action.args, repoRoot, branch));
        openArgs = openArgs.concat(parsedArgs);
      } else {
        openArgs.push(repoRoot);
      }
      var res = childProcess.spawnSync('open', openArgs, { env: env, encoding: 'utf8' });
      if (res.error || res.status !== 0) {
        var errMsg = (res.stderr || '').trim() || (res.error && res.error.message) || ('Exit code ' + res.status);
        throw new Error(errMsg || 'Failed to open application: ' + action.appPath);
      }
      return { status: 'ok', launched: action.name || action.appPath };
    } else {
      var proc = childProcess.spawn(action.appPath, parseCommandLineArgs(interpolatePlaceholders(action.args || '', repoRoot, branch)), {
        cwd: repoRoot,
        env: env,
        detached: true,
        stdio: 'ignore'
      });
      proc.unref();
      return { status: 'ok', launched: action.name || action.appPath };
    }
  }

  if (action.type === 'command' || action.command) {
    var cmd = interpolatePlaceholders(action.command, repoRoot, branch);
    var cmdArgs = parseCommandLineArgs(interpolatePlaceholders(action.args || '', repoRoot, branch));
    try {
      var commandProc = childProcess.spawn(cmd, cmdArgs, {
        cwd: repoRoot,
        env: env,
        detached: true,
        stdio: 'ignore'
      });
      commandProc.unref();
      return { status: 'ok', launched: action.name || cmd };
    } catch (spawnError) {
      throw new Error((spawnError && spawnError.message) || ('Failed to execute command: ' + cmd));
    }
  }

  throw new Error('Invalid action configuration: missing appPath or command');
}

module.exports = {
  DEFAULT_QUICK_ACTIONS: DEFAULT_QUICK_ACTIONS,
  getDefaultQuickActions: getDefaultQuickActions,
  configFilePath: configFilePath,
  readConfigFile: readConfigFile,
  writeConfigFile: writeConfigFile,
  listQuickActions: listQuickActions,
  saveQuickActions: saveQuickActions,
  resetQuickActions: resetQuickActions,
  chooseAppPath: chooseAppPath,
  interpolatePlaceholders: interpolatePlaceholders,
  parseCommandLineArgs: parseCommandLineArgs,
  launchCustomAction: launchCustomAction,
  extractAppIcon: extractAppIcon
};
