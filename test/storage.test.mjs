import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signRequest } from '../src/storage/sigv4.js';

test('SigV4 matches the AWS documentation example', async () => {
  // From AWS's "Signature Version 4 signing process" worked example (IAM ListUsers).
  const { signature, headers } = await signRequest({
    method: 'GET',
    url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    region: 'us-east-1', service: 'iam',
    accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    date: new Date('2015-08-30T12:36:00Z'),
  });
  assert.equal(signature, '5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
  assert.match(headers.authorization, /SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79/);
  assert.equal(headers['x-amz-date'], '20150830T123600Z');
});

test('share links carry the bundle address', async () => {
  const { makeShareLink, sharedFileFrom, linkBase, PUBLIC_SITE } = await import('../src/links.js');
  const file = 'https://abcd.supabase.co/storage/v1/object/public/freeflow/1f2e/My%20exp.zip';
  const link = makeShareLink(file, 'https://paraish.github.io/freeflow/');
  const u = new URL(link);
  assert.equal(sharedFileFrom({ hash: u.hash, search: '' }), file);
  assert.equal(sharedFileFrom({ hash: '', search: `?open=${encodeURIComponent(file)}` }), file);
  assert.equal(sharedFileFrom({ hash: '#open=http%3A%2F%2Finsecure.example%2Fa.zip', search: '' }), null);
  assert.equal(linkBase({ protocol: 'file:', hostname: '', origin: 'null', pathname: '/x.html' }), PUBLIC_SITE);
  assert.equal(linkBase({ protocol: 'https:', hostname: 'lab.example.org', origin: 'https://lab.example.org', pathname: '/freeflow/' }), 'https://lab.example.org/freeflow/');
});

test('manual links: Dropbox becomes a direct download, Google Drive is refused', async () => {
  const { directUrl } = await import('../src/storage/manual.js');
  assert.equal(directUrl('https://www.dropbox.com/scl/fi/abc/exp.zip?rlkey=xyz&dl=0'), 'https://dl.dropboxusercontent.com/scl/fi/abc/exp.zip?rlkey=xyz');
  assert.throws(() => directUrl('https://drive.google.com/file/d/123/view'), /Google Drive/);
  assert.throws(() => directUrl('not a url'), /web address/);
});
