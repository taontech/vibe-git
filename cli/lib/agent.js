'use strict';

var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var codexExecHelpCache = null;
var DEFAULT_CODEX_TIMEOUT_MS = 10 * 60 * 1000;
var CLAUDE_TEXT_SYSTEM_PROMPT = [
  'Generate only the requested text response.',
  'Do not inspect the repository, use tools, load project instructions, or explain your work.',
  'Follow the user prompt exactly.'
].join(' ');

function spawnInherited(command, args, cwd) {
  var result = childProcess.spawnSync(command, args, {
    cwd: cwd,
    stdio: 'inherit'
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(command + ' exited with status ' + result.status);
  }
}

function interactiveInvocation(selectedAgent, cwd, prompt) {
  var args = [];
  selectedAgent = selectedAgent || 'codex';

  if (selectedAgent === 'codex') {
    args = ['--cd', cwd];
    if (prompt) args.push(prompt);
    return { command: 'codex', args: args };
  }
  if (selectedAgent === 'claude') {
    if (prompt) args.push(prompt);
    return { command: 'claude', args: args };
  }
  if (selectedAgent === 'antigravity') {
    if (prompt) args = ['--prompt-interactive', prompt];
    return { command: 'agy', args: args };
  }
  if (selectedAgent === 'opencode') {
    if (prompt) args.push(prompt);
    return { command: 'opencode', args: args };
  }

  throw new Error('Unsupported agent: ' + selectedAgent + '. Use codex, claude, antigravity or opencode.');
}

function launchAgent(options) {
  var agent = options.agent || 'codex';
  var cwd = options.cwd || process.cwd();
  var prompt = options.prompt;

  if (options.dryRun) {
    process.stdout.write(prompt + '\n');
    return;
  }

  if (agent === 'codex') {
    if (options.execMode) {
      var result = childProcess.spawnSync('codex', ['exec', '--cd', cwd, '-'], {
        cwd: cwd,
        input: prompt,
        stdio: ['pipe', 'inherit', 'inherit']
      });
      if (result.error) {
        throw result.error;
      }
      if (result.status !== 0) {
        throw new Error('codex exited with status ' + result.status);
      }
    } else {
      var codexInvocation = interactiveInvocation(agent, cwd, prompt);
      spawnInherited(codexInvocation.command, codexInvocation.args, cwd);
    }
    return;
  }

  if (agent === 'claude') {
    if (options.execMode) {
      spawnInherited('claude', ['-p', prompt], cwd);
    } else {
      var claudeInvocation = interactiveInvocation(agent, cwd, prompt);
      spawnInherited(claudeInvocation.command, claudeInvocation.args, cwd);
    }
    return;
  }

  if (agent === 'antigravity') {
    var antigravityInvocation = interactiveInvocation(agent, cwd, prompt);
    spawnInherited(antigravityInvocation.command, antigravityInvocation.args, cwd);
    return;
  }

  if (agent === 'opencode') {
    var opencodeInvocation = interactiveInvocation(agent, cwd, prompt);
    spawnInherited(opencodeInvocation.command, opencodeInvocation.args, cwd);
    return;
  }

  throw new Error('Unsupported agent: ' + agent + '. Use codex, claude, antigravity or opencode.');
}

function generateText(prompt, cwd, selectedAgent, options) {
  selectedAgent = selectedAgent || 'codex';
  options = options || {};
  if (selectedAgent === 'codex') {
    return generateCodexText(prompt, cwd, options);
  }
  if (selectedAgent === 'claude') {
    return generateClaudeText(prompt, cwd);
  }
  if (selectedAgent === 'antigravity') {
    return generateAntigravityText(prompt, cwd);
  }
  if (selectedAgent === 'opencode') {
    return generateOpencodeText(prompt, cwd);
  }
  throw new Error('Unsupported agent: ' + selectedAgent + '. Use codex, claude, antigravity or opencode.');
}

function generateCodexText(prompt, cwd, options) {
  var outputFile = path.join(os.tmpdir(), (options.outputPrefix || 'gmc-agent-output') + '-' + Date.now() + '-' + process.pid + '.txt');
  var description = options.description || 'generation';
  var help = codexExecHelp();
  var timeoutMs = codexTimeoutMs();
  var args = [
    'exec',
    '--cd', cwd,
    '--sandbox', 'read-only',
    '--color', 'never'
  ];

  if (help.indexOf('--ignore-user-config') >= 0) {
    args.push('--ignore-user-config');
  }
  if (process.env.GMC_CODEX_MODEL) {
    args.push('--model', process.env.GMC_CODEX_MODEL);
  }
  if (help.indexOf('--output-last-message') >= 0) {
    args.push('--output-last-message', outputFile);
  }

  args.push('-');

  var result = childProcess.spawnSync('codex', args, {
    cwd: cwd,
    encoding: 'utf8',
    input: prompt,
    timeout: timeoutMs,
    killSignal: 'SIGTERM'
  });

  if (result.error) {
    removeOutputFile(outputFile);
    if (result.error.code === 'ETIMEDOUT') {
      throw new Error('codex ' + description + ' timed out after ' + Math.round(timeoutMs / 1000) + 's');
    }
    throw result.error;
  }
  if (result.status !== 0) {
    removeOutputFile(outputFile);
    throw new Error('codex ' + description + ' failed with status ' + result.status + ': ' + commandOutput(result));
  }

  if (fs.existsSync(outputFile)) {
    var finalMessage = fs.readFileSync(outputFile, 'utf8');
    removeOutputFile(outputFile);
    return cleanAgentOutput(finalMessage);
  }

  return cleanAgentOutput(result.stdout);
}

function generateClaudeText(prompt, cwd) {
  var result = childProcess.spawnSync('claude', [
    '-p',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--tools', '',
    '--system-prompt', CLAUDE_TEXT_SYSTEM_PROMPT
  ], {
    cwd: cwd,
    encoding: 'utf8',
    input: prompt,
    timeout: codexTimeoutMs(),
    killSignal: 'SIGTERM'
  });
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      throw new Error('claude generation timed out after ' + Math.round(codexTimeoutMs() / 1000) + 's');
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error('claude generation failed with status ' + result.status + ': ' + commandOutput(result));
  }
  return cleanAgentOutput(result.stdout);
}

