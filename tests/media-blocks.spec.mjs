import { test, expect } from '@playwright/test';
import { connect, call } from '../scripts/mcp.mjs';

// These are UI tests against the authenticated MCP browser, not model/HTML injections.
// MEDIA_PHOTO_TITLES must be a JSON array of six distinct, selectable photo titles
// in the /bon tenant. MEDIA_ORGANIZATION_ID is required for cleanup.
// Publication flows remain unverified: do not report them as passing tests.
// Create, asset-picker, and save controls below are staging UI selectors, not
// guaranteed by the CKEditor plugin source; validate them against /bon before use.
const base = 'https://stg-copilot-app.condenast.io/bon';
const layouts = [
  { name: 'Group of 2', button: 'Group of 2', className: 'group-2', count: 2 },
  { name: 'Group of 3', button: 'Group of 3', className: 'group-3', count: 3 },
  { name: 'Group of 4', button: 'Group of 4', className: 'group-4', count: 4 },
  { name: 'Masonry Grid', button: 'Masonry', className: 'masonry', count: 6 },
];
const cases = [
  ...layouts.map((layout, i) => ({ id: `TC-${String(30 + i).padStart(3, '0')}`, layout })),
  ...layouts.flatMap((layout, i) => ['Fade In', 'Slide In'].map(animation => ({ id: `TC-${String(35 + i).padStart(3, '0')}`, layout, animation }))),
  ...layouts.flatMap((layout, i) => ['Small', 'Medium', 'Large'].map(size => ({ id: `TC-${String(39 + i).padStart(3, '0')}`, layout, size }))),
];

// playwright.config.mjs uses one worker; each test owns and archives its article.

