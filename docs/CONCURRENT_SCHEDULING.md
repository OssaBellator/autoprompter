# Concurrent scheduling

AutoPrompter creates one inactive managed tab for each selected conversation.

For the initial batch, every worker reports that its ChatGPT page is ready before the background scheduler releases the jobs together. Initial jobs use a zero-second page delay so independent background-tab timers cannot stagger submission. If one worker remains unready, ready workers are released after a five-second grace period; the late worker receives its own zero-delay initial job when it becomes ready.

After the initial batch, each conversation advances independently. The configured delay applies between that conversation's completed response and its next follow-up.

Submission remains guarded by composer ownership checks. AutoPrompter first clicks an enabled send button, then falls back to the composer form's `requestSubmit()` method or an Enter-key sequence when an inactive page does not expose an enabled button promptly.

Concurrent starts can consume account allowances faster. Keep batches modest and retain conservative follow-up delays.
