import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMessages,
  chatCompletionsUrl,
  languageName,
  parseTranslations,
  requestTranslations,
} from '../src/lib/llm.js';

const settings = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-secret-key',
  model: 'test-model',
  targetLang: 'ko',
  extraPrompt: '',
};

const okResponse = (content) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => ({ choices: [{ message: { content } }] }),
});

const errorResponse = (status, body, headers = {}) => ({
  ok: false,
  status,
  headers: new Headers(headers),
  text: async () => JSON.stringify(body),
});

const noSleep = async () => {};

test('parseTranslations: bare array, fenced block, surrounding prose, wrapper object', () => {
  assert.deepEqual(parseTranslations('["a","b"]', 2), ['a', 'b']);
  assert.deepEqual(parseTranslations('```json\n["a","b"]\n```', 2), ['a', 'b']);
  assert.deepEqual(parseTranslations('Here you go: ["a","b"] Hope that helps', 2), ['a', 'b']);
  assert.deepEqual(parseTranslations('{"translations":["a","b"]}', 2), ['a', 'b']);
  assert.deepEqual(parseTranslations('["a", 2]', 2), ['a', '2']);
});

test('parseTranslations: rejects wrong length or non-string items', () => {
  assert.equal(parseTranslations('["a"]', 2), null);
  assert.equal(parseTranslations('["a",null]', 2), null);
  assert.equal(parseTranslations('not json', 1), null);
  assert.equal(parseTranslations(undefined, 1), null);
});

test('languageName gives English names for the prompt', () => {
  assert.equal(languageName('ko'), 'Korean');
  assert.equal(languageName('zh-CN'), 'Simplified Chinese');
  assert.equal(languageName('zh-TW'), 'Traditional Chinese');
});

test('buildMessages embeds language, rules, extra prompt and the texts as JSON', () => {
  const messages = buildMessages(['Hello', 'World'], { targetLang: 'ko', extraPrompt: 'Be formal.' });
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /into Korean/);
  assert.match(messages[0].content, /Be formal\./);
  assert.match(messages[0].content, /untrusted/);
  assert.deepEqual(JSON.parse(messages[1].content), ['Hello', 'World']);
});

test('chatCompletionsUrl', () => {
  assert.equal(chatCompletionsUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(chatCompletionsUrl('http://localhost:11434/v1/'), 'http://localhost:11434/v1/chat/completions');
  assert.equal(
    chatCompletionsUrl('https://x.test/v1/chat/completions'),
    'https://x.test/v1/chat/completions',
  );
});

test('requestTranslations sends an authenticated chat completion request', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return okResponse('["안녕","세계"]');
  };
  const result = await requestTranslations(['Hello', 'World'], settings, { fetchImpl });
  assert.deepEqual(result, ['안녕', '세계']);
  assert.equal(seen.url, 'https://api.example.com/v1/chat/completions');
  assert.equal(seen.init.headers.Authorization, 'Bearer sk-secret-key');
  assert.equal(seen.body.model, 'test-model');
  assert.equal(seen.body.stream, false);
});

test('requestTranslations sends no Authorization header without an API key', async () => {
  let headers;
  const fetchImpl = async (url, init) => {
    headers = init.headers;
    return okResponse('["x"]');
  };
  await requestTranslations(['y'], { ...settings, apiKey: '' }, { fetchImpl });
  assert.equal('Authorization' in headers, false);
});

test('falls back to one request per item when the model breaks the 1:1 contract', async () => {
  const replies = ['["only one"]', '["하나"]', '["둘"]'];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(JSON.parse(init.body).messages[1].content));
    return okResponse(replies.shift());
  };
  const result = await requestTranslations(['one', 'two'], settings, { fetchImpl });
  assert.deepEqual(result, ['하나', '둘']);
  assert.deepEqual(calls, [['one', 'two'], ['one'], ['two']]);
});

test('a single item may come back as plain text', async () => {
  const fetchImpl = async () => okResponse('"안녕하세요"');
  assert.deepEqual(await requestTranslations(['Hello'], settings, { fetchImpl }), ['안녕하세요']);
});

test('retries 429 and 5xx, then succeeds', async () => {
  const responses = [errorResponse(429, { error: { message: 'slow down' } }), errorResponse(503, {}), okResponse('["ok"]')];
  let sleeps = 0;
  const result = await requestTranslations(['x'], settings, {
    fetchImpl: async () => responses.shift(),
    sleep: async () => {
      sleeps++;
    },
  });
  assert.deepEqual(result, ['ok']);
  assert.equal(sleeps, 2);
});

test('does not retry 401 and reports the API message without leaking the key', async () => {
  let calls = 0;
  await assert.rejects(
    requestTranslations(['x'], settings, {
      fetchImpl: async () => {
        calls++;
        return errorResponse(401, { error: { message: 'Incorrect API key provided' } });
      },
      sleep: noSleep,
    }),
    (err) => {
      assert.match(err.message, /^HTTP 401: Incorrect API key provided/);
      assert.ok(!err.message.includes('sk-secret-key'));
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('network failures are retried and then surfaced', async () => {
  let calls = 0;
  await assert.rejects(
    requestTranslations(['x'], settings, {
      fetchImpl: async () => {
        calls++;
        throw new TypeError('Failed to fetch');
      },
      sleep: noSleep,
    }),
    /Network error: Failed to fetch/,
  );
  assert.equal(calls, 3);
});
