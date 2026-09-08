'use strict';

const { z } = require('zod');
const toolResult = require('../../utils/toolResult');
const toolAnnotations = require('../../utils/toolAnnotations');

// Ported from nginx/sites/goai/tools/model-picker.html's <script id="picker-data">
// JSON block plus the render() function beneath it. The source is a static
// lookup table (17 task ids -> a default model + reasoning) with a small
// amount of render-time logic for the two optional "priority" overrides.
// English strings ship as-is (the source translates this JSON block per
// locale in the browser; this server has no locale layer).

const MODELS = {
  gpt5: 'GPT-5',
  gemini: 'Gemini',
  grok: 'Grok 4',
  deepseek: 'DeepSeek',
  claude: 'Claude',
  kimi: 'Kimi',
  imageFamilies: 'Imagen 4 / OpenAI / Grok',
  grokVideo: 'Grok',
};

const TASKS = {
  write: {
    label: 'Long or structured writing',
    model: 'gpt5',
    tag: 'holds the shape',
    why: "Ask for a specific structure and GPT-5 delivers it — sections present, constraints respected, tone steady to the end. Grok's drafts are livelier but wander over long form.",
    backup: "Gemini, if the writing has to be grounded in source documents you're supplying.",
    cheaper: true,
    fresher: true,
  },
  copy: {
    label: 'Punchy copy, hooks, social',
    model: 'grok',
    tag: 'native energy',
    why: "Grok's default register is looser and funnier. You'll edit down rather than trying to inject personality that isn't there.",
    backup: "GPT-5 to tighten Grok's draft — that hand-off is the whole workflow.",
    cheaper: false,
    fresher: true,
  },
  edit: {
    label: 'Editing my own draft',
    model: 'gpt5',
    tag: 'restrained',
    why: 'It makes the edit you asked for and leaves your voice alone. Models that rewrite everything are worse than no editor.',
    backup: 'Claude for a gentler pass still — of the six it is the most willing to leave a sentence alone.',
    cheaper: true,
    fresher: false,
  },
  longdoc: {
    label: 'Summarising long documents',
    model: 'gemini',
    tag: 'swallows piles',
    why: "Gemini is strongest when there's a lot of source material and the job is making sense of it rather than inventing.",
    backup: 'Kimi when the pile is very large and the budget matters — it takes long inputs without complaint.',
    cheaper: true,
    fresher: true,
  },
  code: {
    label: 'Writing code',
    model: 'gpt5',
    tag: 'runs first try',
    why: 'In daily use its code compiles and runs on the first attempt more often, and it respects "don\'t change anything else" — the instruction most models ignore.',
    backup: 'DeepSeek, which is close behind and much cheaper at volume.',
    cheaper: true,
    fresher: false,
  },
  review: {
    label: 'Reviewing code someone else wrote',
    model: 'grok',
    tag: 'argumentative',
    why: "Paste a working solution and ask what's fragile. Grok finds real problems where a model asked to agree will agree. The disagreement is the value.",
    backup: "Claude for a calmer second read — it is the most likely of the six to say it isn't sure.",
    cheaper: false,
    fresher: false,
  },
  math: {
    label: 'Maths and calculations',
    model: 'gpt5',
    tag: 'shows steps',
    why: 'Ask for the working, always. Every model degrades on arithmetic buried in prose; GPT-5 is the most reliable at slowing down and being explicit.',
    backup: 'DeepSeek, and compare — if they disagree, neither is trustworthy.',
    cheaper: true,
    fresher: false,
  },
  news: {
    label: "Current events, what's trending",
    model: 'grok',
    tag: 'freshest',
    why: "Grok's instinct for what people are talking about right now is distinct, and it saves you a search tab. Treat any summary as a starting point and ask for links.",
    backup: 'Gemini with browsing, for a second read on anything contentious.',
    cheaper: false,
    fresher: false,
  },
  research: {
    label: 'Research and synthesis',
    model: 'gemini',
    tag: 'the researcher',
    why: 'Best at digesting many sources into something coherent. Verify the citations yourself — every model invents them under pressure.',
    backup: "GPT-5 to turn Gemini's synthesis into the finished deliverable.",
    cheaper: true,
    fresher: true,
  },
  translate: {
    label: 'Translation',
    model: 'gemini',
    tag: 'strong multilingual',
    why: 'Reliable for drafts across a wide range of languages. Anything published to customers still needs a native review.',
    backup: 'GPT-5, particularly for tone-sensitive or idiomatic text.',
    cheaper: true,
    fresher: false,
  },
  brainstorm: {
    label: 'Brainstorming ideas',
    model: 'grok',
    tag: 'less filtered',
    why: 'Goes to stranger places, which is what you want at the idea stage. Ask for twenty and keep three.',
    backup: "DeepSeek for volume, since you're throwing most of them away.",
    cheaper: true,
    fresher: true,
  },
  voice: {
    label: 'Talking out loud',
    model: 'grok',
    tag: 'real two-way voice',
    why: "A genuine streaming voice agent you can interrupt — not speech-to-text glued to text-to-speech. The difference is obvious within one exchange.",
    backup: 'None really — this is a clear win for Grok today.',
    cheaper: false,
    fresher: false,
  },
  prose: {
    label: "Prose you'll publish as-is",
    model: 'claude',
    tag: 'the careful editor',
    why: "The best prose of the six, and the most willing to say it isn't sure. It reads least like a model wrote it, which is the whole point when nothing downstream will be rewritten.",
    backup: 'GPT-5 if the piece needs a firmer structure than Claude imposes on its own.',
    cheaper: false,
    fresher: false,
  },
  longinput: {
    label: 'Very long inputs on a budget',
    model: 'kimi',
    tag: 'long-context bargain',
    why: 'Takes a large pile of input without complaint, and without the long-context price. The trade is a little less polish than Gemini on the same material.',
    backup: 'Gemini when making sense of the pile matters more than the size of it.',
    cheaper: false,
    fresher: false,
  },
  image: {
    label: 'Generating images',
    model: 'imageFamilies',
    tag: 'pick per style',
    why: 'Three families with different temperaments: Imagen for photoreal, OpenAI for prompt adherence and text in the image, Grok for speed and looser styles.',
    backup: 'Try the same prompt in two — output varies more between families than between attempts.',
    cheaper: false,
    fresher: false,
  },
  video: {
    label: 'Generating video',
    model: 'grokVideo',
    tag: 'up to 15 seconds',
    why: 'The practical option on a phone today. One subject, one action, a camera direction and a style is the prompt shape that works.',
    backup: 'Runway or Kling if you need cinematic control and a desktop workflow.',
    cheaper: false,
    fresher: false,
  },
  bulk: {
    label: 'Running the same prompt hundreds of times',
    model: 'deepseek',
    tag: 'value pick',
    why: 'Efficiency is its whole proposition. For repetitive, high-volume, unglamorous work the quality gap rarely justifies the price gap.',
    backup: 'Kimi if the repetitive work also involves long inputs.',
    cheaper: false,
    fresher: false,
  },
};

