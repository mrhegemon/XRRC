'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const I18n = require('../public/js/i18n');

test('resolves query, stored, and browser languages with English fallback', () => {
  assert.equal(I18n.resolveLanguage('?lang=fr', ['es'], 'en'), 'fr');
  assert.equal(I18n.resolveLanguage('', ['de-DE', 'es-MX'], null), 'es');
  assert.equal(I18n.resolveLanguage('', ['de-DE'], null), 'en');
  assert.equal(I18n.normalizeLanguage('FR-ca'), 'fr');
});

test('translates interface and vehicle copy with interpolation', () => {
  I18n.setLanguage('es', false);
  assert.equal(I18n.t('mode.desktop'), 'Carrera de escritorio');
  assert.equal(I18n.t('vehicle.helicopter'), 'Helicoptero');
  assert.equal(I18n.t('share.title'), 'Llama a tu equipo');
  assert.equal(
    I18n.t('controller.connected', { label: 'XInput' }),
    'XInput conectado'
  );
  I18n.setLanguage('en', false);
});

test('keeps every share-dialog string localized', () => {
  const shareKeys = Object.keys(I18n.dictionaries.en).filter((key) => key.startsWith('share.'));
  for (const language of I18n.supported) {
    for (const key of shareKeys) {
      assert.equal(
        typeof I18n.dictionaries[language][key],
        'string',
        `${language} is missing ${key}`
      );
    }
  }
});

test('keeps every course and vehicle name localized', () => {
  const keys = Object.keys(I18n.dictionaries.en).filter((key) => (
    key.startsWith('track.') || key.startsWith('vehicle.')
  ));
  for (const language of I18n.supported) {
    for (const key of keys) {
      assert.equal(
        typeof I18n.dictionaries[language][key],
        'string',
        `${language} is missing ${key}`
      );
    }
  }
});

test('keeps race, pause, results, and rule copy localized', () => {
  const keys = Object.keys(I18n.dictionaries.en).filter((key) => (
    key.startsWith('race.') ||
    key.startsWith('pause.') ||
    key.startsWith('results.') ||
    key.startsWith('setup.race') ||
    key.startsWith('setup.laps') ||
    key.startsWith('setup.rivals') ||
    key.startsWith('setup.assist')
  ));
  for (const language of I18n.supported) {
    for (const key of keys) {
      assert.equal(
        typeof I18n.dictionaries[language][key],
        'string',
        `${language} is missing ${key}`
      );
    }
  }
});

test('falls back to English when a localized key is missing', () => {
  I18n.setLanguage('fr', false);
  delete I18n.dictionaries.fr['race.copied'];
  assert.equal(I18n.t('race.copied'), 'Room link copied');
  I18n.setLanguage('en', false);
});
