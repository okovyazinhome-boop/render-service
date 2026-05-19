const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');
const puppeteer = require('puppeteer');

const DEFAULT_PORT = 3001;
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_OUTPUT_TTL_HOURS = 24;
const DEFAULT_CLEANUP_HOUR = 1;
const CLEANUP_CHECK_INTERVAL_MS = 60 * 1000;
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(payload));
}

function isAuthorized(request, apiKey) {
  if (!apiKey) return true;
  return request.headers['x-api-key'] === apiKey;
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = '';

    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    request.on('error', reject);
  });
}

function resolveTemplate(rootDir, templateId) {
  if (!SAFE_ID.test(templateId || '')) {
    throw new Error(`Invalid templateId: ${templateId}`);
  }

  const templateDir = path.join(rootDir, 'templates', templateId);
  const templatePath = path.join(templateDir, 'template.html');
  const schemaPath = path.join(templateDir, 'schema.json');

  if (!fs.existsSync(templatePath) || !fs.existsSync(schemaPath)) {
    throw new Error(`Unknown templateId: ${templateId}`);
  }

  return {
    templateDir,
    templatePath,
    schema: JSON.parse(fs.readFileSync(schemaPath, 'utf8'))
  };
}

function listTemplates(rootDir) {
  const templatesDir = path.join(rootDir, 'templates');

  if (!fs.existsSync(templatesDir)) {
    return [];
  }

  return fs.readdirSync(templatesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name))
    .map((entry) => {
      const schemaPath = path.join(templatesDir, entry.name, 'schema.json');

      if (!fs.existsSync(schemaPath)) {
        return null;
      }

      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

      return {
        templateId: schema.templateId,
        width: schema.width,
        height: schema.height,
        fields: schema.fields
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.templateId.localeCompare(b.templateId));
}

function validateSlide(slide, schema) {
  for (const [fieldName, rules] of Object.entries(schema.fields)) {
    const value = slide[fieldName];

    if (rules.required && (typeof value !== 'string' || value.trim() === '')) {
      throw new Error(`Missing required field: ${fieldName}`);
    }

    if (typeof value === 'string' && rules.maxChars && value.length > rules.maxChars) {
      throw new Error(`Field "${fieldName}" is too long. Max: ${rules.maxChars}`);
    }
  }
}

function normalizeProjectId(projectId) {
  if (!projectId) return `render-${Date.now()}`;
  if (!SAFE_ID.test(projectId)) {
    throw new Error(`Invalid projectId: ${projectId}`);
  }
  return projectId;
}

function cleanupOldOutputs(options = {}) {
  const rootDir = options.rootDir || __dirname;
  const ttlHours = Number(options.ttlHours || DEFAULT_OUTPUT_TTL_HOURS);
  const now = options.now || new Date();
  const outputDir = path.join(rootDir, 'output');
  const maxAgeMs = ttlHours * 60 * 60 * 1000;
  const removed = [];

  if (!fs.existsSync(outputDir)) {
    return { removed };
  }

  for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) {
      continue;
    }

    const projectDir = path.join(outputDir, entry.name);
    const stats = fs.statSync(projectDir);
    const ageMs = now.getTime() - stats.mtimeMs;

    if (ageMs > maxAgeMs) {
      fs.rmSync(projectDir, { recursive: true, force: true });
      removed.push(entry.name);
    }
  }

  return { removed };
}

function startDailyCleanup(options = {}) {
  const rootDir = options.rootDir || __dirname;
  const ttlHours = Number(options.ttlHours || process.env.OUTPUT_TTL_HOURS || DEFAULT_OUTPUT_TTL_HOURS);
  const cleanupHour = Number(options.cleanupHour || process.env.CLEANUP_HOUR || DEFAULT_CLEANUP_HOUR);
  let lastCleanupDate = '';

  function runIfDue(now = new Date()) {
    const dateKey = now.toISOString().slice(0, 10);

    if (now.getHours() !== cleanupHour || lastCleanupDate === dateKey) {
      return null;
    }

    lastCleanupDate = dateKey;
    const result = cleanupOldOutputs({ rootDir, ttlHours, now });
    console.log(`Output cleanup finished: removed ${result.removed.length} project folders`);
    return result;
  }

  const interval = setInterval(() => {
    runIfDue();
  }, CLEANUP_CHECK_INTERVAL_MS);

  interval.unref?.();

  return {
    stop: () => clearInterval(interval),
    runIfDue
  };
}

