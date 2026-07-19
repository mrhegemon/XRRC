'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const publicDirectory = path.join(root, 'public');
const html = fs.readFileSync(path.join(publicDirectory, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(publicDirectory, 'css/style.css'), 'utf8');
const game = fs.readFileSync(path.join(publicDirectory, 'js/game.js'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/pages.yml'), 'utf8');

test('keeps local page assets relative and present for the /XRRC/ subpath', () => {
  const references = Array.from(html.matchAll(/(?:href|src)="([^"]+)"/g))
    .map((match) => match[1])
    .filter((reference) => (
      !reference.startsWith('http') &&
      !reference.startsWith('#') &&
      !reference.startsWith('data:')
    ));

  for (const reference of references) {
    const cleanReference = reference.replace(/^\.\//, '').split(/[?#]/)[0];
    assert.equal(
      fs.existsSync(path.join(publicDirectory, cleanReference)),
      true,
      `Missing local asset: ${reference}`
    );
    assert.equal(reference.startsWith('/'), false, `Root-relative asset: ${reference}`);
  }
});

test('uses unique element IDs and includes accessibility fallbacks', () => {
  const ids = Array.from(html.matchAll(/\sid="([^"]+)"/g), (match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.match(html, /class="skip-link"/);
  assert.match(html, /aria-live="assertive"/);
  assert.match(html, /id="lobby" tabindex="-1" aria-busy="true"/);
  assert.match(html, /id="desktop-btn"[\s\S]+disabled/);
  assert.match(html, /viewport-fit=cover/);
  assert.doesNotMatch(html, /user-scalable=no/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /:focus-visible/);
});

test('generates Pages runtime configuration for the canonical site', () => {
  assert.match(html, /https:\/\/lab\.liambroza\.com\/XRRC\//);
  assert.match(workflow, /XRRC_SIGNAL_URL: \$\{\{ vars\.XRRC_SIGNAL_URL \}\}/);
  assert.match(workflow, /siteUrl: 'https:\/\/lab\.liambroza\.com\/XRRC\/'/);
  assert.match(workflow, /path: public/);
});

test('ships an accessible share dialog with lazy QR loading', () => {
  assert.match(
    html,
    /<dialog[\s\S]+id="share-dialog"[\s\S]+aria-labelledby="share-title"[\s\S]+aria-describedby="share-description"/
  );
  assert.match(html, /id="share-url" type="url" readonly/);
  assert.match(html, /id="share-close"/);
  assert.match(html, /id="share-email"/);
  assert.match(html, /id="share-sms"/);
  assert.match(html, /id="share-whatsapp"[\s\S]+rel="noopener noreferrer"/);
  assert.match(html, /src="js\/share-core\.js"/);
  assert.doesNotMatch(html, /qrcode@/);
  assert.match(game, /import\(QR_CODE_SOURCE\)/);
});

test('ships an accessible six-course picker before the game runtime', () => {
  const trackInputs = Array.from(
    html.matchAll(/<input type="radio" name="track" value="([^"]+)"/g),
    (match) => match[1]
  );
  assert.deepEqual(trackInputs, [
    'backyard',
    'alpine',
    'desert',
    'harbor',
    'sakura',
    'lunar',
  ]);
  assert.match(html, /<fieldset class="track-field">[\s\S]+<legend>Course map<\/legend>/);
  assert.match(html, /src="js\/track-core\.js"/);
  assert.ok(
    html.indexOf('src="js/track-core.js"') < html.indexOf("await import('./js/game.js')"),
    'Track catalog must load before the game module'
  );
});

test('ships a live handling profile for the complete vehicle picker', () => {
  const vehicleInputs = Array.from(
    html.matchAll(/<input type="radio" name="vehicle" value="([^"]+)"/g),
    (match) => match[1]
  );
  assert.equal(vehicleInputs.length, 13);
  assert.match(html, /id="vehicle-profile"[\s\S]+aria-live="polite"/);
  assert.match(html, /id="vehicle-role"/);
  assert.match(html, /id="vehicle-note"/);
  assert.equal((html.match(/class="rating-meter"/g) || []).length, 4);
  assert.equal((html.match(/role="meter"/g) || []).length, 4);
});

test('ships accessible race rules, pause, timing, standings, and results surfaces', () => {
  assert.match(html, /id="lap-count"[\s\S]+value="3" selected/);
  assert.match(html, /id="ai-count"[\s\S]+value="3" selected/);
  assert.match(html, /id="steering-assist" type="checkbox" checked/);
  assert.match(html, /id="race-time"/);
  assert.match(html, /id="standings-list"/);
  assert.match(html, /id="boost-meter"/);
  assert.match(html, /<dialog id="pause-dialog"[\s\S]+aria-labelledby="pause-title"/);
  assert.match(html, /<dialog id="results-dialog"[\s\S]+aria-labelledby="results-title"/);
  assert.ok(
    html.indexOf('src="js/race-core.js"') < html.indexOf("await import('./js/game.js')"),
    'Race core must load before the game module'
  );
});
