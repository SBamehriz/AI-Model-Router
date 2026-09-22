import { describe, it, expect } from 'vitest';
import { clientTestCommands, nodeClientExample, openClawConfig } from '../integration';

/**
 * Settings, the in-app guide and the integration documentation are meant to
 * show the same connection details. These pin the parts a reader copies
 * verbatim, so a change here has to be a deliberate one.
 */
describe('OpenClaw configuration', () => {
  const config = openClawConfig('https://router.example.com');

  it('is valid JSON a reader can paste unchanged', () => {
    expect(() => JSON.parse(config)).not.toThrow();
  });

  it('uses the documented provider API, model reference and /v1 base', () => {
    const parsed = JSON.parse(config);
    const provider = parsed.models.providers['ai-model-router'];
    expect(provider.api).toBe('openai-completions');
    expect(provider.baseUrl).toBe('https://router.example.com/v1');
    expect(parsed.agents.defaults.model.primary).toBe('ai-model-router/auto');
    expect(provider.models.map((m: { id: string }) => m.id)).toContain('auto');
  });

  it('never embeds the key itself, only the environment reference', () => {
    const provider = JSON.parse(config).models.providers['ai-model-router'];
    expect(provider.apiKey).toBe('${AI_MODEL_ROUTER_KEY}');
  });
});

describe('copyable commands', () => {
  it('escapes a quote so the PowerShell snippet cannot be broken out of', () => {
    const commands = clientTestCommands("https://host/'; Remove-Item C:\\ #");
    const assignment = commands.split('\n')[0];
    expect(assignment.startsWith("$env:AI_MODEL_ROUTER_BASE_URL = '")).toBe(true);
    expect(assignment.endsWith("'")).toBe(true);
    // Every inner quote is doubled, which is how PowerShell keeps it literal.
    const inner = assignment.slice("$env:AI_MODEL_ROUTER_BASE_URL = '".length, -1);
    expect(inner.replaceAll("''", '')).not.toContain("'");
  });

  it('reads the key from the environment in the Node example', () => {
    const example = nodeClientExample('http://localhost:3000');
    expect(example).toContain('http://localhost:3000/v1/chat/completions');
    expect(example).toContain('process.env.AI_MODEL_ROUTER_KEY');
    expect(example).toContain("model: 'auto'");
  });
});
