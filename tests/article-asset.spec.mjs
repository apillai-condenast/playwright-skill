import { test, expect } from '@playwright/test';
import { connect, call } from '../scripts/mcp.mjs';

const base = 'https://stg-copilot-app.condenast.io';
const organizationId = '4gKgcEpw2w2TyiyPvsZYqcEh8EVy'; // Allure, observed in authenticated CreateArticle requests.
const sourceId = '6aec8daa6e16e59353c78f57';
const sourceTitle = "Margot Robbie's Hair Is So Much Shorter and Blonder";

// browser_run_code_unsafe executes real Playwright actions inside the SAME authenticated MCP browser.
async function run(client, code) {
  const output = await call(client, 'run_code_unsafe', { code: `async (page) => { ${code} }` });
  const result = output.match(/### Result\n([\s\S]*?)\n### Ran Playwright code/);
  if (!result) throw new Error(`MCP action did not finish (possibly blocked by a dialog): ${output.slice(-1000)}`);
  return JSON.parse(result[1]);
}
const verify = `
  const embed = page.locator('#CKEditor__body__editor cn-copilot-embed[copilottype="article"]');
  await embed.waitFor({state:'visible',timeout:30000});
  if (await embed.count() !== 1 || await embed.getAttribute('copilotid') !== '${sourceId}') throw Error('Article asset missing or duplicated');
  for (const [attr, text] of [['title','Margot Robbie'],['byline','Kara Nesvig'],['channel','Hair']]) {
    if (!(await embed.getAttribute(attr))?.includes(text)) throw Error('Incomplete embed: ' + attr);
  }
  if (!(await embed.locator('a:has-text("View Asset")').getAttribute('href')).includes('${sourceId}')) throw Error('View Asset link missing');
  await embed.locator('img').waitFor({state:'visible'});
  if (!(await embed.locator('img').evaluate(img => img.complete && img.naturalWidth > 0))) throw Error('Embed image did not load');
`;

test('insert article asset; verify render and save roundtrip (publication validation)', async () => {
  const client = await connect();
  let id;
  try {
    const first = await run(client, `
      await page.goto('${base}/all');
      await page.getByRole('button',{name:'Create a new...'}).click();
      await page.getByRole('menuitem',{name:'Article',exact:true}).click();
      await page.getByRole('dialog',{name:'Create Article'}).getByRole('button',{name:'Create'}).click();
      await page.waitForURL(/\\/all\\/articles\\/[a-f0-9]{24}$/);
      return {id:page.url().split('/').pop()};
    `);
    id = first.id;
    expect(id).toMatch(/^[a-f0-9]{24}$/);
    await run(client, `
      await page.locator('#CKEditor__body__editor').waitFor({state:'visible'});
      await page.locator('#CKEditor__hed__editor').fill('Asset embed roundtrip ' + '${id}');
      await page.locator('#CKEditor__body__editor').click();
      await page.locator('#CKEditor__body__editor p').hover();
      await page.locator('.ck-block-toolbar-button:not(.ck-hidden)').click();
      await page.getByRole('toolbar',{name:'Editor block content toolbar'}).getByRole('button',{name:'Asset'}).click();
      await page.getByRole('tab',{name:'Article',exact:true}).click();
      await page.getByText(${JSON.stringify(sourceTitle)},{exact:true}).last().click();
      await page.getByRole('button',{name:'1 item selected'}).waitFor();
      await page.getByRole('button',{name:'Submit'}).click();
      ${verify}
      await page.getByRole('button',{name:'Save',exact:true}).click();
      await page.getByRole('button',{name:'Save',exact:true}).waitFor({state:'visible'});
      return {inserted:true};
    `);
    // MCP pauses for native beforeunload dialogs; handle them using the MCP dialog tool.
    const navigation = await call(client,'navigate',{url:`${base}/all/articles/${id}`});
    if (navigation.includes('beforeunload')) await call(client,'handle_dialog',{accept:true});
    const roundtrip = await run(client, `
      await page.locator('#CKEditor__body__editor').waitFor({state:'visible'});
      ${verify}
      return {saved:true};
    `);
    expect(roundtrip.saved).toBe(true);
    // A bare test article cannot be published: the CMS requires a site image,
    // section, channel and other editorial metadata. Verify it blocks publication
    // rather than silently treating a click on Publish as a successful publish.
    const validation = await run(client, `
      await page.getByRole('button',{name:'Publish',exact:true}).click();
      ${verify}
      return {errors:await page.locator('[role="alert"]').allInnerTexts()};
    `);
    expect(validation.errors.join(' ')).toContain('Site Image must be present');
    expect(validation.errors.join(' ')).toContain('You must choose 1 category for Channels');
  } finally {
    try {
      if (id) {
        // Archive even if an assertion fails.
        const cleanup = await call(client,'evaluate',{function:`async () => {
        const query = 'mutation($org:ID!,$id:String!,$type:String!,$author:String!){archive(organizationId:$org,id:$id,contentType:$type,authorName:$author){id archived}}';
        const r = await fetch('/gql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query,variables:{org:'${organizationId}',id:'${id}',type:'article',author:'Adit Pillai'}})});
        return r.json();
      }`});
        expect(cleanup).toContain('"archived": true');
      }
    } finally { await client.close(); }
  }
});
