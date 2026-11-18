const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
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

// ponytail: in-memory rate limit, per-instance only — resets on cold start and
// isn't shared across concurrent serverless instances. Fine for local/single-
// instance use; move to Vercel KV/Upstash if this needs to hold under real traffic.
const RATE_LIMIT = 5;
const WINDOW_MS = 60_000;
const MAX_FIGHTER_LENGTH = 50;
const hits = new Map(); // ip -> timestamps[]

function isRateLimited(ip) {
  const now = Date.now();
  // Forget IPs whose most recent hit is outside the window, so the map doesn't grow forever.
  for (const [key, ts] of hits) {
    if (now - ts[ts.length - 1] >= WINDOW_MS) hits.delete(key);
  }
  const timestamps = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  timestamps.push(now);
  hits.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT;
}

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

  if (isRateLimited(ip)) {
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
