#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const minimist = require('minimist');
const puppeteer = require('puppeteer-core');
const {
  Browser,
  detectBrowserPlatform,
  getInstalledBrowsers,
  install,
  resolveBuildId,
} = require('@puppeteer/browsers');

const ROOT_DIR = __dirname;
const CACHE_ROOT_DIR = ROOT_DIR;
const BROWSER_DIR = path.join(ROOT_DIR, 'chrome');
const RUNTIME_DIR = path.join(ROOT_DIR, '.runtime');
const PROFILES_DIR = path.join(RUNTIME_DIR, 'profiles');
const SNAPSHOTS_DIR = path.join(RUNTIME_DIR, 'snapshots');
const DEFAULT_URL = 'https://example.com';
const DEFAULT_VERSIONS = 'latest,143';
const DIRECT_TIMEOUT_MS = 15000;
const DEFAULT_VIEWPORT_WIDTH = 1440;
const DEFAULT_VIEWPORT_HEIGHT = 1200;
const DEFAULT_SNAPSHOT_ZOOM = 0.9;
const DEFAULT_DEVICE_SCALE_FACTOR = 1;
const DEFAULT_RENDER_DELAY_MS = 2000;

const argv = minimist(process.argv.slice(2), {
  boolean: [
    'headless',
    'keep-open',
    'dumpio',
    'install-only',
    'direct-only',
    'fresh-profile',
    'snapshot',
  ],
  string: [
    'url',
    'versions',
    'xpath',
    'snapshot-dir',
    'viewport-width',
    'viewport-height',
    'zoom',
    'device-scale-factor',
    'render-delay-ms',
  ],
  default: {
    url: DEFAULT_URL,
    headless: false,
    'keep-open': false,
    dumpio: true,
    'install-only': false,
    'direct-only': false,
    'fresh-profile': true,
    snapshot: false,
  },
});

function normalizeCommand(value) {
  if (!value || String(value).startsWith('-')) {
    return 'launch';
  }

  if (['clear', 'install', 'launch', 'list'].includes(value)) {
    return value;
  }

  throw new Error(`Unknown command "${value}". Use one of: clear, install, launch, list.`);
}

function parseVersions(value) {
  const rawValues =
    value === undefined ? [DEFAULT_VERSIONS] : Array.isArray(value) ? value : [value];

  return rawValues
    .flatMap(item => String(item).split(','))
    .map(item => item.trim())
    .filter(Boolean);
}

