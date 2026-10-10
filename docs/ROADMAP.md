# Roadmap

What is open, and one decision that was made on purpose. Finished work is in the [CHANGELOG](../CHANGELOG.md).

## Open

- **Signed installers.** The Windows, macOS and Linux builds are unsigned, so
  SmartScreen and Gatekeeper warn on first launch. Signing needs certificates.
- **Live browser-layer runs.** The browser layer in `local-agent/src/web/`
  (DeepSeek, Qwen and GLM adapters, research with cited sources) passes against
  fixture pages but has not run against the live sites yet. The build path
  moves onto it only after `npm run webtest` passes live on that provider. The
  per-capability results are in [provider-matrix.md](testing/provider-matrix.md).
- **Qwen Studio and GLM, past experimental.** Both can be selected, but
  neither has been re-checked against its live site. GLM's selectors have never
  been confirmed. What was unresolved is kept as `_ungatedNote` in each
  provider's config.
- **A reviewer agent on a second provider.** It would check each step's output,
  at the cost of making every step slower. Not started; it needs its own
  decision.

## Parallel steps: BUILT, THEN DELIBERATELY REVERSED

Independent steps once ran at the same time, each in a chat thread of its own.
A fresh thread has never seen the discussion or the plan, so every step prompt
had to carry the plan, the file tree and the reply-format rules: the first step
of a fifteen-step build reached 9853 characters, every step failed, and each
failure blocked the ones behind it.

Steps now run one at a time in the conversation that already holds the chat and
the plan. The prompt is far smaller and the reply far likelier to parse. The
dependency graph, the scheduler and the serialised apply are still in place;
only the thread-per-step part was removed. If a provider ever makes long prompts
cheap, restoring per-step threads brings it back.
