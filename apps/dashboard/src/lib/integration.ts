/** The guide and Settings show the same client configuration. */
export function openClawConfig(base: string): string {
  return JSON.stringify({ agents: { defaults: { model: { primary: 'ai-model-router/auto' } } }, models: { mode: 'merge', providers: { 'ai-model-router': { baseUrl: `${base}/v1`, apiKey: '${AI_MODEL_ROUTER_KEY}', api: 'openai-completions', models: [{ id: 'auto', name: 'AI Model Router', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 4096 }] } } } }, null, 2);
}

export function clientTestCommands(base: string): string {
  const quoted = `${base}/v1`.replaceAll("'", "''");
  return `$env:AI_MODEL_ROUTER_BASE_URL = '${quoted}'\n$routerTestSecret = Read-Host 'Router key' -AsSecureString\n$env:AI_MODEL_ROUTER_KEY = [System.Net.NetworkCredential]::new('', $routerTestSecret).Password\nnpm run test:client\nnpm run test:client -- --tools\nRemove-Item Env:AI_MODEL_ROUTER_KEY`;
}

export function nodeClientExample(base: string): string {
  return `const response = await fetch(${JSON.stringify(`${base}/v1/chat/completions`)}, {\n  method: 'POST',\n  headers: {\n    Authorization: \`Bearer \${process.env.AI_MODEL_ROUTER_KEY}\`,\n    'Content-Type': 'application/json',\n  },\n  body: JSON.stringify({\n    model: 'auto',\n    messages: [{ role: 'user', content: 'Explain binary search.' }],\n  }),\n});\nif (!response.ok) throw new Error(await response.text());\nconst completion = await response.json();\nconsole.log(completion.choices[0].message.content);`;
}
