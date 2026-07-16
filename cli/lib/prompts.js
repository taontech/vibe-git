'use strict';

var LANGUAGE_NAMES = {
  'zh-CN': 'Chinese (Simplified)',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  es: 'Spanish',
  fr: 'French'
};

function createdByLine(agent) {
  var name = String(agent || 'codex').toLowerCase();
  if (name === 'claude') {
    return 'claude created';
  }
  if (name === 'antigravity') {
    return 'antigravity created';
  }
  if (name === 'opencode') {
    return 'opencode created';
  }
  return 'codex created';
}

function appendCreatedBy(message, agent) {
  var text = String(message || '')
    .replace(/\n+(codex|claude|antigravity|opencode) created\s*$/i, '')
    .trim();
  return text + '\n\n' + createdByLine(agent) + '\n';
}

function issuePrompt(issue) {
  return [
    'You are starting work on GitHub issue ' + issue.ref + '.',
    '',
    'Issue title:',
    issue.title,
    '',
    'Issue body:',
    issue.body || '(empty)',
    '',
    'Repository instructions:',
    '- Keep changes scoped to this issue.',
    '- Follow existing project patterns.',
    '- Do not create a commit unless explicitly requested.',
    '- If the issue is ambiguous, stop and ask concise questions.',
    '- When finished, summarize changed files and important decisions.',
    '',
    'Commit requirement:',
    'Future commit messages must include this trailer:',
    'Issue: ' + issue.ref
  ].join('\n');
}

function taskPrompt(task) {
  var taskPath = task.path || '.gmc/tasks/' + task.id + '.md';
  return 'Start development work on repository task ' + task.id + '. ' +
    'Read ' + taskPath + ' as the complete task specification, then implement it. ' +
    'Follow the repository instructions and existing patterns, verify the result, ' +
    'do not commit unless explicitly requested, and summarize the completed work.' +
    'Modify the task status to "done" after the task is completed.';
}

function commitMessagePrompt(binding, diff, status, options) {
  options = options || {};
  var changeDescription = options.changeDescription || 'staged changes';
  var diffLabel = options.diffLabel || 'Staged diff';
  var rules = [
    '- First line must be 72 characters or fewer.',
    '- Use a concise subject, then add a body that explains the concrete details.',
    '- Do not use vague summaries like "update version" when the diff shows specifics.',
    '- Include important before -> after values visible in the diff, such as version numbers, renamed paths, changed defaults, flags, or config values.',
    '- Describe each distinct feature, behavior, or config change in about 2-3 short body lines.',
    '- Aim for at most 20 non-empty lines total, but exceed that when needed to make a large change understandable.',
    '- Use imperative mood.',
    '- Mention only changes visible in the ' + changeDescription + '.'
  ];
  var sections = [
    'Generate a clear Git commit message for the ' + changeDescription + '.',
    '',
    'Rules:'
  ].concat(rules);

  if (binding) {
    sections.push('- Include this trailer exactly: Issue: ' + binding.issue);
  }
  if (options.language && options.language !== 'en') {
    var langName = LANGUAGE_NAMES[options.language] || options.language;
    sections.push('- IMPORTANT: Output the commit message in ' + langName + '.');
  }
  sections.push('- Output only the commit message. Do not use markdown.');

  if (binding) {
    sections = sections.concat([
      '',
      'Bound issue:',
      'Title: ' + (binding.title || ''),
      'URL: ' + (binding.url || '')
    ]);
  }

  return sections.concat([
    '',
    'Git status:',
    status || '(clean)',
    '',
    diffLabel + ':',
    diff
  ]).join('\n');
}

