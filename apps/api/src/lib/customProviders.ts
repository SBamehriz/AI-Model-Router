import { z } from 'zod';
import { sanitizeLabel } from './sanitize.js';

// The administrator chooses the destination. Never accept credentials in URLs,
// insecure remote endpoints, query strings, or redirects carrying bearer keys.
export const CustomProviderSchema = z.object({
  provider: z.string().regex(/^custom-[a-z0-9][a-z0-9-]{0,49}$/),
  name: z.string().trim().min(1).max(80).transform(sanitizeLabel).refine((value) => value.length > 0, 'Name cannot be only formatting characters'),
  base_url: z.string().trim().url().max(2048).refine((value) => {
    try {
      const url = new URL(value);
      return !url.username && !url.password && !url.search && !url.hash &&
        (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) &&
        !url.pathname.replace(/\/+$/, '').endsWith('/chat/completions');
    } catch {
      return false;
    }
  }, 'Use an HTTPS API base URL (HTTP only for localhost), without credentials, query parameters, or /chat/completions.').transform((value) => value.replace(/\/+$/, '')),
  key: z.string().trim().min(8).max(4096).regex(/^[\x21-\x7e]+$/).optional(),
  model: z.object({
    model_name: z.string().trim().min(1).max(200).regex(/^[\x21-\x7e]+$/),
    cost_input: z.number().finite().min(0).max(1000),
    cost_output: z.number().finite().min(0).max(1000),
    max_tokens: z.number().int().min(1024).max(10000000),
    supports_functions: z.boolean(),
    quality_rating: z.number().min(0).max(100),
    avg_latency: z.number().int().min(1).max(600000),
    strengths: z.array(z.enum(['chat', 'coding', 'debugging', 'reasoning', 'math_reasoning', 'writing', 'email', 'summarization', 'translation', 'data_analysis', 'planning', 'customer_support', 'agent_step'])).min(1).max(13),
  }).strict(),
}).strict();
