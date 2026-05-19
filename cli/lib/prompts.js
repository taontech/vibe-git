'use strict';

function createdByLine(agent) {
  var name = String(agent || 'codex').toLowerCase();
  if (name === 'claude') {
    return 'claude created';
  }
  return 'codex created';
}

function appendCreatedBy(message, agent) {
  var text = String(message || '')
    .replace(/\n+(codex|claude) created\s*$/i, '')
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

function commitMessagePrompt(binding, diff, status, recentSubjects, options) {
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
    '- Mention only changes visible in the ' + changeDescription + '.',
    '- Match the repository style suggested by recent commit subjects.'
  ];
  var sections = [
    'Generate a clear Git commit message for the ' + changeDescription + '.',
    '',
    'Rules:'
  ].concat(rules);

  if (binding) {
    sections.push('- Include this trailer exactly: Issue: ' + binding.issue);
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
    'Recent commit subjects:',
    recentSubjects || '(none)',
    '',
    'Git status:',
    status || '(clean)',
    '',
    diffLabel + ':',
    diff
  ]).join('\n');
}

function taskStatusPrompt(tasks, diff, status) {
  return [
    'Decide whether this Git commit should update repository task statuses.',
    '',
    'You will receive the current task list and the staged commit diff.',
    'Return JSON only. Do not use markdown.',
    '',
    'Rules:',
    '- Only update tasks clearly related to the diff.',
    '- Use status "doing" when the diff starts or partially implements a task but does not clearly finish it.',
    '- Use status "review" when the diff appears implemented but still needs review or verification.',
    '- Use status "done" when the diff clearly completes the task.',
    '- Do not move a task backward, for example from done to doing.',
    '- Do not change unrelated tasks.',
    '- If no task should change, return {"updates":[]}.',
    '',
    'Allowed statuses: todo, doing, review, done.',
    'Schema: {"updates":[{"id":"GMC-0001","status":"doing","reason":"short reason"}]}',
    '',
    'Current tasks:',
    JSON.stringify(tasks || [], null, 2),
    '',
    'Git status:',
    status || '(clean)',
    '',
    'Staged diff:',
    diff || '(empty)'
  ].join('\n');
}

module.exports = {
  issuePrompt: issuePrompt,
  commitMessagePrompt: commitMessagePrompt,
  taskStatusPrompt: taskStatusPrompt,
  createdByLine: createdByLine,
  appendCreatedBy: appendCreatedBy
};