function sanitizeLabel(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function getBooleanArg(name) {
  return argv[name] === true || argv[name] === 'true';
}

function isHeadlessEnabled() {
  return getBooleanArg('headless');
}

function shouldKeepOpen() {
  if (getBooleanArg('keep-open')) {
    return true;
  }

  return !isHeadlessEnabled();
}

function parseNumberArg(name, fallback, options = {}) {
  const value = argv[name];
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected --${name} to be a number, received "${value}".`);
  }

  if (options.integer && !Number.isInteger(parsed)) {
    throw new Error(`Expected --${name} to be an integer, received "${value}".`);
  }

  if (options.min !== undefined && parsed < options.min) {
    throw new Error(`Expected --${name} to be at least ${options.min}, received "${value}".`);
  }

  return parsed;
}

function formatTimestamp(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');

  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function resolvePathFromRoot(targetPath) {
  if (path.isAbsolute(targetPath)) {
    return targetPath;
  }

  return path.resolve(ROOT_DIR, targetPath);
}

function getSnapshotOptions() {
  const enabled =
    getBooleanArg('snapshot') || Boolean(argv['snapshot-dir']) || Boolean(argv.xpath);
  const viewportWidth = parseNumberArg('viewport-width', DEFAULT_VIEWPORT_WIDTH, {
    integer: true,
    min: 320,
  });
  const viewportHeight = parseNumberArg('viewport-height', DEFAULT_VIEWPORT_HEIGHT, {
    integer: true,
    min: 240,
  });
  const renderDelayMs = parseNumberArg('render-delay-ms', enabled ? DEFAULT_RENDER_DELAY_MS : 0, {
    integer: true,
    min: 0,
  });
  const zoom = parseNumberArg('zoom', enabled ? DEFAULT_SNAPSHOT_ZOOM : 1, {
    min: 0.1,
  });
  const deviceScaleFactor = parseNumberArg(
    'device-scale-factor',
    DEFAULT_DEVICE_SCALE_FACTOR,
    {
      min: 0.1,
    }
  );
  const xpath = argv.xpath ? String(argv.xpath) : null;
  const outputDir = argv['snapshot-dir']
    ? resolvePathFromRoot(String(argv['snapshot-dir']))
    : path.join(SNAPSHOTS_DIR, formatTimestamp(new Date()));

  return {
    enabled,
    xpath,
    outputDir,
    renderDelayMs,
    viewport: {
      width: viewportWidth,
      height: viewportHeight,
      deviceScaleFactor,
    },
    zoom,
  };
}

function delay(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function clearWorkspaceState() {
  for (const target of [BROWSER_DIR, RUNTIME_DIR]) {
    await fs.rm(target, { recursive: true, force: true });
    console.log(`Removed ${path.relative(ROOT_DIR, target) || '.'}`);
  }
}

async function listInstalled() {
  const installedBrowsers = await getInstalledBrowsers({ cacheDir: CACHE_ROOT_DIR });

  if (installedBrowsers.length === 0) {
    console.log('No local Chrome builds are installed.');
    return;
  }

  for (const browser of installedBrowsers) {
    console.log(
      `${browser.browser}@${browser.buildId} ${browser.platform} ${browser.executablePath}`
    );
  }
}

async function getInstalledChromeBuilds(platform) {
  const installedBrowsers = await getInstalledBrowsers({ cacheDir: CACHE_ROOT_DIR });
  return installedBrowsers.filter(browser => {
    return browser.browser === Browser.CHROME && browser.platform === platform;
  });
}

function compareBuildIds(left, right) {
  const leftParts = left.split('.').map(part => Number(part));
  const rightParts = right.split('.').map(part => Number(part));
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = leftParts[index] || 0;
    const rightPart = rightParts[index] || 0;

    if (leftPart !== rightPart) {
      return leftPart - rightPart;
    }
  }

  return 0;
}

function findInstalledMatch(installedBrowsers, requestedVersion) {
  const requested = String(requestedVersion);
  let matches = [];

  if (/^\d+\.\d+\.\d+\.\d+$/.test(requested)) {
    matches = installedBrowsers.filter(browser => browser.buildId === requested);
  } else if (/^\d+$/.test(requested)) {
    matches = installedBrowsers.filter(browser => browser.buildId.startsWith(`${requested}.`));
  } else if (requested === 'latest') {
    matches = installedBrowsers.slice();
  }

  if (matches.length === 0) {
    return null;
  }

  return matches.sort((left, right) => compareBuildIds(right.buildId, left.buildId))[0];
}

async function resolveChromeBuild(platform, requestedVersion) {
  const buildId = await resolveBuildId(Browser.CHROME, platform, String(requestedVersion));

  if (!buildId) {
    throw new Error(`Unable to resolve a Chrome build for "${requestedVersion}".`);
  }

  return buildId;
}

function progressLogger(label) {
  let lastPercent = -1;

  return (downloadedBytes, totalBytes) => {
    if (!totalBytes) {
      return;
    }

    const percent = Math.floor((downloadedBytes / totalBytes) * 100);
    if (percent !== lastPercent && percent % 10 === 0) {
      lastPercent = percent;
      console.log(`[${label}] download ${percent}%`);
    }
  };
}

async function installChrome(platform, requestedVersion, options = {}) {
  const label = `chrome@${requestedVersion}`;
  const installedBrowsers = await getInstalledChromeBuilds(platform);

  if (options.preferInstalled) {
    const installedMatch = findInstalledMatch(installedBrowsers, requestedVersion);

    if (installedMatch) {
      console.log(`[${label}] using installed build ${installedMatch.buildId}`);
      console.log(`[${label}] executable ${installedMatch.executablePath}`);
      return {
        requestedVersion: String(requestedVersion),
        buildId: installedMatch.buildId,
        executablePath: installedMatch.executablePath,
      };
    }
  }

  const buildId = await resolveChromeBuild(platform, requestedVersion);

  console.log(`[${label}] resolved build ${buildId}`);

  const installedBrowser = await install({
    browser: Browser.CHROME,
    buildId,
    cacheDir: CACHE_ROOT_DIR,
    platform,
    downloadProgressCallback: progressLogger(label),
  });

  console.log(`[${label}] executable ${installedBrowser.executablePath}`);

  return {
    requestedVersion: String(requestedVersion),
    buildId,
    executablePath: installedBrowser.executablePath,
  };
}

function runProcess(executablePath, args, label, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = timeoutMs
      ? setTimeout(() => {
          child.kill('SIGTERM');
        }, timeoutMs)
      : null;

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.once('error', error => {
      finished = true;
      if (timer) {
        clearTimeout(timer);
      }
      reject(error);
    });

    child.once('close', code => {
      if (finished) {
        return;
      }

      finished = true;
      if (timer) {
        clearTimeout(timer);
      }

      resolve({ code, stdout, stderr, label });
    });
  });
}

async function verifyBinary(installResult) {
  const result = await runProcess(
    installResult.executablePath,
    ['--version'],
    `chrome@${installResult.requestedVersion}`,
    DIRECT_TIMEOUT_MS
  );

  if (result.code !== 0) {
    throw new Error(result.stderr || `Direct launch failed with exit code ${result.code}.`);
  }

  console.log(`[chrome@${installResult.requestedVersion}] ${result.stdout.trim()}`);
}

async function prepareProfileDir(installResult) {
  await ensureDir(PROFILES_DIR);

  const profileDir = path.join(
    PROFILES_DIR,
    `${sanitizeLabel(installResult.requestedVersion)}-${installResult.buildId}`
  );

  if (argv['fresh-profile']) {
    await fs.rm(profileDir, { recursive: true, force: true });
  }

  await ensureDir(profileDir);
  return profileDir;
}

async function applyPageView(page, snapshotOptions) {
  await page.setViewport(snapshotOptions.viewport);
}

async function applyPageZoom(page, zoom) {
  if (zoom === 1) {
    return;
  }

  await page.evaluate(value => {
    document.documentElement.style.zoom = String(value);
  }, zoom);
}

async function focusXpathTarget(page, xpath) {
  const waitTimeoutMs = Math.max(DEFAULT_RENDER_DELAY_MS, 5000);

  await page.waitForFunction(
    expression => {
      const result = document.evaluate(
        expression,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      );
      return result.singleNodeValue instanceof Element;
    },
    { timeout: waitTimeoutMs },
    xpath
  );

  const target = await page.evaluate(expression => {
    const result = document.evaluate(
      expression,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    );
    const element = result.singleNodeValue;

    if (!(element instanceof Element)) {
      return null;
    }

    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();

    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
  }, xpath);

  if (!target) {
    throw new Error(`XPath did not resolve to an element: ${xpath}`);
  }

  return target;
}

function buildSnapshotPath(snapshotOptions, installResult) {
  const fileName = `chrome-${sanitizeLabel(installResult.requestedVersion)}-${sanitizeLabel(
    installResult.buildId
  )}.png`;
  return path.join(snapshotOptions.outputDir, fileName);
}

async function captureSnapshot(page, installResult, snapshotOptions) {
  if (!snapshotOptions.enabled) {
    return null;
  }

  await ensureDir(snapshotOptions.outputDir);

  if (snapshotOptions.xpath) {
    const target = await focusXpathTarget(page, snapshotOptions.xpath);
    console.log(
      `[chrome@${installResult.requestedVersion}] centered viewport on XPath target (${Math.round(
        target.width
      )}x${Math.round(target.height)})`
    );
  }

  if (snapshotOptions.renderDelayMs > 0) {
    console.log(
      `[chrome@${installResult.requestedVersion}] waiting ${snapshotOptions.renderDelayMs}ms before snapshot`
    );
    await delay(snapshotOptions.renderDelayMs);
  }

  const snapshotPath = buildSnapshotPath(snapshotOptions, installResult);
  await page.screenshot({
    path: snapshotPath,
    type: 'png',
    captureBeyondViewport: false,
  });

  console.log(`[chrome@${installResult.requestedVersion}] snapshot saved to ${snapshotPath}`);
  return snapshotPath;
}

async function launchWithPuppeteer(installResult, url, snapshotOptions) {
  const headless = isHeadlessEnabled();
  const profileDir = await prepareProfileDir(installResult);
  const browser = await puppeteer.launch({
    browser: 'chrome',
    executablePath: installResult.executablePath,
    headless,
    userDataDir: profileDir,
    dumpio: argv.dumpio,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-dev-shm-usage',
    ],
  });

  const [page] = await browser.pages();
  const activePage = page || (await browser.newPage());
  await applyPageView(activePage, snapshotOptions);
  await activePage.goto(url, { waitUntil: 'networkidle2' });
  await applyPageZoom(activePage, snapshotOptions.zoom);
  await captureSnapshot(activePage, installResult, snapshotOptions);

  console.log(
    `[chrome@${installResult.requestedVersion}] launched ${installResult.buildId} at ${url}`
  );

  return browser;
}

async function directLaunchDiagnostic(installResult, url) {
  const profileDir = await prepareProfileDir(installResult);
  const result = await runProcess(
    installResult.executablePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profileDir}`,
      '--dump-dom',
      url,
    ],
    `chrome@${installResult.requestedVersion}`,
    DIRECT_TIMEOUT_MS
  );

  if (result.code !== 0) {
    throw new Error(result.stderr || `Direct launch failed with exit code ${result.code}.`);
  }

  console.log(
    `[chrome@${installResult.requestedVersion}] direct headless launch succeeded (${result.stdout.length} bytes)`
  );
}