async function renderSlides(rootDir, payload) {
  const slides = payload.slides;

  if (!Array.isArray(slides) || slides.length === 0) {
    throw new Error('slides must be a non-empty array');
  }

  const projectId = normalizeProjectId(payload.projectId);
  const projectOutputDir = path.join(rootDir, 'output', projectId);
  fs.mkdirSync(projectOutputDir, { recursive: true });

  const launchOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  };

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const browser = await puppeteer.launch(launchOptions);
  const files = [];

  try {
    for (const [index, slide] of slides.entries()) {
      const { templatePath, schema } = resolveTemplate(rootDir, slide.templateId);
      validateSlide(slide, schema);

      const page = await browser.newPage();
      await page.setViewport({
        width: schema.width || 1080,
        height: schema.height || 1920,
        deviceScaleFactor: 1
      });

      await page.goto('file://' + templatePath, { waitUntil: 'networkidle0' });
      await page.evaluate((slideData) => {
        window.applySlideData(slideData);
      }, slide);

      const fileName = `slide-${String(index + 1).padStart(2, '0')}.png`;
      const absoluteOutputPath = path.join(projectOutputDir, fileName);

      await page.screenshot({
        path: absoluteOutputPath,
        fullPage: false
      });
      await page.close();

      files.push(`/output/${projectId}/${fileName}`);
    }
  } finally {
    await browser.close();
  }

  return {
    projectId,
    count: files.length,
    files
  };
}

function serveOutputFile(rootDir, request, response) {
  const url = new URL(request.url, 'http://localhost');
  const relativePath = decodeURIComponent(url.pathname.replace(/^\/output\//, ''));
  const filePath = path.join(rootDir, 'output', relativePath);
  const outputRoot = path.join(rootDir, 'output');

  if (!filePath.startsWith(outputRoot) || !fs.existsSync(filePath)) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  response.writeHead(200, { 'content-type': 'image/png' });
  fs.createReadStream(filePath).pipe(response);
}

function createRenderServer(options = {}) {
  const rootDir = options.rootDir || __dirname;
  const apiKey = options.apiKey || process.env.RENDER_API_KEY || '';

  return http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');

    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/templates') {
        if (!isAuthorized(request, apiKey)) {
          sendJson(response, 401, { ok: false, error: 'Unauthorized' });
          return;
        }

        sendJson(response, 200, {
          ok: true,
          templates: listTemplates(rootDir)
        });
        return;
      }

      if (request.method === 'GET' && url.pathname.startsWith('/output/')) {
        serveOutputFile(rootDir, request, response);
        return;
      }

      if (request.method !== 'POST' || url.pathname !== '/render') {
        sendJson(response, 404, { ok: false, error: 'Not found' });
        return;
      }

      if (!isAuthorized(request, apiKey)) {
        sendJson(response, 401, { ok: false, error: 'Unauthorized' });
        return;
      }

      const payload = await readJsonBody(request);
      const renderResult = await renderSlides(rootDir, payload);

      sendJson(response, 200, {
        ok: true,
        projectId: renderResult.projectId,
        count: renderResult.count,
        files: renderResult.files
      });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || DEFAULT_PORT);
  const server = createRenderServer();
  const cleanupScheduler = process.env.DISABLE_OUTPUT_CLEANUP === '1'
    ? null
    : startDailyCleanup();

  server.listen(port, () => {
    console.log(`Render service listening on http://localhost:${port}`);
    if (cleanupScheduler) {
      console.log(`Output cleanup scheduled daily at ${Number(process.env.CLEANUP_HOUR || DEFAULT_CLEANUP_HOUR)}:00 server time`);
    }
  });
}

module.exports = {
  cleanupOldOutputs,
  createRenderServer,
  listTemplates,
  renderSlides,
  startDailyCleanup
};