const TASK_IDS = Object.keys(TASKS);

const UI = {
  adjustedTag: 'adjusted for your priority',
  costWhy:
    'You said cost matters most. For this task DeepSeek gets you most of the way at a fraction of the price — the honest trade is a bit more editing on your side.',
  costNote: 'Our quality pick here would be {model}. If the output is going in front of a customer, pay the difference.',
  freshWhy:
    "You said currency matters most. Grok is the best-grounded on recent events, so it's the right pick when the answer goes stale quickly.",
  freshNote: 'For this task our default would be {model} — Grok trades some structure for freshness.',
};

// The source's static disclaimer sentence, hardcoded in the page body (not
// in the translated JSON block, so it lives outside UI/TASKS above too).
const DISCLAIMER =
  'Qualitative judgement from daily side-by-side use, current as of August 2026 — not a benchmark score. Full reasoning at /blog/which-ai-model-for-which-task.';

// Ported from render(): the default (priority "quality") pick is just
// TASKS[task].model. "cost" swaps to DeepSeek, "fresh" swaps to Grok --
// but only when the task's own `cheaper` / `fresher` flag says that
// substitute is actually worth offering for this task; otherwise the
// quality default stands untouched.
//
// NOTE (verified against source, not the hint): the swap condition
// (`t.cheaper` / `t.fresher`) is independent of whether the task's default
// model is *already* the target model. Two tasks -- "copy" and
// "brainstorm" -- already default to Grok but still carry `fresher: true`.
// Requesting priority "fresh" on either of them re-triggers the branch:
// `why`/`note` are overwritten with the fresh-pick rationale even though
// `modelKey` doesn't actually change (it was already "grok"). The source's
// own tag logic (`modelKey === t.model ? t.tag : UI.adjusted`) means the
// *tag* correctly stays the task's own tag in that case -- so `adjusted`
// below (mirroring that same equality check) can be `false` while `why`
// and `note` still read as if a swap happened. That is a real quirk in the
// source, not a bug in this port; it is reproduced as-is rather than fixed.
function recommendAiModel({ task, priority }) {
  const t = TASKS[task];
  const prio = priority || 'quality';

  let modelKey = t.model;
  let why = t.why;
  let note = null;

  if (prio === 'cost' && t.cheaper) {
    modelKey = 'deepseek';
    why = UI.costWhy;
    note = UI.costNote.replace('{model}', MODELS[t.model]);
  } else if (prio === 'fresh' && t.fresher) {
    modelKey = 'grok';
    why = UI.freshWhy;
    note = UI.freshNote.replace('{model}', MODELS[t.model]);
  }

  const adjusted = modelKey !== t.model;

  return {
    modelKey,
    model: MODELS[modelKey],
    tag: adjusted ? UI.adjustedTag : t.tag,
    taskLabel: t.label,
    why,
    backup: t.backup,
    adjusted,
    note,
    disclaimer: DISCLAIMER,
  };
}