function generateAntigravityText(prompt, cwd) {
  var result = childProcess.spawnSync('agy', ['--prompt', prompt], {
    cwd: cwd,
    encoding: 'utf8',
    timeout: codexTimeoutMs(),
    killSignal: 'SIGTERM'
  });
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      throw new Error('antigravity generation timed out after ' + Math.round(codexTimeoutMs() / 1000) + 's');
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error('antigravity generation failed with status ' + result.status + ': ' + commandOutput(result));
  }
  return cleanAgentOutput(result.stdout);
}

function generateOpencodeText(prompt, cwd) {
  var result = childProcess.spawnSync('opencode', ['run', prompt], {
    cwd: cwd,
    encoding: 'utf8',
    timeout: codexTimeoutMs(),
    killSignal: 'SIGTERM'
  });
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      throw new Error('opencode generation timed out after ' + Math.round(codexTimeoutMs() / 1000) + 's');
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error('opencode generation failed with status ' + result.status + ': ' + commandOutput(result));
  }
  return cleanAgentOutput(result.stdout);
}

function generateCommitMessage(prompt, cwd) {
  return cleanCommitMessage(generateText(prompt, cwd, 'codex', {
    outputPrefix: 'gmc-commit-message',
    description: 'commit message generation'
  }));
}

function codexTimeoutMs() {
  var raw = process.env.GMC_CODEX_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_CODEX_TIMEOUT_MS;
  }
  var parsed = Number(raw);
  if (!isFinite(parsed) || parsed <= 0) {
    return DEFAULT_CODEX_TIMEOUT_MS;
  }
  return Math.round(parsed);
}

function commandOutput(result) {
  var output = ((result.stderr || '') + '\n' + (result.stdout || '')).trim();
  if (!output) {
    return '(no stderr/stdout captured)';
  }
  if (output.length > 4000) {
    return output.slice(0, 4000) + '\n[output truncated by gmc]';
  }
  return output;
}

function removeOutputFile(outputFile) {
  try {
    fs.unlinkSync(outputFile);
  } catch (error) {
    // Best effort cleanup only.
  }
}

function codexExecHelp() {
  if (codexExecHelpCache !== null) {
    return codexExecHelpCache;
  }
  var result = childProcess.spawnSync('codex', ['exec', '--help'], {
    encoding: 'utf8'
  });
  codexExecHelpCache = (result.stdout || '') + (result.stderr || '');
  return codexExecHelpCache;
}

function cleanCommitMessage(message) {
  return cleanAgentOutput(message).trim() + '\n';
}

function cleanAgentOutput(message) {
  return String(message || '')
    .replace(/^```(?:text|json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

module.exports = {
  launchAgent: launchAgent,
  interactiveInvocation: interactiveInvocation,
  generateText: generateText,
  generateCommitMessage: generateCommitMessage,
  codexTimeoutMs: codexTimeoutMs
};
