import { test, expect } from '@playwright/test';
import { basename, isAbsolute } from 'node:path';
import { connect, call } from '../scripts/mcp.mjs';

// The authenticated browser belongs to MCP, not Playwright's local browser fixture.
const base = 'https://stg-copilot-app.condenast.io/bon'; // base_config.yml
const organizationId = process.env.COPILOT_EDITOR_ORGANIZATION_ID;
// Verified fixtures in this tenant only: {photos:[{id,title},{id,title}],product:{id,title},uploadPath:"/absolute/path/to/file.pdf"}.
// Upload Media accepts JPEG/PNG/GIF, text/plain and PDF (see fileUploadButton.js).
const fixtures = JSON.parse(process.env.COPILOT_EDITOR_FIXTURES || '{}');
async function run(client, code) {
  const output = await call(client, 'run_code_unsafe', { code: `async (page) => { ${code} }` });
  const result = output.match(/### Result\n([\s\S]*?)\n### Ran Playwright code/);
  if (!result) throw Error(`MCP action failed: ${output.slice(-1200)}`);
  return JSON.parse(result[1]);
}
async function archive(client, id) {
  const output = await call(client, 'evaluate', { function: `async () => {
    const query = 'mutation($org:ID!,$id:String!,$type:String!,$author:String!){archive(organizationId:$org,id:$id,contentType:$type,authorName:$author){id archived}}';
    const response = await fetch('/gql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query,variables:{org:'${organizationId}',id:'${id}',type:'article',author:${JSON.stringify(process.env.COPILOT_EDITOR_AUTHOR_NAME)}}})});
    return response.json();
  }` });
  expect(output, `Failed to archive article ${id}`).toContain('"archived": true');
}
const body = '#CKEditor__body__editor';
const q = (value) => JSON.stringify(value);
const openInsert = (label) => `
  const editor = page.locator('${body}');
  await editor.waitFor({state:'visible'});
  await editor.locator('p').first().hover();
  await page.locator('.ck-block-toolbar-button:not(.ck-hidden)').click();
  const button = page.getByRole('toolbar',{name:'Editor block content toolbar'}).getByRole('button',{name:${q(label)},exact:true});
  if (await button.count() !== 1 || !(await button.isVisible())) return {missing:${q(label)}};
  await button.click();
`;
const lifecycle = async (client, id, assertion) => {
  await run(client, `
    ${assertion}
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.getByRole('button',{name:'Save',exact:true}).waitFor({state:'visible'});
    return {verified:true};
  `);
  const navigation = await call(client, 'navigate', {url:`${base}/articles/${id}`});
  if (navigation.includes('beforeunload')) await call(client, 'handle_dialog', {accept:true});
  expect((await run(client, `await page.locator('${body}').waitFor({state:'visible'}); ${assertion} return {verified:true};`)).verified).toBe(true);
};
const textBlock = (label, selector, parts) => ({
  insert: `${openInsert(label)}
    const block = page.locator('${body} ${selector}').last();
    await block.waitFor({state:'visible'});
    const editables = block.locator('[contenteditable="true"]');
    if (await editables.count() < ${parts.length}) throw Error('${label}: missing editable fields');
    ${parts.map((part, i) => `await editables.nth(${i}).fill(${q(part)});`).join('\n')}
    return {inserted:true};`,
  assert: `const block = page.locator('${body} ${selector}').last();
    if (await block.count() !== 1) throw Error('${label}: component missing');
    ${parts.map((part) => `if (!(await block.innerText()).includes(${q(part)})) throw Error(${q(`${label}: lost ${part}`)});`).join('\n')}`,
});
const specs = [
  ['TC-014', 'URL embed', {
    insert: `${openInsert('Embed')}
      await page.getByRole('tab',{name:'URL',exact:true}).click();
      await page.getByRole('textbox',{name:'Embed URL'}).fill('https://www.youtube.com/watch?v=jfKfPfyJRdk');
      await page.getByRole('button',{name:'Embed',exact:true}).click(); return {inserted:true};`,
    assert: `const embed = page.locator('${body} [url*="jfKfPfyJRdk"], ${body} [src*="jfKfPfyJRdk"], ${body} [data-url*="jfKfPfyJRdk"]');
      if (await embed.count() < 1) throw Error('YouTube URL embed not rendered with its source');`,
  }],
  ['TC-015', 'code embed', {
    insert: `${openInsert('Embed')}
      await page.getByRole('tab',{name:'Embed Code'}).click();
      await page.getByRole('textbox',{name:'Embed Code'}).fill('<iframe src="https://www.youtube.com/embed/jfKfPfyJRdk" width="560" height="315" title="Live radio"></iframe>');
      await page.getByRole('button',{name:'Embed',exact:true}).click(); return {inserted:true};`,
    assert: `if (await page.locator('${body} [src*="jfKfPfyJRdk"], ${body} [url*="jfKfPfyJRdk"]').count() < 1) throw Error('iframe embed source missing');`,
  }],
  ['TC-016', 'FAQ', {
    insert: `${openInsert('FAQ')}
      const faq = page.locator('${body} cn-faq').last();
      await faq.waitFor({state:'visible'});
      const faqEditor = faq.locator('[contenteditable="true"]');
      await faqEditor.fill('Question 016 unique?');
      await faqEditor.press('Enter');
      await faqEditor.type('Answer 016 unique.');
      return {inserted:true};`,
    assert: `const faq = page.locator('${body} cn-faq').last();
      if (await faq.count() !== 1 || !(await faq.innerText()).includes('Question 016 unique?') || !(await faq.innerText()).includes('Answer 016 unique.')) throw Error('FAQ question or answer lost');`,
  }],
  ['TC-017', 'pull quote', textBlock('Pullquote', 'cn-pullquote', ['Quote 017 unique'])],
  ['TC-018', 'block quote', {
    insert: `${openInsert('Block Quote')} await page.locator('${body} blockquote').last().fill('Quote 018 unique'); return {inserted:true};`,
    assert: `if (!(await page.locator('${body} blockquote').last().innerText()).includes('Quote 018 unique')) throw Error('block quote lost');`,
  }],
  ['TC-019', 'accordion', textBlock('Accordion', 'cn-accordion', ['Accordion 019 title', 'Accordion 019 content'])],
  ['TC-020', 'slide show', {
    ready: () => Array.isArray(fixtures.photos) && fixtures.photos.length >= 2 && fixtures.photos.slice(0, 2).every(x => x?.id && x?.title),
    requirement: 'Two verified selectable photo fixtures required in COPILOT_EDITOR_FIXTURES.photos',
    insert: `${openInsert('Slideshow')}
      const slides = page.locator('${body} cn-slideshow').last();
      await slides.waitFor({state:'visible'});
      for (const photo of ${q(fixtures.photos?.slice(0, 2) || [])}) {
        await slides.locator('button.add-slide-button').click();
        await slides.locator('button.option1FromAsset').click();
        await page.getByRole('tab',{name:'Photo',exact:true}).click();
        await page.getByText(photo.title,{exact:true}).last().click();
        await page.getByRole('button',{name:'1 item selected'}).waitFor();
        await page.getByRole('button',{name:'Submit'}).click();
        await slides.locator('cn-photo[copilotid="' + photo.id + '"]').waitFor({state:'attached'});
      }
      return {inserted:true};`,
    assert: `const slides = page.locator('${body} cn-slideshow');
      if (await slides.count() !== 1) throw Error('Expected one slideshow');
      const ids = await slides.locator('cn-photo[copilotid]').evaluateAll(nodes => nodes.map(node => node.getAttribute('copilotid')));
      const expected = ${q(fixtures.photos?.slice(0, 2).map(x => x.id) || [])};
      if (ids.length < 2 || expected.some((id, index) => ids[index] !== id)) throw Error('Slideshow items missing or reordered: ' + ids);`,
  }],
  ['TC-021', 'table of contents', textBlock('Table of Contents', 'cn-table-of-contents', ['Contents 021 heading', 'Contents 021 entry'])],
  ['TC-022', 'upload', {
    ready: () => isAbsolute(fixtures.uploadPath || '') && /\.(pdf|txt|jpe?g|png|gif)$/i.test(fixtures.uploadPath),
    requirement: 'An authorized PDF, TXT, JPEG, PNG or GIF absolute path required in COPILOT_EDITOR_FIXTURES.uploadPath',
    insert: `await page.locator('${body}').waitFor({state:'visible'});
      await page.locator('${body} p').first().hover();
      await page.locator('.ck-block-toolbar-button:not(.ck-hidden)').click();
      const upload = page.getByRole('toolbar',{name:'Editor block content toolbar'}).getByRole('button',{name:'Upload Media'});
      await upload.locator('input[type="file"]').setInputFiles(${q(fixtures.uploadPath || '')});
      await page.locator(${q(/\.(pdf|txt)$/i.test(fixtures.uploadPath || '') ? `${body} a[href]` : `${body} cn-photo[copilotid]`)}).first().waitFor({state:'attached',timeout:60000});
      return {inserted:true};`,
    assert: /\.(pdf|txt)$/i.test(fixtures.uploadPath || '')
      ? `const link = page.locator('${body} a[href]').filter({hasText:${q(basename(fixtures.uploadPath || ''))}});
        if (await link.count() !== 1 || !(await link.getAttribute('href')) || await link.getAttribute('target') !== '_blank') throw Error('Uploaded document link missing');`
      : `const photo = page.locator('${body} cn-photo[copilotid]');
        if (await photo.count() !== 1 || !(await photo.getAttribute('copilotid')) || await photo.getAttribute('errormessage')) throw Error('Uploaded photo missing or errored');`,
  }],
  ['TC-023', 'sidebar', textBlock('Sidebar', '.ck-sidebar', ['Sidebar 023 unique'])],
  ['TC-024', 'highlight box', textBlock('Highlight Box', 'cn-highlight-box', ['Highlight 024 unique'])],
  ['TC-025', 'table', {
    insert: `${openInsert('Table')}
      const grid = page.getByRole('button',{name:'Insert table'});
      if (await grid.count()) await grid.click();
      const cells = page.locator('${body} table').last().locator('td,th');
      if (await cells.count() < 2) throw Error('Table needs at least two cells');
      await cells.nth(0).fill('Cell 025 A'); await cells.nth(1).fill('Cell 025 B'); return {inserted:true};`,
    assert: `const cells = page.locator('${body} table').last().locator('td,th');
      if (await cells.count() < 2 || !(await cells.nth(0).innerText()).includes('Cell 025 A') || !(await cells.nth(1).innerText()).includes('Cell 025 B')) throw Error('Table cells lost or out of order');`,
  }],
  ['TC-026', 'product summary grid', {
    ready: () => !!fixtures.product?.id && !!fixtures.product?.title,
    requirement: 'Verified selectable product fixture required in COPILOT_EDITOR_FIXTURES.product (and enableProductSummaryGrid)',
    insert: `${openInsert('Product Summary')}
      const grid = page.locator('${body} product-summary').last();
      await grid.waitFor({state:'visible'});
      await grid.getByRole('button',{name:'Add Product'}).click();
      await page.getByRole('tab',{name:'Product',exact:true}).click();
      await page.getByText(${q(fixtures.product?.title || '')},{exact:true}).last().click();
      await page.getByRole('button',{name:'1 item selected'}).waitFor();
      await page.getByRole('button',{name:'Submit'}).click();
      await grid.locator('product-summary-item[uri="/products/${fixtures.product?.id || ''}"]').waitFor({state:'attached'});
      await grid.locator('[slot="edit-title"]').first().fill('Superlative 026 unique');
      return {inserted:true};`,
    assert: `const grid = page.locator('${body} product-summary');
      if (await grid.count() !== 1 || await grid.locator('product-summary-item[uri="/products/${fixtures.product?.id || ''}"]').count() !== 1 || !(await grid.innerText()).includes('Superlative 026 unique')) throw Error('Populated product summary did not persist');`,
  }],
  ['TC-027', 'horizontal line', {
    insert: `${openInsert('Horizontal Line')} return {inserted:true};`,
    assert: `if (await page.locator('${body} hr').count() !== 1) throw Error('Horizontal line missing or duplicated');`,
  }],
  ['TC-028', 'section break', {
    insert: `${openInsert('Section Break')} return {inserted:true};`,
    assert: `if (await page.locator('${body} section-break').count() !== 1) throw Error('Section break missing or duplicated');`,
  }],
  ['TC-029', 'find and replace', {
    insert: `await page.locator('${body}').fill('needle029 first needle029 second needle029 third');
      const find = page.getByRole('button',{name:'Find and Replace'});
      if (await find.count() !== 1 || !(await find.isVisible())) return {missing:'Find and Replace (enableFindAndReplace)'};
      await find.click();
      await page.getByRole('textbox',{name:/find/i}).fill('needle029');
      const matches = await page.locator('${body} .ck-find-result').count();
      if (matches !== 3) throw Error('Expected three highlighted matches, got ' + matches);
      await page.getByRole('textbox',{name:/replace/i}).fill('replacement029');
      await page.getByRole('button',{name:'Replace all'}).click();
      if ((await page.locator('${body}').innerText()).match(/replacement029/g)?.length !== 3) throw Error('Replace all failed');
      return {inserted:true};`,
    assert: `const text = await page.locator('${body}').innerText();
      if ((text.match(/replacement029/g) || []).length !== 3 || text.includes('needle029')) throw Error('Replacement did not persist exactly three times');`,
  }],
];

for (const [id, name, spec] of specs) {
  test(`${id} ${name}: editor rendering and save/reopen`, async () => {
    test.skip(!/^[a-zA-Z0-9_-]+$/.test(organizationId || '') || !process.env.COPILOT_EDITOR_AUTHOR_NAME, 'Set verified COPILOT_EDITOR_ORGANIZATION_ID and COPILOT_EDITOR_AUTHOR_NAME for cleanup');
    test.skip(spec.ready && !spec.ready(), spec.requirement);
    const client = await connect();
    let articleId;
    try {
      const created = await run(client, `
        await page.goto('${base}');
        await page.getByRole('button',{name:'Create a new...'}).click();
        await page.getByRole('menuitem',{name:'Article',exact:true}).click();
        await page.getByRole('dialog',{name:'Create Article'}).getByRole('button',{name:'Create'}).click();
        await page.waitForURL(/\\/articles\\/[a-f0-9]{24}$/);
        return {id:page.url().split('/').pop()};
      `);
      articleId = created.id;
      expect(articleId).toMatch(/^[a-f0-9]{24}$/);
      await run(client, `await page.locator('#CKEditor__hed__editor').fill(${q(`${id} editor tool ${articleId}`)}); return {ready:true};`);
      const inserted = await run(client, spec.insert);
      test.skip(!!inserted.missing, `${id}: editor plugin unavailable in this tenant: ${inserted.missing}`);
      expect(inserted.inserted).toBe(true);
      await lifecycle(client, articleId, spec.assert);
      // Save/reopen only. Publish and schedule require separate, publishable articles
      // and confirmed workflow state; neither is exercised by this suite.
    } finally {
      try { if (articleId) await archive(client, articleId); }
      finally { await client.close(); }
    }
  });
}
