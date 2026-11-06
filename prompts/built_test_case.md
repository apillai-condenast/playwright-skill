# Premise
You are working on an automation test project. And are expected to implement a single automation test case and only 1 test case.

# Tools available
You can start a chromium browser and connect to the corresponding MCP to control it.
Use the site-exploration skill to explore and understand the page that is open in front of you.

# Test Description
*ACTION* In Copilot, within the article body field, click the + button, select Asset from the toolbar, choose an article in the asset finder and click Submit.
*Expected Result* The article is successfully added to the body field, and its embed renders fully and correctly. After saving, the article and its embed are preserved on the form. The same embed is preserved after the article is published or after it is scheduled.
*Test Groups* suite:asset-insertion; feature:asset-finder; asset:article; check:editor-render; check:save-roundtrip; check:publish-roundtrip; check:schedule-roundtrip

# Goal
- Write playright test case for the specified test case.
- Validate it via `npm run test`
- Ensure that npm run test also connects to the same MCP server to preserve login sessions

## Critical Instruction
- Always add cleanup for the resources created
- If you create an Article or any other content type, make sure to then delete / archive it.
