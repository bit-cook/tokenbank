'use strict';

const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  flattenToTurn,
  flattenToPrompt,
  MAX_INPUT_IMAGES,
  IMAGE_ONLY_PROMPT,
} = require('../chatgpt-web/server');
const { materializeImages } = require('../chatgpt-web/host');

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('flattenToTurn：纯文本仍拼成一条 prompt', () => {
  const t = flattenToTurn({
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
    ],
  });
  assert.equal(t.images.length, 0);
  assert.equal(t.prompt, '你是助手\n\n你好');
  assert.equal(flattenToPrompt({ messages: [{ role: 'user', content: 'hi' }] }), 'hi');
});

test('flattenToTurn：Chat Completions image_url 进入 images，不丢进文本', () => {
  const t = flattenToTurn({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这是什么' },
        { type: 'image_url', image_url: { url: TINY_PNG } },
      ],
    }],
  });
  assert.equal(t.prompt, '这是什么');
  assert.equal(t.images.length, 1);
  assert.equal(t.images[0].url, TINY_PNG);
});

test('flattenToTurn：Responses input_image（string / 对象）', () => {
  const t = flattenToTurn({
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: '看图' },
          { type: 'input_image', image_url: TINY_PNG },
        ],
      },
    ],
  });
  assert.match(t.prompt, /看图/);
  assert.equal(t.images.length, 1);
  assert.equal(t.images[0].url, TINY_PNG);
});

test('flattenToTurn：Anthropic image.source.base64', () => {
  const t = flattenToTurn({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '描述' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
      ],
    }],
  });
  assert.equal(t.images[0].url, 'data:image/png;base64,AAA');
});

test('flattenToTurn：只有图时给默认提示', () => {
  const t = flattenToTurn({
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: TINY_PNG } }],
    }],
  });
  assert.equal(t.prompt, IMAGE_ONLY_PROMPT);
  assert.equal(t.images.length, 1);
});

test('flattenToTurn：超过上限只留最新图并加说明', () => {
  const content = [];
  for (let i = 0; i < MAX_INPUT_IMAGES + 3; i += 1) {
    content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,IMG${i}` } });
  }
  content.push({ type: 'text', text: '多图' });
  const t = flattenToTurn({ messages: [{ role: 'user', content }] });
  assert.equal(t.images.length, MAX_INPUT_IMAGES);
  assert.equal(t.images[0].url, 'data:image/png;base64,IMG3');
  assert.equal(t.images[MAX_INPUT_IMAGES - 1].url, `data:image/png;base64,IMG${MAX_INPUT_IMAGES + 2}`);
  assert.match(t.prompt, /有 3 张较早的图未附上/);
  assert.match(t.prompt, /多图/);
});

test('materializeImages：data URL 落成 png 临时文件', async () => {
  const staged = await materializeImages([{ url: TINY_PNG }]);
  try {
    assert.equal(staged.files.length, 1);
    assert.equal(staged.files[0].name, 'input-image-1.png');
    assert.ok(fs.existsSync(staged.files[0].path));
    assert.ok(fs.statSync(staged.files[0].path).size > 0);
    assert.ok(staged.dir && staged.dir.includes('tb-cgw-img-'));
  } finally {
    if (staged.dir) fs.rmSync(staged.dir, { recursive: true, force: true });
  }
});

test('materializeImages：空列表不建目录', async () => {
  const staged = await materializeImages([]);
  assert.equal(staged.dir, '');
  assert.equal(staged.files.length, 0);
});
