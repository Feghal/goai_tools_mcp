'use strict';

const { recommendAiModel, TASKS, MODELS } = require('../controllers/tools/model-picker');

describe('recommendAiModel (ported from model-picker.html render())', () => {
  test('typical case: default "quality" priority returns the task\'s own pick untouched', () => {
    // task "write" -> model: "gpt5", tag: "holds the shape", cheaper/fresher
    // are both true but irrelevant here since priority defaults to "quality",
    // so the render() cost/fresh branches never run and modelKey === t.model.
    const result = recommendAiModel({ task: 'write' });

    expect(result.modelKey).toBe('gpt5');
    expect(result.model).toBe('GPT-5');
    expect(result.tag).toBe('holds the shape');
    expect(result.taskLabel).toBe('Long or structured writing');
    expect(result.why).toBe(TASKS.write.why);
    expect(result.backup).toBe(TASKS.write.backup);
    expect(result.adjusted).toBe(false);
    expect(result.note).toBeNull();
    expect(result.disclaimer).toMatch(/August 2026/);
  });

  test('edge case: priority "cost" has no effect when the task\'s own cheaper flag is false', () => {
    // task "review" -> model: "grok", cheaper: false. Source's
    // `if (prio === "cost" && t.cheaper)` never enters, so nothing changes
    // even though a non-default priority was explicitly requested.
    const result = recommendAiModel({ task: 'review', priority: 'cost' });

    expect(result.modelKey).toBe('grok');
    expect(result.model).toBe('Grok 4');
    expect(result.tag).toBe('argumentative');
    expect(result.why).toBe(TASKS.review.why);
    expect(result.adjusted).toBe(false);
    expect(result.note).toBeNull();
  });

  test('priority "cost" swaps to DeepSeek and fills in {model} with the displaced pick\'s display name', () => {
    // task "write" -> model: "gpt5", cheaper: true, so priority "cost" swaps
    // modelKey to "deepseek". note = costNote.replace("{model}", "GPT-5").
    const result = recommendAiModel({ task: 'write', priority: 'cost' });

    expect(result.modelKey).toBe('deepseek');
    expect(result.model).toBe(MODELS.deepseek);
    expect(result.tag).toBe('adjusted for your priority');
    expect(result.adjusted).toBe(true);
    expect(result.why).toMatch(/You said cost matters most/);
    expect(result.note).toBe(
      'Our quality pick here would be GPT-5. If the output is going in front of a customer, pay the difference.'
    );
  });

  test('quirk (verified against source, not the hint): task "copy" already defaults to Grok but carries fresher:true, so priority "fresh" rewrites why/note to the fresh-pick rationale even though modelKey does not change and adjusted stays false', () => {
    // task "copy" -> model: "grok", tag: "native energy", fresher: true.
    // render()'s `else if (prio === "fresh" && t.fresher)` branch fires
    // (fresher is true) and sets modelKey = "grok" -- the same value it
    // already had -- so `modelKey === t.model` stays true, the tag is NOT
    // replaced with UI.adjusted, but why/note ARE overwritten regardless.
    const result = recommendAiModel({ task: 'copy', priority: 'fresh' });

    expect(result.modelKey).toBe('grok');
    expect(result.model).toBe('Grok 4');
    expect(result.adjusted).toBe(false);
    expect(result.tag).toBe('native energy'); // unchanged -- not "adjusted for your priority"
    expect(result.why).toMatch(/You said currency matters most/);
    expect(result.note).toBe('For this task our default would be Grok 4 — Grok trades some structure for freshness.');
  });
});
