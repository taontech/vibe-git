'use strict';

var SUBJECT_LIMIT = 72;

function prepare(message, binding) {
  var normalized = normalizeSubjectLimit(message);
  validate(normalized, binding);
  return normalized;
}

function normalizeSubjectLimit(message) {
  var original = String(message || '');
  var text = original.trim();
  if (!text) {
    return text;
  }

  var lines = text.split(/\r?\n/);
  var subject = collapseSpaces(lines[0]);
  if (subject.length <= SUBJECT_LIMIT) {
    lines[0] = subject;
    return lines.join('\n') + '\n';
  }

  var shortSubject = shortenSubject(subject, SUBJECT_LIMIT);
  var detail = cleanRemainder(subject.slice(shortSubject.length));
  var bodyLines = lines.slice(1);
  while (bodyLines.length && !bodyLines[0].trim()) {
    bodyLines.shift();
  }

  var output = [shortSubject];
  if (detail) {
    output.push('', 'Also covers: ' + withTerminalPeriod(detail));
  }
  if (bodyLines.length) {
    output.push('');
    output = output.concat(bodyLines);
  }
  return output.join('\n') + '\n';
}

function validate(message, binding) {
  var text = String(message || '').trim();
  var firstLine = text.split(/\r?\n/)[0] || '';
  var forbiddenPatterns = [
    /OpenAI Codex/i,
    /User instructions:/i,
    /Staged diff:/i,
    /Committed diff:/i,
    /stream error:/i,
    /\bERROR:/i,
    /unexpected status \d+/i,
    /^-{8,}$/m,
    /^\[\d{4}-\d{2}-\d{2}T/m
  ];

  if (!text) {
    throw new Error('Codex returned an empty commit message.');
  }
  if (binding && text.indexOf('Issue: ' + binding.issue) < 0) {
    throw new Error('Generated commit message is missing required trailer: Issue: ' + binding.issue);
  }
  if (firstLine.length > SUBJECT_LIMIT) {
    throw new Error('Generated commit subject is longer than ' + SUBJECT_LIMIT + ' characters: ' + firstLine);
  }
  forbiddenPatterns.forEach(function (pattern) {
    if (pattern.test(text)) {
      throw new Error('Generated commit message looks like Codex logs instead of a commit message. Aborting.');
    }
  });
}

function shortenSubject(subject, limit) {
  var compact = collapseSpaces(subject);
  var connectorPattern = /\s+(with|and|for|to|using|via|including|plus|while|that|by)\s+/gi;
  var minimumLength = minimumSubjectLength(compact);
  var match;

  while ((match = connectorPattern.exec(compact)) !== null) {
    var candidate = trimTrailingPunctuation(compact.slice(0, match.index));
    if (candidate.length >= minimumLength && candidate.length <= limit) {
      return candidate;
    }
  }

  var clipped = compact.slice(0, limit + 1);
  var lastSpace = clipped.lastIndexOf(' ');
  if (lastSpace >= minimumLength) {
    return trimTrailingPunctuation(compact.slice(0, lastSpace));
  }
  return trimTrailingPunctuation(compact.slice(0, limit));
}

function minimumSubjectLength(subject) {
  var match = subject.match(/^[a-z]+(?:\([^)]+\))?!?:\s*/i);
  return (match ? match[0].length : 0) + 12;
}

function collapseSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanRemainder(value) {
  return trimLeadingPunctuation(collapseSpaces(value))
    .replace(/^(with|and|for|to|using|via|including|plus|while|that|by)\s+/i, '')
    .trim();
}

function trimLeadingPunctuation(value) {
  return String(value || '').replace(/^[\s,;:.-]+/, '');
}

function trimTrailingPunctuation(value) {
  return String(value || '').replace(/[\s,;:.-]+$/, '');
}

function withTerminalPeriod(value) {
  if (/[.!?]$/.test(value)) {
    return value;
  }
  return value + '.';
}

module.exports = {
  SUBJECT_LIMIT: SUBJECT_LIMIT,
  prepare: prepare,
  normalizeSubjectLimit: normalizeSubjectLimit,
  validate: validate
};