// The shape of the JSON in structuredContent. Declared so an agent can
// read the result without parsing prose -- and, because the SDK validates
// every success against it, so a handler that quietly stops returning a
// field fails here instead of downstream. Nullable fields below are the
// ones the computation genuinely leaves empty, not defensive padding.
const modelPickerOutputSchema = {
  modelKey: z.string().describe('Stable identifier for the recommended model, safe to switch on.'),
  model: z.string().describe('The recommended model\'s display name.'),
  tag: z.string().describe('Short label for why this model wins the task, e.g. its standout strength.'),
  taskLabel: z.string().describe('Human-readable name of the task that was matched.'),
  why: z.string().describe('The reasoning behind the recommendation.'),
  backup: z.string().describe('A second choice worth trying if the first does not suit.'),
  adjusted: z
    .boolean()
    .describe('True when the stated priority (cost or freshness) moved the answer away from the quality-first pick.'),
  note: z.string().nullable().describe('What that adjustment was, when adjusted is true; otherwise null.'),
  disclaimer: z.string().describe('Standing note that this is a fixed editorial table, not a live benchmark.'),
};

function register(server) {
  server.registerTool(
    'recommend_ai_model',
    {
      title: 'Recommend which AI model to use for a task',
      description:
        "Static editorial recommendation -- NOT a live benchmark or leaderboard -- for which of six AI models (GPT-5, Gemini, Grok 4, Claude, DeepSeek, Kimi) to use for a given kind of task, ported from GO AI's own daily side-by-side-use judgement, current as of August 2026. Pick a task and get the recommended model plus the reasoning and a second-opinion backup. The optional `priority` can bias the pick toward cost (routes to DeepSeek) or freshness (routes to Grok) instead of the default quality pick -- but only for tasks where that tradeoff is actually offered; otherwise the quality default is returned unchanged. This reflects one team's opinion, not measured accuracy or pricing data.",
      annotations: toolAnnotations.PURE,
      outputSchema: modelPickerOutputSchema,
      inputSchema: {
        task: z
          .enum(TASK_IDS)
          .describe(
            `The kind of task, one of: ${TASK_IDS.map((id) => `${id} (${TASKS[id].label})`).join(', ')}.`
          ),
        priority: z
          .enum(['quality', 'cost', 'fresh'])
          .optional()
          .default('quality')
          .describe(
            '"quality" (default) returns the task\'s default best-result pick. "cost" swaps to DeepSeek when this task supports a cheaper substitute. "fresh" swaps to Grok when this task supports a fresher/more current substitute. Has no effect for tasks that don\'t offer that tradeoff.'
          ),
      },
    },
    async (args) => {
      const result = recommendAiModel(args);
      return toolResult.ok(result);
    }
  );
}

module.exports = { register, toolCount: 1, recommendAiModel, TASKS, MODELS };
