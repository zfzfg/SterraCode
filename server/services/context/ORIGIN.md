# Context compression in SterraCode

`core/` is an ESM JavaScript port of the required modules from the local
**context-compressor 0.8.3** (`lms-plugin-context-compressor`, rootMonsteR).
The corresponding original core tests are in `tests/context-core/`.
The source was imported on 2026-10-18. No external directory is needed at runtime.

Upstream: https://lmstudio.ai/rootmonster/context-compressor

The source README states: free for personal and internal professional use;
commercial embedding requires a separate agreement with the author. Preserve
these terms and attribution when redistributing this port. The supplied source
directory did not contain the LICENSE file referenced by its package manifest.

Adaptations outside `core/` implement SterraCode message/call identity, durable
workflow retention, recoverable tool-result capping, per-session persistence,
settings migration and browser events. The upstream Agentic Workspace data
format helpers remain dependencies of its summary renderer; they do not enable
an external plugin or expose additional tools. LM Studio UI/plugin controllers
and attachment extraction are not installed.

The original substantive user request is additionally retained as bounded
historical data (up to 1,024 tokens, scaled down to available headroom).
Onboarding answers are excluded. This protects the initial goal independently
of repeated model-generated consolidation; the current request stays verbatim.
Cache namespaces include this retention policy. Interrupted tool calls retain
their original request and an explicit unknown result for later inspection.

Integration uses @lmstudio/sdk 1.5.0. Every prediction is checked with the same
loaded model, Chat representation, tool definitions and template as generation.
The SDK tool loop is capped after one completed round using upstream passCap,
not maxPredictionRounds (which would generate an extra tool-less round).
