/**
 * Live, web-grounded research via Perplexity (sonar) — real sources, not model
 * memory. Citations are returned so they can be recorded in the receipt, making
 * the agent's findings auditable. Falls back to the LLM if no key is configured.
 */
import { complete } from './anthropic';

export interface ResearchResult {
  answer: string;
  citations: string[];
  grounded: boolean; // true if live web sources were used
}

export async function liveResearch(query: string): Promise<ResearchResult> {
  const key = process.env.PERPLEXITY_API_KEY;
  if (key) {
    try {
      const res = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'sonar',
          messages: [
            { role: 'system', content: 'You are a precise research analyst. Answer factually and concisely: 3-5 key findings as bullets, then a one-line takeaway. Cite sources.' },
            { role: 'user', content: query },
          ],
        }),
      });
      if (res.ok) {
        const j = (await res.json()) as {
          choices: Array<{ message: { content: string } }>;
          citations?: string[];
          search_results?: Array<{ url?: string }>;
        };
        const answer = j.choices?.[0]?.message?.content ?? '';
        const citations = (j.citations ?? j.search_results?.map(s => s.url ?? '').filter(Boolean) ?? []).slice(0, 8);
        if (answer) return { answer, citations, grounded: true };
      }
    } catch {
      /* fall through to LLM */
    }
  }
  // Fallback: model knowledge (clearly marked as not web-grounded).
  const answer = await complete(
    'You are a precise research assistant. Give 3-5 bullet findings then a one-line takeaway. Be honest about uncertainty since you have no live web access here.',
    `Research this: ${query}`,
    900,
  );
  return { answer, citations: [], grounded: false };
}
