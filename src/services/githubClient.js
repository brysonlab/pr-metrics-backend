const axios = require('axios');

const GITHUB_BASE_URL = 'https://api.github.com';

class GitHubClient {
  constructor(accessToken) {
    this.accessToken = accessToken;
    this.client = axios.create({
      baseURL: GITHUB_BASE_URL,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });
  }

  // Get authenticated user
  async getCurrentUser() {
    const { data } = await this.client.get('/user');
    return data;
  }

  // Get user repos
  async getRepos(page = 1, perPage = 30) {
    const { data } = await this.client.get('/user/repos', {
      params: { page, per_page: perPage, sort: 'updated' }
    });
    return data;
  }

  // Get a single repo
  async getRepo(owner, repo) {
    const { data } = await this.client.get(`/repos/${owner}/${repo}`);
    return data;
  }

  // Get pull requests for a repo
  async getPullRequests(owner, repo, state = 'all', page = 1, perPage = 30) {
    const { data } = await this.client.get(`/repos/${owner}/${repo}/pulls`, {
      params: { state, page, per_page: perPage }
    });
    return data;
  }

  // Get a single PR with reviews
  async getPullRequest(owner, repo, prNumber) {
    const { data } = await this.client.get(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
      params: { pull_number: prNumber }
    });
    return data;
  }

  // Get PR reviews
  async getPRReviews(owner, repo, prNumber) {
    const { data } = await this.client.get(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`);
    return data;
  }

  // Get PR comments (review comments, not issue comments)
  async getPRComments(owner, repo, prNumber) {
    const { data } = await this.client.get(`/repos/${owner}/${repo}/pulls/${prNumber}/comments`);
    return data;
  }

  // Get all issues (including PRs) for a repo
  async getIssues(owner, repo, since, perPage = 100) {
    const { data } = await this.client.get(`/repos/${owner}/${repo}/issues`, {
      params: { 
        since,
        per_page: perPage,
        state: 'all'
      }
    });
    return data;
  }

  // Search pull requests
  async searchPRs(query) {
    const { data } = await this.client.get('/search/issues', {
      params: { q: query }
    });
    return data;
  }

  // Get repo collaborators
  async getCollaborators(owner, repo) {
    const { data } = await this.client.get(`/repos/${owner}/${repo}/collaborators`);
    return data;
  }

  // Get commit comments for a repo
  async getCommitComments(owner, repo, ref) {
    const { data } = await this.client.get(`/repos/${owner}/${repo}/comments`, {
      params: { ref }
    });
    return data;
  }
}

module.exports = GitHubClient;
