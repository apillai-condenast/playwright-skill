import { test, expect } from '@playwright/test';
import { connect, call } from '../scripts/mcp.mjs';

// Supply selectable assets observed in Bon, not examples from another tenant.
// COPILOT_ASSET_FIXTURES='{"article":{"id":"...","title":"..."}}'
const base = 'https://stg-copilot-app.condenast.io/bon';
const cases = [
  ['TC-001', 'article', 'Article', 'cn-copilot-embed'],
  ['TC-002', 'clip', 'Clip', 'cn-clip'],
  ['TC-003', 'cnevideo', 'CNE Video', 'cne-embed'],
  ['TC-004', 'contributor', 'Contributor', 'cn-copilot-embed'],
  ['TC-005', 'curatedlist', 'Curated List', 'cn-copilot-embed'],
  ['TC-006', 'event', 'Event', 'cn-copilot-embed'],
  ['TC-007', 'externallink', 'External Link', 'cn-copilot-embed'],
  ['TC-008', 'gallery', 'Gallery', 'cn-gallery'],
  ['TC-009', 'livestory', 'Live Story', 'cn-copilot-embed'],
  ['TC-010', 'nativearticle', 'Native Article', 'cn-copilot-embed'],
  ['TC-011', 'nativegallery', 'Native Gallery', 'cn-copilot-embed'],
  ['TC-012', 'product', 'Product', 'cn-product'],
  ['TC-013', 'visualstory', 'Visual Story', 'cn-copilot-embed'],
];

function fixtures() {
  return JSON.parse(process.env.COPILOT_ASSET_FIXTURES || '{}');
}

