'use strict';
// Explicit operator action: creates TWO NEW dedicated storage tables, never edits existing ones.
const { FeishuClient } = require('../storage/feishu.cjs');
(async () => {
  if (!process.argv.includes('--create-test-tables')) throw Error('Pass --create-test-tables to create a new pilot storage area');
  const client = new FeishuClient();
  for (const namespace of ['catering', 'hotel']) {
    const result = await client.request('POST', `/bitable/v1/apps/${encodeURIComponent(process.env.FEISHU_APP_TOKEN)}/tables`, {
      table: { name: `教学试点_${namespace}_${Date.now()}`, default_view_name: '内部存储',
        fields: [{ field_name: 'key', type: 1 }, { field_name: 'payload', type: 1 }] }
    });
    const table = result?.table_id;
    if (!table) throw Error('No table ID returned; inspect Feishu before retrying');
    // Print non-secret IDs immediately so interrupted setup can be recovered manually.
    console.log(`FEISHU_${namespace.toUpperCase()}_TABLE_ID=${table}`);
    const head = await client.create(table, { key: '@head:' + namespace,
      payload: JSON.stringify({ version: 1, namespace, seq: 0, id: null }) });
    console.log(`FEISHU_${namespace.toUpperCase()}_HEAD_ID=${head}`);
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
