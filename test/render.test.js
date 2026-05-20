const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { cleanupOldOutputs, createRenderServer } = require('../server');

function readPngSize(filePath) {
  const buffer = fs.readFileSync(filePath);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function makeSlide(index) {
  return {
    templateId: 'utp-01-hook',
    headline: `СЛАЙД ${index}: МЕРКУРИЙ НЕ ВИДИТ КАРТУ?`,
    description: 'Проверяем генерацию нескольких PNG в одном запросе для последующей сборки ролика через FFmpeg.',
    button: 'Смотри до конца, чтобы узнать решение'
  };
}

function makeSixSlideSeries() {
  return [
    {
      templateId: 'utp-01-hook',
      headline: 'МЕРКУРИЙ НЕ ВИДИТ КАРТУ?',
      description: 'Чаще всего причина не в водителе. Проблема может быть в карте, считывателе, настройках или самом тахографе.',
      button: 'Смотри до конца, чтобы узнать решение'
    },
    {
      templateId: 'utp-01-pain',
      headline: 'ВОДИТЕЛЬ ЖАЛУЕТСЯ, А ПРОБЛЕМА В ТАХОГРАФЕ',
      description: 'Карта не читается, появляются ошибки, рейс затягивается, а причина не всегда очевидна.'
    },
    {
      templateId: 'utp-01-error',
      headline: 'ТАХОГРАФ НЕ ВИДИТ КАРТУ ВОДИТЕЛЯ?',
      description: 'Проблема может быть в карте, считывателе или настройках.'
    },
    {
      templateId: 'utp-01-risk',
      headline: 'ШТРАФЫ ЗА ТАХОГРАФ',
      description: 'За отсутствие, неисправность или нарушения в работе тахографа.',
      amount: 'до 50 000 ₽'
    },
    {
      templateId: 'utp-01-solution',
      headline: 'РЕШЕНИЕ ЕСТЬ',
      subheadline: 'Проверьте тахограф и устраните сбой вовремя'
    }
  ];
}

test('removes output project folders older than ttl', () => {
  const rootDir = path.resolve(__dirname, '..');
  const outputDir = path.join(rootDir, 'output');
  const oldProjectDir = path.join(outputDir, 'cleanup-old-project');
  const freshProjectDir = path.join(outputDir, 'cleanup-fresh-project');
  const now = new Date('2026-05-16T01:00:00.000Z');
  const oldDate = new Date(now.getTime() - 25 * 60 * 60 * 1000);

  fs.rmSync(oldProjectDir, { recursive: true, force: true });
  fs.rmSync(freshProjectDir, { recursive: true, force: true });
  fs.mkdirSync(oldProjectDir, { recursive: true });
  fs.mkdirSync(freshProjectDir, { recursive: true });
  fs.writeFileSync(path.join(oldProjectDir, 'slide-01.png'), 'old');
  fs.writeFileSync(path.join(freshProjectDir, 'slide-01.png'), 'fresh');
  fs.utimesSync(oldProjectDir, oldDate, oldDate);
  fs.utimesSync(freshProjectDir, now, now);

  const result = cleanupOldOutputs({
    rootDir,
    ttlHours: 24,
    now
  });

  assert.deepEqual(result.removed, ['cleanup-old-project']);
  assert.equal(fs.existsSync(oldProjectDir), false);
  assert.equal(fs.existsSync(freshProjectDir), true);

  fs.rmSync(freshProjectDir, { recursive: true, force: true });
});

test('renders slides and returns PNG paths', async () => {
  const rootDir = path.resolve(__dirname, '..');
  const server = createRenderServer({ rootDir });
  const port = await listen(server);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'test-video',
        slides: [
          {
            templateId: 'utp-01-hook',
            headline: 'МЕРКУРИЙ НЕ ВИДИТ КАРТУ?',
            description: 'Чаще всего причина не в водителе. Проблема может быть в карте, считывателе, настройках или самом тахографе.',
            button: 'Смотри до конца, чтобы узнать решение'
          }
        ]
      })
    });

    assert.equal(response.status, 200);
    const payload = await response.json();

    assert.equal(payload.ok, true);
    assert.deepEqual(payload.files, ['/output/test-video/slide-01.png']);

    const pngPath = path.join(rootDir, payload.files[0]);
    assert.equal(fs.existsSync(pngPath), true);
    assert.deepEqual(readPngSize(pngPath), { width: 1080, height: 1920 });
  } finally {
    await close(server);
  }
});

