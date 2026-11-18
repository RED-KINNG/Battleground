const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { Ratelimit } = require('@upstash/ratelimit');
const { Redis } = require('@upstash/redis');
// Helpers live in api/_lib/ — Vercel skips underscore-prefixed paths, so they don't become routes.
const { JUDGE_SYSTEM_PROMPT } = require('./_lib/judge-prompt');
const { ART_STYLE_TEMPLATE } = require('./_lib/art-style');

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env
const openai = new OpenAI(); // reads OPENAI_API_KEY from env

// The model picks a side label rather than echoing fighter text, so the winner is
// unambiguous even when both fighters have identical names ("cow" vs "cow").
const VerdictSchema = z.object({
  winner: z.enum(['A', 'B']),
  reasoning: z.string(),
});

const MAX_FIGHTER_LENGTH = 50;

// 5 fights/minute per IP, counted in Upstash Redis so every serverless instance
// shares one count (an in-memory counter resets per instance and per cold start).
// Reads UPSTASH_REDIS_REST_URL/TOKEN (or Vercel's KV_REST_API_URL/TOKEN) from env.
// If Redis doesn't answer within 1s the request is let through rather than
// blocking every fight during an Upstash outage.
const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(5, '60 s'),
  prefix: 'battleground:fight',
  timeout: 1000,
});

class ModerationBlockedError extends Error {}

// One image per fighter, whatever the input ("10 cows" still gets one image,
// not ten) — that's on the model to honor from the prompt text itself.
async function generateFighterImage(fighterText) {
  let result;
  try {
    result = await openai.images.generate({
      model: 'gpt-image-1.5',
      prompt: `A single character portrait representing: ${fighterText}. ${ART_STYLE_TEMPLATE}`,
      size: '1024x1024',
      n: 1,
    });
  } catch (err) {
    // Only moderation blocks need translating; anything else propagates with its original details.
    const code = err?.code || err?.error?.code;
    if (code === 'moderation_blocked' || code === 'content_policy_violation') {
      throw new ModerationBlockedError(fighterText);
    }
    throw err;
  }
  const b64 = result.data?.[0]?.b64_json;
  if (!b64) throw new Error('No image returned');
  return `data:image/png;base64,${b64}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';

  let success = true;
  try {
    ({ success } = await ratelimit.limit(ip));
  } catch (err) {
    // Same fail-open policy as the timeout: a Redis error shouldn't take the whole app down.
    console.error('Rate limit check failed, allowing request:', err);
  }
  if (!success) {
    res.status(429).json({ error: "Whoa there, champ — the arena needs a breather. Give it a minute and step back up." });
    return;
  }

  const body = req.body || {};
  const fighterA = typeof body.fighterA === 'string' ? body.fighterA.trim() : '';
  const fighterB = typeof body.fighterB === 'string' ? body.fighterB.trim() : '';
  if (!fighterA || !fighterB) {
    res.status(400).json({ error: "Can't have a fight with an empty corner — enter both fighters." });
    return;
  }
  if (fighterA.length > MAX_FIGHTER_LENGTH || fighterB.length > MAX_FIGHTER_LENGTH) {
    res.status(400).json({ error: `Easy, novelist — keep each fighter under ${MAX_FIGHTER_LENGTH} characters.` });
    return;
  }

  let verdict;
  try {
    const response = await anthropic.messages.parse({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      output_config: { effort: 'low', format: zodOutputFormat(VerdictSchema) },
      system: JUDGE_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: `Fighter A: ${fighterA}\nFighter B: ${fighterB}` },
      ],
    });
    if (!response.parsed_output) {
      res.status(502).json({ error: "The judge stared into the void and couldn't call it. Try again." });
      return;
    }
    const { winner: winnerSide, reasoning } = response.parsed_output;
    verdict = { winner: winnerSide === 'A' ? fighterA : fighterB, winnerSide, reasoning };
  } catch (err) {
    console.error('Verdict call failed:', err);
    res.status(502).json({ error: "The judge stepped out mid-fight. Give it another shot." });
    return;
  }

  let imageA, imageB;
  try {
    [imageA, imageB] = await Promise.all([
      generateFighterImage(fighterA),
      generateFighterImage(fighterB),
    ]);
  } catch (err) {
    console.error('Image generation failed:', err);
    if (err instanceof ModerationBlockedError) {
      res.status(422).json({ error: `The arena censors benched "${err.message}" — too spicy for the ring. Try a different fighter.` });
      return;
    }
    res.status(502).json({ error: "The sketch artist's pencil snapped. Try again." });
    return;
  }

  res.status(200).json({ ...verdict, imageA, imageB });
};
