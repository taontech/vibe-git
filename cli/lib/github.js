'use strict';

var https = require('https');

function parseIssueRef(value) {
  var raw = String(value || '').trim();
  var match = raw.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)$/);
  if (match) {
    return {
      provider: 'github',
      owner: match[1],
      repo: match[2],
      number: Number(match[3]),
      ref: 'GH-' + match[3]
    };
  }

  match = raw.match(/^GH-(\d+)$/i);
  if (match) {
    return {
      provider: 'github',
      number: Number(match[1]),
      ref: 'GH-' + match[1]
    };
  }

  match = raw.match(/^#?(\d+)$/);
  if (match) {
    return {
      provider: 'github',
      number: Number(match[1]),
      ref: 'GH-' + match[1]
    };
  }

  throw new Error('Unsupported issue reference: ' + raw + '. Use GH-234, #234, 234, or a GitHub issue URL.');
}

function githubRequest(path, token) {
  return new Promise(function(resolve, reject) {
    var headers = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'gmc-cli',
      'X-GitHub-Api-Version': '2022-11-28'
    };

    if (token) {
      headers.Authorization = 'Bearer ' + token;
    }

    var request = https.request({
      hostname: 'api.github.com',
      path: path,
      method: 'GET',
      headers: headers
    }, function(response) {
      var chunks = '';
      response.setEncoding('utf8');
      response.on('data', function(chunk) {
        chunks += chunk;
      });
      response.on('end', function() {
        var json = chunks ? JSON.parse(chunks) : {};
        if (response.statusCode < 200 || response.statusCode >= 300) {
          var message = json && json.message ? json.message : chunks;
          reject(new Error('GitHub API request failed: ' + response.statusCode + ' ' + message));
          return;
        }
        resolve(json);
      });
    });

    request.on('error', reject);
    request.end();
  });
}

function fetchIssue(repo, number, token) {
  return githubRequest('/repos/' + encodeURIComponent(repo.owner) + '/' + encodeURIComponent(repo.repo) + '/issues/' + number, token)
    .then(function(issue) {
      return {
        provider: 'github',
        ref: 'GH-' + issue.number,
        number: issue.number,
        title: issue.title || '',
        body: issue.body || '',
        url: issue.html_url,
        labels: (issue.labels || []).map(function(label) {
          return typeof label === 'string' ? label : label.name;
        }).filter(Boolean),
        owner: repo.owner,
        repo: repo.repo
      };
    });
}

module.exports = {
  parseIssueRef: parseIssueRef,
  fetchIssue: fetchIssue
};