test('lists available templates with their schemas', async () => {
  const rootDir = path.resolve(__dirname, '..');
  const server = createRenderServer({ rootDir });
  const port = await listen(server);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/templates`);

    assert.equal(response.status, 200);
    const payload = await response.json();

    assert.equal(payload.ok, true);
    assert.deepEqual(
      payload.templates.map((template) => template.templateId),
      [
        'utp-01-error',
        'utp-01-hook',
        'utp-01-pain',
        'utp-01-risk',
        'utp-01-solution'
      ]
    );
    assert.deepEqual(
      payload.templates.find((template) => template.templateId === 'utp-01-hook').fields,
      {
        headline: { required: true, maxChars: 65 },
        description: { required: true, maxChars: 180 },
        button: { required: true, maxChars: 55 }
      }
    );
    assert.equal(payload.templates.some((template) => template.templateId === 'utp-01-cta'), false);
  } finally {
    await close(server);
  }
});

test('renders five UTP 01 slides in one request and returns ordered files', async () => {
  const rootDir = path.resolve(__dirname, '..');
  const server = createRenderServer({ rootDir });
  const port = await listen(server);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'five-slide-video',
        slides: makeSixSlideSeries()
      })
    });

    assert.equal(response.status, 200);
    const payload = await response.json();

    assert.equal(payload.ok, true);
    assert.equal(payload.projectId, 'five-slide-video');
    assert.equal(payload.count, 5);
    assert.deepEqual(payload.files, [
      '/output/five-slide-video/slide-01.png',
      '/output/five-slide-video/slide-02.png',
      '/output/five-slide-video/slide-03.png',
      '/output/five-slide-video/slide-04.png',
      '/output/five-slide-video/slide-05.png'
    ]);

    for (const file of payload.files) {
      const pngPath = path.join(rootDir, file);
      assert.equal(fs.existsSync(pngPath), true);
      assert.deepEqual(readPngSize(pngPath), { width: 1080, height: 1920 });
    }
  } finally {
    await close(server);
  }
});

test('renders the Make request example', async () => {
  const rootDir = path.resolve(__dirname, '..');
  const example = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'examples', 'make-request.json'), 'utf8')
  );
  const server = createRenderServer({ rootDir });
  const port = await listen(server);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(example)
    });

    assert.equal(response.status, 200);
    const payload = await response.json();

    assert.equal(payload.ok, true);
    assert.equal(payload.projectId, example.projectId);
    assert.equal(payload.count, example.slides.length);
  } finally {
    await close(server);
  }
});

test('rejects protected render requests without API key', async () => {
  const rootDir = path.resolve(__dirname, '..');
  const server = createRenderServer({ rootDir, apiKey: 'test-secret' });
  const port = await listen(server);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'protected-video',
        slides: [makeSlide(1)]
      })
    });

    assert.equal(response.status, 401);
    const payload = await response.json();

    assert.equal(payload.ok, false);
    assert.equal(payload.error, 'Unauthorized');
  } finally {
    await close(server);
  }
});

test('accepts protected render requests with API key', async () => {
  const rootDir = path.resolve(__dirname, '..');
  const server = createRenderServer({ rootDir, apiKey: 'test-secret' });
  const port = await listen(server);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/render`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'test-secret'
      },
      body: JSON.stringify({
        projectId: 'protected-video',
        slides: [makeSlide(1)]
      })
    });

    assert.equal(response.status, 200);
    const payload = await response.json();

    assert.equal(payload.ok, true);
    assert.equal(payload.projectId, 'protected-video');
    assert.equal(payload.count, 1);
  } finally {
    await close(server);
  }
});

test('rejects slides that miss required template fields', async () => {
  const rootDir = path.resolve(__dirname, '..');
  const server = createRenderServer({ rootDir });
  const port = await listen(server);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'bad-video',
        slides: [
          {
            templateId: 'utp-01-hook',
            headline: 'МЕРКУРИЙ НЕ ВИДИТ КАРТУ?'
          }
        ]
      })
    });

    assert.equal(response.status, 400);
    const payload = await response.json();

    assert.equal(payload.ok, false);
    assert.match(payload.error, /description/);
  } finally {
    await close(server);
  }
});