// MCP run_code_unsafe operates on the authenticated MCP page, not Playwright's independent browser.
async function run(client, code) {
  const output = await call(client, 'run_code_unsafe', { code: `async (page) => { ${code} }` });
  const result = output.match(/### Result\n([\s\S]*?)\n### Ran Playwright code/);
  if (!result) throw new Error(`MCP action did not complete: ${output.slice(-1000)}`);
  return JSON.parse(result[1]);
}

async function reopen(client, id) {
  const output = await call(client, 'navigate', { url: `${base}/articles/${id}` });
  if (output.includes('beforeunload')) await call(client, 'handle_dialog', { accept: true });
}

// Resolve the current user and Bon organization using the application's own GraphQL schema.
// Never clean up against a guessed organization or with a guessed author.
async function archiveIdentity(client) {
  const result = await run(client, `
    const query = 'query { currentUser { firstName lastName organizations { organizationId organizationSlug } } }';
    return page.evaluate(async query => {
      const r = await fetch('/gql', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query})});
      return r.json();
    }, query);
  `);
  const user = result.data?.currentUser;
  const organizations = user?.organizations?.filter(org => org.organizationSlug === 'bon');
  if (result.errors?.length || organizations?.length !== 1 || !organizations[0].organizationId || !user.firstName || !user.lastName) {
    throw new Error(`Cannot identify current Bon user/organization for safe cleanup: ${JSON.stringify(result).slice(0, 500)}`);
  }
  return { organizationId: organizations[0].organizationId, authorName: `${user.firstName} ${user.lastName}` };
}

// Check the actual editor element, the selected asset identity and type-specific UI.
// Shadow DOM locators pierce the nested web components in the CKEditor build.
function renderCheck(type, tag, fixture) {
  const selector = `#CKEditor__body__editor ${tag}` + (tag === 'cn-copilot-embed' ? `[copilottype="${type}"]` : '');
  return `
    const embed = page.locator(${JSON.stringify(selector)});
    await embed.waitFor({state:'visible',timeout:30000});
    if (await embed.count() !== 1) throw Error('Expected exactly one ${type} embed');
    ${type === 'cnevideo'
      ? `if (await embed.getAttribute('uri') !== ${JSON.stringify(fixture.uri)}) throw Error('Wrong CNE video URI');`
      : `if (await embed.getAttribute('copilotid') !== ${JSON.stringify(fixture.id)}) throw Error('Wrong ${type} asset ID');`}
    if (await embed.getAttribute('error') !== null) throw Error('${type} embed reports an error');
    ${tag === 'cn-copilot-embed' ? `
      await embed.locator('copilot-embed').waitFor({state:'visible'});
      await embed.locator('view-asset').waitFor({state:'visible'});
    ` : ''}
  `;
}

async function archive(client, id, identity) {
  const result = await run(client, `
    const query = 'mutation($org:ID!,$id:String!,$type:String!,$author:String!){archive(organizationId:$org,id:$id,contentType:$type,authorName:$author){id archived}}';
    const variables = ${JSON.stringify({ org: identity.organizationId, id, type: 'article', author: identity.authorName })};
    return page.evaluate(async ({query, variables}) => {
      const r = await fetch('/gql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query,variables})});
      return r.json();
    }, {query, variables});
  `);
  expect(result.errors, `Failed to archive created article ${id}`).toBeUndefined();
  expect(result.data?.archive?.id).toBe(id);
  expect(result.data?.archive?.archived).toBe(true);
}

for (const [caseId, type, tab, tag] of cases) {
  test(`${caseId} ${type}: insert, render and save roundtrip (publish/schedule not covered)`, async () => {
    const fixture = fixtures()[type];
    test.skip(!fixture?.id || !fixture?.title || (type === 'cnevideo' && !fixture?.uri),
      `No verified selectable ${type} fixture in Bon; provide COPILOT_ASSET_FIXTURES with id, title and CNE video uri if applicable`);
    const client = await connect();
    let id;
    let identity;
    try {
      await run(client, `await page.goto('${base}/all'); return {ready:true};`);
      identity = await archiveIdentity(client);
        const created = await run(client, `
          await page.goto('${base}/all');
          await page.getByRole('button',{name:'Create a new...'}).click();
          await page.getByRole('menuitem',{name:'Article',exact:true}).click();
          await page.getByRole('dialog',{name:'Create Article'}).getByRole('button',{name:'Create'}).click();
          await page.waitForURL(/\\/bon\\/articles\\/[a-f0-9]{24}$/);
          return {id:page.url().split('/').pop()};
        `);
        id = created.id;
        expect(id).toMatch(/^[a-f0-9]{24}$/);
        await run(client, `
          await page.locator('#CKEditor__body__editor').waitFor({state:'visible'});
          await page.locator('#CKEditor__hed__editor').fill(${JSON.stringify(`${caseId} ${type} embed test `)} + ${JSON.stringify(id)});
          await page.locator('#CKEditor__body__editor').click();
          await page.locator('#CKEditor__body__editor p').hover();
          await page.locator('.ck-block-toolbar-button:not(.ck-hidden)').click();
          await page.getByRole('toolbar',{name:'Editor block content toolbar'}).getByRole('button',{name:'Asset'}).click();
          const tab = page.getByRole('tab',{name:${JSON.stringify(tab)},exact:true});
          await tab.waitFor({state:'visible'});
          await tab.click();
          const result = page.getByText(${JSON.stringify(fixture.title)},{exact:true}).last();
          await result.waitFor({state:'visible',timeout:30000});
          await result.click();
          await page.getByRole('button',{name:'1 item selected'}).waitFor();
          await page.getByRole('button',{name:'Submit'}).click();
          ${renderCheck(type, tag, fixture)}
          await page.getByRole('button',{name:'Save',exact:true}).click();
          await page.getByRole('button',{name:'Save',exact:true}).waitFor({state:'visible'});
          return {inserted:true};
        `);
        await reopen(client, id);
        await run(client, `
          await page.locator('#CKEditor__body__editor').waitFor({state:'visible'});
          ${renderCheck(type, tag, fixture)}
          return {preserved:true};
        `);
    } finally {
      try { if (id && identity) await archive(client, id, identity); }
      finally { await client.close(); }
    }
  });
}
