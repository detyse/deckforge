import assert from 'node:assert/strict';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { preview } from 'vite';
import JSZip from 'jszip';

let server, browser, url;
before(async () => {
  server = await preview({ preview: { host: '127.0.0.1', port: 0 } });
  url = 'http://127.0.0.1:' + server.httpServer.address().port;
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL });
});
after(async () => {
  await browser?.close();
  await server?.close();
});

async function openDeck(t, input) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  t.after(() => page.close());
  await page.goto(url);
  await page.locator('input[accept=".html,.htm"]').setInputFiles(input);
  await page.getByTitle('进入编辑', { exact: true }).click();
  return { page, frame: page.frameLocator('iframe[title=preview]') };
}

const file = { name: 'sections.html', mimeType: 'text/html', buffer: Buffer.from(`<!DOCTYPE html>
<html><head><title>Round trip</title><style>section {width:800px;height:450px} h2 {font-size:32px}</style></head>
<body><!-- author comment --><header>Workshop</header>
<section><h2>First</h2><p>Notes</p></section>
<section><h2>Second</h2><p>Notes</p></section>
<section><h2>Third <em>draft</em></h2><p>Notes</p></section>
<script>document.body.prepend(document.createElement('aside'))</script></body></html>`) };

test('same-layout sections, selection-independent history and all three downloads', async t => {
  const { page, frame } = await openDeck(t, file);
  const slides = frame.locator('section');
  const third = slides.nth(2).locator('h2');
  const second = slides.nth(1).locator('h2');
  const button = title => page.getByTitle(title, { exact: true });
  await page.getByRole('button', { name: /Third draft/ }).click();
  await third.waitFor({ state: 'visible' });
  assert.equal(await second.isVisible(), false);
  await third.click();
  await page.getByRole('slider', { name: '字号', exact: true }).fill('48');
  await third.dblclick();
  await third.fill('Revised third');
  await third.press('Tab');
  await page.getByRole('button', { name: /Second/ }).click();
  await second.click();
  await button('撤销').click();
  assert.equal(await third.textContent(), 'Third draft');
  assert.equal(await third.locator('em').textContent(), 'draft');
  await button('撤销').click();
  assert.equal(await third.evaluate(el => el.style.fontSize), '');
  await button('重做').click();
  await button('重做').click();
  assert.equal(await third.textContent(), 'Revised third');
  assert.equal(await third.evaluate(el => el.style.fontSize), '48px');
  assert.equal(await second.evaluate(el => el.style.fontSize), '');

  const temp = await mkdtemp(join(tmpdir(), 'deckforge-test-'));
  const standalone = join(temp, 'reopened.html');
  t.after(async () => { await unlink(standalone).catch(() => {}); await rmdir(temp); });
  const reopened = await browser.newPage();
  t.after(() => reopened.close());
  for (const title of ['保存', '导出单 HTML', '导出 ZIP']) {
    const [download] = await Promise.all([page.waitForEvent('download'), button(title).click()]);
    const bytes = await readFile(await download.path());
    const html = title === '导出 ZIP'
      ? await (await JSZip.loadAsync(bytes)).file(file.name).async('string') : bytes.toString();
    assert.doesNotMatch(html, /data-deckforge-|__deckforge-|contenteditable=|blob:/);
    assert.match(html, /<!-- author comment -->/);
    assert.match(html, /<!DOCTYPE html>/i);
    await writeFile(standalone, html);
    await reopened.goto(pathToFileURL(standalone).href + '?' + encodeURIComponent(title));
    assert.deepEqual(await reopened.locator('h2').allTextContents(), ['First', 'Second', 'Revised third']);
    assert.deepEqual(await reopened.locator('h2').evaluateAll(els => els.map(el => el.style.fontSize)), ['', '', '48px']);
    assert.equal(await reopened.locator('section:visible').count(), 3);
    assert.equal(await reopened.locator('aside').count(), 1); // the author's script ran exactly once
  }
});

test('sample deck saves text still being edited and resets history on re-import', async t => {
  const { page, frame } = await openDeck(t, 'example-deck.html');
  await page.getByRole('button', { name: /隐私优先/ }).click();
  const heading = frame.locator('.slide').nth(2).locator('h2');
  await heading.dblclick();
  await heading.fill('Updated sample');
  const [download] = await Promise.all([page.waitForEvent('download'), heading.press('Control+s')]);
  const saved = await readFile(await download.path(), 'utf8');
  assert.match(saved, /<h2>Updated sample<\/h2>/);
  assert.match(saved, /<h2>核心特性<\/h2>/);
  await page.locator('input[accept=".html,.htm,.zip"]').setInputFiles(file);
  await frame.locator('section').first().waitFor();
  assert.equal(await page.getByTitle('撤销', { exact: true }).isDisabled(), true);
});

test('image replacement undoes across pages and restore preserves the imported file', async t => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="blue"/></svg>';
  const originalSrc = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  const html = '<!DOCTYPE html><section><h2>A</h2><img src="' + originalSrc + '"></section>'
    + '<section><h2>B</h2><img src="' + originalSrc + '"></section>';
  const { page, frame } = await openDeck(t, { name: 'images.html', mimeType: 'text/html', buffer: Buffer.from(html) });
  await page.getByRole('button', { name: /2 B/ }).click();
  const images = frame.locator('img');
  await images.nth(1).click();
  await page.getByRole('tab', { name: '图片' }).click();
  const replacement = Buffer.from(svg.replace('blue', 'red'));
  const newSrc = 'data:image/svg+xml;base64,' + replacement.toString('base64');
  await page.locator('input[accept="image/*"]').setInputFiles({ name: 'red.svg', mimeType: 'image/svg+xml', buffer: replacement });
  await frame.locator('section').nth(1).locator('img[src="' + newSrc + '"]').waitFor();
  await page.getByRole('button', { name: /1 A/ }).click();
  await images.first().click();
  await page.getByTitle('撤销', { exact: true }).click();
  assert.equal(await images.nth(1).getAttribute('src'), originalSrc);
  await page.getByTitle('重做', { exact: true }).click();
  assert.equal(await images.first().getAttribute('src'), originalSrc);
  assert.equal(await images.nth(1).getAttribute('src'), newSrc);
  await page.getByTitle('恢复原始', { exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTitle('保存', { exact: true }).click()]);
  assert.equal(await readFile(await download.path(), 'utf8'), html);
});