function commitMessagePlanPrompt(binding, diff, status, tasks, options) {
  options = options || {};
  var changeDescription = options.changeDescription || 'staged changes';
  var diffLabel = options.diffLabel || 'Staged diff';
  var sections = [
    'Generate a clear Git commit message and decide whether this commit should update repository task statuses.',
    '',
    'Return JSON only. Do not use markdown or code fences.',
    'Schema: {"message":"commit subject\\n\\ncommit body","taskUpdates":[{"id":"GMC-0001","status":"doing","reason":"short reason"}]}',
    '',
    'Commit message rules:',
    '- The message field must contain only the commit message text.',
    '- First line must be 72 characters or fewer.',
    '- Use a concise subject, then add a body that explains the concrete details.',
    '- Do not use vague summaries like "update version" when the diff shows specifics.',
    '- Include important before -> after values visible in the diff, such as version numbers, renamed paths, changed defaults, flags, or config values.',
    '- Describe each distinct feature, behavior, or config change in about 2-3 short body lines.',
    '- Aim for at most 20 non-empty message lines total, but exceed that when needed to make a large change understandable.',
    '- Use imperative mood.',
    '- Mention only changes visible in the ' + changeDescription + '.',
  ];
  if (binding) {
    sections.push('- Include this trailer exactly in the message field: Issue: ' + binding.issue);
  }
  if (options.language && options.language !== 'en') {
    var langName = LANGUAGE_NAMES[options.language] || options.language;
    sections.push('- IMPORTANT: Output the commit message (the "message" field) in ' + langName + '. The "reason" fields should also be in ' + langName + '.');
  }
  sections = sections.concat([
    '',
    'Task status rules:',
    '- Only update tasks clearly related to the diff.',
    '- Use status "doing" when the diff starts or partially implements a task but does not clearly finish it.',
    '- Use status "review" when the diff appears implemented but still needs review or verification.',
    '- Use status "done" when the diff clearly completes the task.',
    '- Do not move a task backward, for example from done to doing.',
    '- Do not change unrelated tasks.',
    '- If no task should change, use an empty taskUpdates array.',
    '- Allowed task statuses: todo, doing, review, done.',
    ''
  ]);
  if (binding) {
    sections = sections.concat([
      '',
      'Bound issue:',
      'Title: ' + (binding.title || ''),
      'URL: ' + (binding.url || '')
    ]);
  }
  return sections.concat([
    '',
    'Current tasks:',
    JSON.stringify(tasks || [], null, 2),
    '',
    'Git status:',
    status || '(clean)',
    '',
    diffLabel + ':',
    diff || '(empty)'
  ]).join('\n');
}

function mergeConflictPrompt(options) {
  return [
    'You are resolving a Git merge conflict.',
    '',
    'File: ' + options.filePath,
    'Current branch: ' + options.branch,
    'Merging branch: ' + options.mergeBranch,
    '',
    'Instructions:',
    '- Analyze the conflict below and produce a clean resolved file.',
    '- Use the base version (common ancestor) as context to understand what changed on each side.',
    '- Preserve the intent of changes from both sides when possible.',
    '- Remove ALL conflict markers (<<<<<<<, =======, >>>>>>>).',
    '- Keep the file syntactically valid.',
    '- When changes genuinely conflict, choose the correct side based on context.',
    '- Output ONLY the resolved file content. Do not use markdown, code fences, or explanation.',
    '',
    'Ours (HEAD):',
    '----------------------------------------',
    (options.ours || '(empty file)'),
    '',
    'Theirs (incoming):',
    '----------------------------------------',
    (options.theirs || '(empty file)'),
    '',
    'Base (common ancestor):',
    '----------------------------------------',
    (options.base || '(empty or no base)'),
    '',
    'Conflicted file (with markers):',
    '----------------------------------------',
    (options.conflicted || '(empty)')
  ].join('\n');
}

module.exports = {
  issuePrompt: issuePrompt,
  taskPrompt: taskPrompt,
  commitMessagePrompt: commitMessagePrompt,
  commitMessagePlanPrompt: commitMessagePlanPrompt,
  mergeConflictPrompt: mergeConflictPrompt,
  createdByLine: createdByLine,
  appendCreatedBy: appendCreatedBy
};
