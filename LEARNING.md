# LEARNING.md

Updated: 2026-08-13T17:25:48.625Z

## 13/08/2026, 20:25:48 - Task self-review: background COMPLETED
Type: self_review

- Lesson: Success criteria for learned skills should include comprehensive documentation and clear callable interfaces

Improvements:
- Add usage examples and parameter documentation to the skill definition for better maintainability
- Consider versioning strategy for learned skills to track updates and iterations

## 13/08/2026, 20:09:49 - Goal retrospective: create a online store with backend dashbord and admin panel
Type: self_review

- Issue: complete
- Lesson: Successful goal completion requires detailed progress documentation with factual evidence and comprehensive coverage of all deliverables. Vague success markers like 'SUCCESS' combined with minimal detail make assessments difficult. Future retrospective summaries should include specific metrics, file structures, and feature lists to demonstrate thorough completion.

Improvements:
- Use structured document format with consistent headers (## ##) instead of inconsistent markdown formatting
- Include concrete evidence and specific details in completion summaries (e.g., actual file counts, directory structure), not just status indicators
- Expand completion summaries to cover all major deliverables including frontend components, backend services, and admin panel features

## 13/08/2026, 19:53:51 - Task self-review: mission COMPLETED
Type: self_review

- Issue: Project structure created but implementation blocked by model provider rate limiting (429 errors), preventing dependency installation, codebase development, and database setup
- Lesson: When task completion depends on external services with rate limits, prepare implementation artifacts (dependency lists, stub code, error handling patterns) in advance to minimize idle time during provider downtime

Improvements:
- Prepare dependency installation backlog in parallel - research and document exact package versions to install when rate limits reset
- Create stub implementation files with TODO markers to enable faster development once unblocked
- Implement exponential backoff strategy for API calls to prevent cascading failures when providers are rate limited

## 10/08/2026, 14:20:35 - Self-review feedback
Type: self_review

- Issue: The assistant gave a detailed plan but did not actually implement the requested change, and it made unverified concrete claims (line numbers, file counts, existing patterns). It also repeated the live token in the response and asked for permission instead of safely applying the env-var approach.
- Lesson: For configuration additions, prefer acting safely and completely over describing a plan; verify all implementation details before stating them, and never expose live credentials in chat or config files.

Improvements:
- When the user asks to add something, implement the change directly where possible, rather than stopping at a proposal and asking for approval—unless there is a real ambiguity or destructive action.
- Do not cite specific line numbers, file counts, or code paths unless they have been verified in the actual project; hedge or avoid unverifiable details.
- Handle secrets proactively: immediately recommend/use an environment variable, and avoid echoing the raw token in the visible response.

## 10/08/2026, 11:16:20 - Self-review feedback
Type: self_review

- Issue: The assistant completed research but failed to execute the website update due to a PowerShell syntax error, and left a brittle hardcoded assertion.
- Lesson: Validate commands in the target environment and proactively complete tasks; avoid brittle hardcoded checks.

Improvements:
- When providing shell commands, ensure syntax matches the user's shell (e.g., use ';' instead of '&&' in PowerShell); better yet, execute and verify the command yourself before reporting completion.
- If a command fails, immediately retry with corrected syntax and validate the result rather than deferring the task to the user.
- Avoid hardcoded counts in verification scripts; compute expected values dynamically or update them automatically after data changes.

## 10/08/2026, 10:34:42 - Self-review feedback
Type: self_review

- Issue: The final status report is thorough but assumes the user understands technical verification details, and it leaves next steps open-ended without a recommended path.
- Lesson: When delivering a completed build, balance technical proof with user-friendly context and end with a clear recommended next action.

Improvements:
- Explain the verification evidence in plain language, e.g., what '23/23 PASS' and 'PID 7568' mean for the user rather than just listing technical checks.
- Add a short 'How to run/stop the site' section with the exact commands, since the user may need to restart it after the server stops.
- Instead of ending with two open-ended questions, recommend one next step (e.g., set up a daily cron job or deploy publicly) and ask for confirmation.

## 10/08/2026, 10:18:27 - Self-review feedback
Type: self_review

- Issue: Assistant confirmed the script was written and saved, but did not provide the actual script content in the response, made unverified factual claims about news events, and used overly confident verification language without showing evidence.
- Lesson: When a user requests a deliverable like a full script, deliver the content directly in the chat and clearly separate verified facts from generated or illustrative material.

Improvements:
- Include the full script in the response so the user can read it directly, rather than only providing a file path and summary.
- Avoid stating specific news events as fact unless verified; if content is generated or hypothetical, clearly label it as such.
- Tone down claims of 'verified' and 'objective' without presenting the actual content or verification details.

## 14/07/2026, 18:33:20 - Self-review feedback
Type: self_review

- Issue: The response contains unclear language, typos, assumptions about the user's name, and fails to clearly convey the inability to fulfill the request.
- Lesson: Always communicate clearly and professionally, especially when conveying limitations or failures, to maintain user trust and understanding.

Improvements:
- Avoid assuming the user's name unless explicitly provided in the context.
- Proofread responses to eliminate garbled text and grammatical errors for clarity.
- When unable to complete a task due to limitations, clearly explain the situation and offer alternative approaches or next steps.

## 12/07/2026, 11:08:43 - Self-review feedback
Type: self_review

- Issue: The assistant jumped directly into creating the landing page without actually conducting any research first, and then proceeded to create it without showing any work or evidence of research.
- Lesson: Always follow the research-first approach in web development: analyze existing examples, identify patterns, document findings, and then implement based on evidence rather than assumptions.

Improvements:
- Actually perform research on coffee shop landing pages before building - look at competitors, color schemes, layout patterns, and user experience best practices
- Show the research findings in a structured format before proceeding to implementation
- Create a wireframe or mockup first to validate the design approach before building the full page

## 12/07/2026, 10:59:44 - Self-review feedback
Type: self_review

- Issue: The assistant attempted to access a local file path instead of researching AI news and writing a YouTube script as requested. This is a serious security and functionality violation - the assistant should not be reading local files without explicit user permission, and it failed to deliver the core request.
- Lesson: Prioritize user requests and maintain security boundaries - assistants should ask for clarification when uncertain about permissions or scope, and always deliver the main requested content before handling secondary tasks.

Improvements:
- Never access local file systems without explicit, clear user permission - this is a security risk and privacy violation
- Always clarify scope and capabilities when requests involve research - explain what sources you can access and what limitations exist
- Deliver on the user's core request first before checking auxiliary details - the script writing was the primary task, not file management

## 12/07/2026, 07:57:33 - Self-review feedback
Type: self_review

- Issue: The assistant fabricated specific technical details (Grok 4.5 with 54% hallucination rate, GPT-5.6, Claude Cowork) and a fictional 'background_goals tool error' that were not in the sources. The response mixed actual source content with invented specifics and added an unnecessary technical error message at the end.
- Lesson: When synthesizing information from sources, maintain fidelity to what was actually reported rather than filling gaps with plausible but unverified details. Quality review requires identifying when responses invent specifics not present in the source material.

Improvements:
- Stick strictly to reported facts from sources without adding specific metrics or product details not mentioned in the original articles
- Remove fictional technical error messages and focus on actual content from the provided sources
- Distinguish between what sources explicitly report versus general trends or speculation

## 12/07/2026, 07:36:53 - Self-review feedback
Type: self_review

- Lesson: Match the assistant's response depth to the user's input complexity. For brief greetings, start with a simple acknowledgment and one gentle question about needs rather than immediate detailed context gathering.

Improvements:
- Acknowledge the greeting more briefly before diving into detailed observations. The assistant noticed too much context (MEMORY.md, directory structure) without first confirming the user's intent.
- Ask one clear, open-ended question to understand user needs rather than presenting three specific options. This gives the user more freedom to respond naturally.
- Remove the detailed workspace analysis since the user only said 'hello' and hasn't indicated they want help with their project yet.

## 11/07/2026, 11:02:08 - Self-review feedback
Type: self_review

- Issue: The assistant provided the correct result but failed to explicitly demonstrate the use of the web_search tool as required by the user's instruction. The response skipped the process of searching and directly stated the answer, which may not align with UI test expectations that require step-by-step tool usage tracking.
- Lesson: In UI tests, explicitly demonstrate tool usage and process steps even if the final answer is correct, as adherence to workflow is critical for validation.

Improvements:
- Use the web_search tool explicitly to search for 'OpenAI official website' and document the search process before reporting the result.
- Clarify the search query and tool usage in the response to ensure transparency in the UI test workflow.
- Verify the first result matches the official OpenAI website (openai.com) to maintain accuracy.

## 03/07/2026, 09:59:06 - Self-review feedback
Type: self_review

- Issue: Assistant failed to acknowledge user's 'i solve it' message and defaulted to generic greeting, missing contextual engagement.
- Lesson: Respond to user statements with contextual awareness—validate their message before introducing new topics to maintain conversational continuity.

Improvements:
- Acknowledge user's statement about solving something before pivoting to new topics
- Ask clarifying questions about the solved problem to confirm understanding
- Match response tone to user's brief, declarative input style
- Follow up on user's progress before introducing new requests

## 03/07/2026, 09:52:01 - Self-review feedback
Type: self_review

- Issue: The assistant responded with an overly verbose and potentially confusing introduction that introduced unnecessary information about configuration issues with OpenRouter, which was not relevant to the simple greeting.
- Lesson: In response to simple greetings, provide a brief, warm acknowledgment without introducing unrelated technical concerns or assumptions about system configuration issues.

Improvements:
- Avoid introducing unnecessary technical details or potential problems in initial greetings - keep responses simple and focused on the user's actual input
- Do not assume or mention configuration issues from 'previous messages' unless explicitly relevant to the current conversation context
- Keep initial greetings concise and natural without over-explaining technical background that may confuse or concern the user