async function run(client, code) {
  const output = await call(client, 'run_code_unsafe', { code: `async (page) => { ${code} }` });
  const result = output.match(/### Result\n([\s\S]*?)\n### Ran Playwright code/);
  if (!result) throw new Error(`MCP action did not finish: ${output.slice(-1200)}`);
  return JSON.parse(result[1]);
}

async function reopen(client, id) {
  // Native beforeunload is handled explicitly; never assume a navigation saved data.
  const output = await call(client, 'navigate', { url: `${base}/articles/${id}` });
  if (output.includes('beforeunload')) await call(client, 'handle_dialog', { accept: true });
}

async function archive(client, id) {
  const output = await call(client, 'evaluate', { function: `async () => {
    const query = 'mutation($org:ID!,$id:String!,$type:String!,$author:String!){archive(organizationId:$org,id:$id,contentType:$type,authorName:$author){id archived}}';
    const response = await fetch('/gql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query,variables:{org:${JSON.stringify(process.env.MEDIA_ORGANIZATION_ID)},id:${JSON.stringify(id)},type:'article',author:${JSON.stringify(process.env.MEDIA_AUTHOR_NAME)}}})});
    return response.json();
  }` });
  expect(output, `archive article ${id}`).toContain('"archived": true');
}

function checkCode({ layout, animation, size }) {
  return `
    const group = page.locator('#CKEditor__body__editor .ck-group');
    await group.waitFor({state:'visible',timeout:30000});
    if (await group.count() !== 1) throw Error('Expected exactly one Media Block');
    if (!await group.evaluate((el, direction) => el.classList.contains(direction), ${JSON.stringify(layout.className)})) throw Error('Incorrect art direction');
    const items = group.locator(':scope > .ck-group-item');
    if (await items.count() !== ${layout.count}) throw Error('Incorrect item count');
    if (await group.locator('.ck-group-item-placeholder').count()) throw Error('Unfilled Media Block');
    const photos = items.locator('cn-photo');
    if (await photos.count() !== ${layout.count}) throw Error('Expected one photo per group item');
    const ids = await photos.evaluateAll(nodes => nodes.map(node => node.getAttribute('copilotid')));
    if (ids.some(id => !id) || new Set(ids).size !== ${layout.count}) throw Error('Photo IDs missing/duplicated');
    for (const photo of await photos.all()) {
      await photo.locator('img').first().waitFor({state:'visible',timeout:30000});
      if (!await photo.locator('img').first().evaluate(img => img.complete && img.naturalWidth > 0)) throw Error('Photo did not render');
    }
    if (${JSON.stringify(Boolean(animation))}) {
      // Editing view does not downcast animation; check the selected toolbar value.
      await group.click();
      const selected = page.getByRole('button',{name:'Animation',exact:true});
      await selected.click();
      const choice = page.getByRole('button',{name:${JSON.stringify(animation)},exact:true});
      if (await choice.getAttribute('aria-pressed') !== 'true' && !await choice.evaluate(el => el.classList.contains('ck-on'))) throw Error('Animation not selected');
      await selected.click();
    }
    if (${JSON.stringify(Boolean(size))}) {
      if (await group.getAttribute('data-layout') !== ${JSON.stringify(size ? `SIZE_${size.toUpperCase()}` : null)}) throw Error('Size not preserved in editing view');
      await group.click();
      const button = page.getByRole('button',{name:${JSON.stringify(size)},exact:true}).last();
      if (!await button.evaluate(el => el.classList.contains('ck-on'))) throw Error('Size not selected');
    }
    return {ids};
  `;
}

for (const variant of cases) {
  for (const state of ['save', 'publish', 'schedule']) {
    test(`${variant.id} ${variant.layout.name}${variant.animation ? ` / ${variant.animation}` : ''}${variant.size ? ` / ${variant.size}` : ''} — ${state} and reopen`, async () => {
      const titles = JSON.parse(process.env.MEDIA_PHOTO_TITLES || '[]');
      test.skip(titles.length < 6 || new Set(titles).size < 6, 'Requires MEDIA_PHOTO_TITLES: six distinct, selectable tenant photo titles');
      test.skip(state !== 'save', 'UNVERIFIED: publish/schedule dialog, required metadata, and persisted publication state have not been validated on /bon');
      test.skip(!process.env.MEDIA_ORGANIZATION_ID || !process.env.MEDIA_AUTHOR_NAME, 'Requires verified MEDIA_ORGANIZATION_ID and MEDIA_AUTHOR_NAME for safe cleanup in /bon');
      const client = await connect();
      let id;
      try {
        const created = await run(client, `
          await page.goto('${base}');
          if (/login|signin|oauth/i.test(page.url())) return {auth:false};
          await page.getByRole('button',{name:'Create a new...'}).click();
          await page.getByRole('menuitem',{name:'Article',exact:true}).click();
          await page.getByRole('dialog',{name:'Create Article'}).getByRole('button',{name:'Create'}).click();
          await page.waitForURL(/\\/bon\\/articles\\/[a-f0-9]{24}$/);
          return {auth:true,id:page.url().split('/').pop()};
        `);
        test.skip(!created.auth, 'MCP browser is not authenticated to staging Copilot');
        id = created.id;
        expect(id).toMatch(/^[a-f0-9]{24}$/);
        const available = await run(client, `
          await page.locator('#CKEditor__body__editor').waitFor({state:'visible'});
          await page.locator('#CKEditor__hed__editor').fill(${JSON.stringify(`Media block ${variant.id} ${state} ${variant.animation || variant.size || ''}`)});
          await page.locator('#CKEditor__body__editor').click();
          await page.locator('#CKEditor__body__editor p').first().hover();
          await page.locator('.ck-block-toolbar-button:not(.ck-hidden)').click();
          return {media:await page.getByRole('toolbar',{name:'Editor block content toolbar'}).getByRole('button',{name:'Media Block'}).count()};
        `);
        test.skip(!available.media, 'Group/ckeditorMediaBlock is not enabled in this article body');
        await run(client, `
          await page.getByRole('toolbar',{name:'Editor block content toolbar'}).getByRole('button',{name:'Media Block'}).click();
          const group = page.locator('#CKEditor__body__editor .ck-group');
          await group.waitFor({state:'visible'});
          if (!await group.evaluate(el => el.classList.contains('group-2'))) throw Error('Default is not Group of 2');
          if (await group.locator(':scope > .ck-group-item').count() !== 2) throw Error('Default must contain two slots');
          await group.click();
          ${variant.layout.className !== 'group-2' ? `
          const layoutButton = page.getByRole('button',{name:${JSON.stringify(variant.layout.button)},exact:true});
          if (await layoutButton.count() !== 1) return {layoutAvailable:false};
          await layoutButton.click();
          ` : ''}
          return {layoutAvailable:true};
        `).then(result => { test.skip(!result.layoutAvailable, `${variant.layout.name} requires ckeditorMediaBlockMasonry / configured art direction`); });
        await run(client, `
          const group = page.locator('#CKEditor__body__editor .ck-group');
          if (await group.locator(':scope > .ck-group-item').count() !== ${variant.layout.count}) throw Error('Layout did not resize slots');
          for (const title of ${JSON.stringify(titles.slice(0, variant.layout.count))}) {
            await group.getByRole('button',{name:'Add Asset'}).first().click();
            await page.getByRole('tab',{name:'Photo',exact:true}).click();
            const photo = page.getByText(title,{exact:true}).last();
            await photo.waitFor({state:'visible',timeout:30000});
            await photo.click();
            await page.getByRole('button',{name:'1 item selected'}).waitFor();
            await page.getByRole('button',{name:'Submit'}).click();
          }
          await group.click();
          ${variant.animation ? `
          await page.getByRole('button',{name:'Animation',exact:true}).click();
          await page.getByRole('button',{name:${JSON.stringify(variant.animation)},exact:true}).click();
          ` : ''}
          ${variant.size ? `
          const sizeButton = page.getByRole('button',{name:${JSON.stringify(variant.size)},exact:true});
          if (await sizeButton.count() !== 1) return {sizeAvailable:false};
          await sizeButton.click();
          ` : ''}
          return {sizeAvailable:true};
        `).then(result => { test.skip(!result.sizeAvailable, `Group size ${variant.size} not configured on this tenant`); });
        const before = await run(client, checkCode(variant));
        await run(client, `
          await page.getByRole('button',{name:'Save',exact:true}).click();
          return true;
        `);
        await reopen(client, id);
        const saved = await run(client, checkCode(variant));
        expect(saved.ids).toEqual(before.ids);
      } finally {
        try { if (id) await archive(client, id); }
        finally { await client.close(); }
      }
    });
  }
}
