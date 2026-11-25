/**
 * Private address book: caller identification + owner-only search.
 * Run with: node --test test/contacts.test.js
 */
const test = require('node:test');
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const contacts = require('../lib/contacts');

const VCF = [
  'BEGIN:VCARD', 'VERSION:3.0', 'FN:Max Mustermann', 'N:Mustermann;Max;;;',
  'TEL;TYPE=CELL:+49 170 1234567', 'TEL;TYPE=HOME:0761 / 55 66 77', 'EMAIL;TYPE=INTERNET:max@example.org',
  'BDAY:19800101', 'CATEGORIES:myContacts', 'END:VCARD',
  'BEGIN:VCARD', 'VERSION:3.0', 'FN:Erika Müller', 'ORG:Bäckerei Müller',
  'TEL:0041 44 1234567', 'END:VCARD',
  'BEGIN:VCARD', 'VERSION:3.0', 'TEL;TYPE=CELL:0151 9999999', 'ORG:Pizzadienst', 'END:VCARD'
].join('\r\n');

function setup(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contacts-'));
  const f = path.join(dir, 'contacts.vcf');
  fs.writeFileSync(f, VCF);
  process.env.CONTACTS_FILE = f;
  process.env.OWNER_CALLER_IDS = env.owner || '222,+49 170 0000000';
  contacts._reset();
  return f;
}

test('normalizes numbers and makes them dialable', () => {
  assert.strictEqual(contacts.normalizeNumber('0170 / 123-45'), '+4917012345');
  assert.strictEqual(contacts.normalizeNumber('0041441234567'), '+41441234567');
  assert.strictEqual(contacts.normalizeNumber('222'), '222');
  assert.strictEqual(contacts.dialable('+4917012345'), '017012345');
  assert.strictEqual(contacts.dialable('+41441234567'), '0041441234567');
  assert.ok(contacts.isExternal('01701234567'));
  assert.ok(!contacts.isExternal('222'));
});

test('identifies external callers in any number format', () => {
  setup();
  assert.strictEqual(contacts.lookupNumber('01701234567').name, 'Max Mustermann');
  assert.strictEqual(contacts.lookupNumber('+49761556677').name, 'Max Mustermann');
  assert.strictEqual(contacts.lookupNumber('0041441234567').name, 'Erika Müller');
  assert.strictEqual(contacts.lookupNumber('01519999999').name, 'Pizzadienst');
  assert.strictEqual(contacts.lookupNumber('222'), null);
  assert.strictEqual(contacts.lookupNumber('0301111111'), null);
});

test('owner check uses OWNER_CALLER_IDS', () => {
  setup();
  assert.ok(contacts.isOwner('222'));
  assert.ok(contacts.isOwner('01700000000'));
  assert.ok(!contacts.isOwner('223'));
  assert.ok(!contacts.isOwner('01701234567'));
  assert.ok(!contacts.isOwner(''));
});

test('search finds by first/last name, umlauts folded, stopwords ignored', () => {
  setup();
  assert.deepStrictEqual(contacts.search('verbinde mich bitte mit Max').map(c => c.name), ['Max Mustermann']);
  assert.deepStrictEqual(contacts.search('ruf Frau Mueller an').map(c => c.name), ['Erika Müller']);
  assert.deepStrictEqual(contacts.search('die Bäckerei').map(c => c.name), ['Erika Müller']);
  assert.deepStrictEqual(contacts.search('verbinde mich bitte'), []);
  const line = contacts.describe(contacts.search('Mustermann')[0]);
  assert.match(line, /Handy 01701234567/);
  assert.match(line, /privat 0761556677/);
  assert.match(line, /max@example.org/);
});

test('handlers: owner gets address book, others only a name', () => {
  setup();
  const { identifyCaller, addressBookPrompt } = require('../lib/extension-handlers');
  const julian = identifyCaller('222');
  assert.ok(julian.owner);
  const max = identifyCaller('01701234567');
  assert.ok(!max.owner);
  assert.strictEqual(max.name, 'Max Mustermann');
  assert.doesNotMatch(max.line, /0761|example/); // no other data in the caller line
  assert.match(identifyCaller('223').line, /Nebenstelle 223/);
  assert.match(identifyCaller('0301111111').line, /nicht im Adressbuch/);
  assert.match(identifyCaller('unknown').line, /unterdrückt/);
  assert.match(addressBookPrompt('verbinde mich mit Max'), /\[ADRESSBUCH[\s\S]*01701234567[\s\S]*END ADRESSBUCH/);
});

test('missing file: identification just off, no crash', () => {
  process.env.CONTACTS_FILE = path.join(os.tmpdir(), 'does-not-exist.vcf');
  contacts._reset();
  assert.strictEqual(contacts.lookupNumber('01701234567'), null);
  assert.deepStrictEqual(contacts.search('Max'), []);
});

test('operator greeting: name, else extension digit by digit, else plain', () => {
  const { operatorGreeting } = require('../lib/extension-handlers');
  assert.match(operatorGreeting({ name: 'Julian' }), /^Hallo Julian\. Möchtest du mit einer bestimmten Person/);
  assert.match(operatorGreeting({ name: '', extension: '402' }), /Nebenstelle 4 0 2 an\./);
  assert.match(operatorGreeting({ name: '' }), /^Vermittlung, guten Tag\. Möchtest du/);
});

test('operator keywords: only a bare keyword goes straight through', () => {
  const { matchKeyword, OPERATOR_KEYWORDS: K } = require('../lib/extension-handlers');
  assert.strictEqual(matchKeyword('Hauptmenü bitte.', K), '1');
  assert.strictEqual(matchKeyword('Verbinde mich mit Home Assistant.', K), '7');
  assert.strictEqual(matchKeyword('Ich möchte zur Durchsage', K), '50');
  assert.strictEqual(matchKeyword('St. Georgen', K), '30');
  assert.strictEqual(matchKeyword('Konferenzraum!', K), '9');
  assert.strictEqual(matchKeyword('Durchsage ins Wohnzimmer', K), null);
  assert.strictEqual(matchKeyword('Was gibt es im Hauptmenü?', K), null);
  assert.strictEqual(matchKeyword('Julian', K), null);
});

test('operator silence text: address book only for the owner', () => {
  const { operatorSilenceText } = require('../lib/extension-handlers');
  assert.match(operatorSilenceText({ owner: true }), /WG direkt.*Adressbuch.*Hauptmenü: Personen die 2/);
  assert.doesNotMatch(operatorSilenceText({ owner: false }), /Adressbuch/);
});