function registerShutdown(launchedBrowsers) {
  let shuttingDown = false;

  const shutdown = async signal => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`\nReceived ${signal}. Closing browsers...`);
    await Promise.allSettled(launchedBrowsers.map(browser => browser.close()));
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

async function main() {
  const command = normalizeCommand(argv._[0]);
  const snapshotOptions = getSnapshotOptions();

  if (command === 'clear') {
    await clearWorkspaceState();
    return;
  }

  if (command === 'list') {
    await listInstalled();
    return;
  }

  if (argv['direct-only'] && snapshotOptions.enabled) {
    throw new Error('Snapshot mode is only available when launching through Puppeteer.');
  }

  const platform = detectBrowserPlatform();
  if (!platform) {
    throw new Error('Unable to detect a supported browser platform for this machine.');
  }

  const requestedVersions = parseVersions(argv.versions);
  const installs = [];
  let failed = false;

  for (const requestedVersion of requestedVersions) {
    try {
      const installResult = await installChrome(platform, requestedVersion, {
        preferInstalled: command !== 'install' && argv['install-only'] !== true,
      });
      await verifyBinary(installResult);
      installs.push(installResult);
    } catch (error) {
      failed = true;
      console.error(`[chrome@${requestedVersion}] ${error.message}`);
    }
  }

  if (installs.length === 0) {
    process.exitCode = 1;
    return;
  }

  if (command === 'install' || argv['install-only']) {
    process.exitCode = failed ? 1 : 0;
    return;
  }

  if (argv['direct-only']) {
    for (const installResult of installs) {
      try {
        await directLaunchDiagnostic(installResult, argv.url);
      } catch (error) {
        failed = true;
        console.error(`[chrome@${installResult.requestedVersion}] ${error.message}`);
      }
    }

    process.exitCode = failed ? 1 : 0;
    return;
  }

  const browsers = [];

  for (const installResult of installs) {
    try {
      const browser = await launchWithPuppeteer(installResult, argv.url, snapshotOptions);
      browsers.push(browser);
    } catch (error) {
      failed = true;
      console.error(`[chrome@${installResult.requestedVersion}] ${error.message}`);
    }
  }

  if (browsers.length === 0) {
    process.exitCode = 1;
    return;
  }

  if (shouldKeepOpen()) {
    registerShutdown(browsers);
    console.log('Browsers are running. Press Ctrl+C to close them.');
    await new Promise(() => {});
  } else {
    await Promise.allSettled(browsers.map(browser => browser.close()));
  }

  process.exitCode = failed ? 1 : 0;
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
