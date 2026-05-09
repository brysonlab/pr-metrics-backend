const test = require('node:test');
const assert = require('node:assert');
const GitHubClient = require('../src/services/githubClient');

test('GitHubClient', async (t) => {
  const token = 'fake-token';
  const client = new GitHubClient(token);

  await t.test('constructor should set up axios correctly', () => {
    assert.strictEqual(client.accessToken, token);
    assert.strictEqual(client.client.defaults.baseURL, 'https://api.github.com');
  });

  await t.test('getCurrentUser should call /user', async (st) => {
    // Mocking axios call
    const originalGet = client.client.get;
    client.client.get = async (url) => {
      if (url === '/user') return { data: { id: 123, login: 'testuser' } };
      throw new Error('Wrong URL');
    };

    const user = await client.getCurrentUser();
    assert.strictEqual(user.id, 123);
    assert.strictEqual(user.login, 'testuser');
    
    client.client.get = originalGet;
  });

  await t.test('should handle rate limiting (403)', async () => {
    const originalGet = client.client.get;
    client.client.get = async () => {
      const error = new Error('Request failed with status code 403');
      error.response = {
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': (Math.floor(Date.now() / 1000) + 3600).toString()
        }
      };
      throw error;
    };

    try {
      await client.getCurrentUser();
      assert.fail('Should have thrown an error');
    } catch (err) {
      assert.strictEqual(err.response.status, 403);
      assert.strictEqual(err.response.headers['x-ratelimit-remaining'], '0');
    } finally {
      client.client.get = originalGet;
    }
  });
});
