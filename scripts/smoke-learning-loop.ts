import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitu-learning-loop-'));
  process.chdir(tempDir);
  // Isolate the canonical Task store (Phase 15 S1 uses it) from the real
  // shared store — the smoke must not write into the user's Gitu Data.
  process.env.GITU_DATA_ROOT = tempDir;
  fs.writeFileSync('config.json', JSON.stringify({
    learning: {
      enabled: true,
      mode: 'medium',
      selfReview: { enabled: true, maxPerHour: 60 },
      external: { enabled: false },
      report: false,
      autoGoals: {
        enabled: true,
        includeSelfReview: true,
        includeExternal: false,
        maxPerEntry: 1,
        priority: 'low'
      },
      autoUpdate: { enabled: false },
      skillCreation: {
        enabled: true,
        includeSelfReview: true,
        includeExternal: false,
        maxPerEntry: 1,
        minActionChars: 20
      },
      approval: { enabled: false }
    },
    backgroundWorker: {
      enabled: true,
      alwaysOn: false,
      checkIntervalMs: 60000,
      idleThresholdMs: 60000,
      autoGenerate: { enabled: false }
    }
  }, null, 2));

  const { MemoryManager } = await import('../src/core/memory');
  const { LearningManager } = await import('../src/core/learning-manager');
  const { backgroundWorker } = await import('../src/core/background-worker');
  const { learnedSkillsManager } = await import('../src/core/learned-skills');
  const { taskEngine } = await import('../src/core/task');

  const fakeModel = {
    id: 'learning-smoke',
    name: 'Learning Smoke',
    generate: async (prompt: string) => {
      if (prompt.includes('Review the assistant response')) {
        return {
          content: JSON.stringify({
            issueSummary: 'Verification evidence was missing.',
            improvements: ['Run a verification check after every file-changing action before reporting completion.'],
            lesson: 'Never claim a code change is complete until a later check passes.'
          })
        };
      }
      if (prompt.includes('Create one skill from the lesson')) {
        return {
          content: JSON.stringify({
            name: 'verify-after-file-changes',
            description: 'Verify file-changing work before completion. Use after editing, generating, or replacing project files.',
            instructions: [
              'Identify the check that proves the requested behavior.',
              'Run the check after the final file change.',
              'Recover from failures before reporting completion.'
            ],
            keywords: ['edit', 'file', 'verify', 'build', 'test']
          })
        };
      }
      return { content: '{}' };
    }
  };

  const manager = new LearningManager(() => fakeModel as any, new MemoryManager(), undefined);
  // recordInteraction only queues a review for a "meaningful task": user text
  // >= 20 chars with an action verb AND assistant text >= 80 chars (the gate
  // was tightened in 6bb7672). The fixture must be a substantive exchange or
  // the review is never queued.
  manager.recordInteraction(
    'session-learning',
    'Please update the file and make sure it works.',
    'The file was updated. I changed the build configuration, ran the typecheck, and verified the workspace still builds cleanly before reporting completion.'
  );
  assert(fs.existsSync(path.join(tempDir, 'learning', 'pending_reviews.json')), 'review queue is persisted before processing');

  // The gate is observable: a near-miss exchange (the pre-fix fixture) logs
  // the exact reason at debug level instead of failing silently — a
  // regression guard so a future gate change cannot starve the pipeline
  // without any signal.
  const originalLog = console.log;
  const captured: string[] = [];
  console.log = ((...args: unknown[]) => { captured.push(args.map(String).join(' ')); }) as typeof console.log;
  process.env.GITU_DEBUG_LEARNING = '1';
  manager.recordInteraction('session-learning', 'Please update the file and make sure it works.', 'The file was updated.');
  process.env.GITU_DEBUG_LEARNING = '0';
  console.log = originalLog;
  assert(captured.some(line =>
    line.includes('[LearningManager][debug]') &&
    line.includes('skipped self-review') &&
    line.includes('assistant text') &&
    line.includes('< 80')
  ), 'gate skip logs the exact reason at debug level');

  await manager.tick();
  const goals = backgroundWorker.getPendingGoals('session-learning');
  const skillGoal = goals.find(goal => goal.tags.includes('skill-creation'));
  const improvementGoal = goals.find(goal => goal.tags.includes('learning') && !goal.tags.includes('skill-creation'));
  assert(skillGoal, 'self-review creates a learned-skill background goal');
  assert(improvementGoal, 'self-review creates a learning improvement background goal');
  assert.strictEqual(backgroundWorker.getStatus().enabled, true, 'background worker is enabled');

  const result = await manager.executeSkillCreationGoal(skillGoal!);
  assert(result.includes('Created learned skill'), 'skill creation goal completes deterministically');
  const records = learnedSkillsManager.list('session-learning');
  assert.strictEqual(records.length, 1, 'one learned skill is installed');
  assert.strictEqual(records[0].enabled, true, 'new learned skill is active');
  const prompt = manager.getLearnedSkillsPrompt('session-learning', 'Please edit this file and verify the build.');
  assert(prompt.includes('verify-after-file-changes'), 'active learned skill is injected into future prompts');
  assert(prompt.includes('Run the check after the final file change.'), 'learned workflow instructions are preserved');

  const skillPath = path.join(tempDir, 'learning', 'skills', 'session-learning', 'verify-after-file-changes', 'SKILL.md');
  const skillText = fs.readFileSync(skillPath, 'utf-8');
  assert(skillText.startsWith('---\nname: verify-after-file-changes\ndescription:'), 'generated skill has valid minimal frontmatter');
  assert(!skillText.includes('apiKey'), 'generated skill contains no credentials');

  const v2 = learnedSkillsManager.upsert({
    name: 'verify-after-file-changes',
    description: 'Verify file-changing work before completion. Use after editing project files and before final reporting.',
    instructions: ['Run the strongest available verification check.', 'Record the evidence.'],
    keywords: ['verify', 'files'],
    sessionId: 'session-learning',
    sourceEntryId: 'manual-version-test'
  });
  assert.strictEqual(v2.version, 2, 'skill updates are versioned');
  const rolledBack = learnedSkillsManager.rollback('verify-after-file-changes', 'session-learning');
  assert.strictEqual(rolledBack?.version, 1, 'skill rollback restores the previous version');

  // Phase 15 S1: skill-creation goals also run as canonical kind-'background'
  // Tasks — TaskEngine owns the lifecycle + evidence, the goal record links
  // via canonicalTaskId (background_goals.json stays the goal-status
  // authority), and the result lands as task evidence.
  const canonicalTask = await taskEngine.create({
    goal: `Create learned skill: ${skillGoal!.title}`,
    kind: 'background',
    sessionId: 'session-learning',
    metadata: { source: 'skill-creation', backgroundGoalId: skillGoal!.id }
  });
  skillGoal!.metadata = { ...(skillGoal!.metadata || {}), canonicalTaskId: canonicalTask.id };
  await taskEngine.analyze(canonicalTask.id);
  await taskEngine.plan(canonicalTask.id);
  await taskEngine.start(canonicalTask.id);
  const canonicalResult = await manager.executeSkillCreationGoal(skillGoal!);
  await taskEngine.complete(canonicalTask.id, {
    status: 'SUCCESS',
    summary: canonicalResult,
    result: { summary: canonicalResult, status: 'completed', finalOutput: canonicalResult }
  });
  const linkedTask = taskEngine.get(canonicalTask.id);
  assert.strictEqual(linkedTask?.status, 'COMPLETED', 'skill-creation task completes through the canonical lifecycle');
  assert.strictEqual(skillGoal!.metadata.canonicalTaskId, canonicalTask.id, 'goal linked to its canonical task');
  const linkedResult: any = linkedTask?.outcome?.result;
  const evidence = String(linkedResult?.finalOutput || linkedResult?.summary || '');
  assert(evidence.includes('Created learned skill'), 'skill-creation evidence recorded on the canonical task');

  // Phase 15 Move 2: external research runs inside canonical Tasks when a
  // TaskEngine is wired. Rewrite config to enable external learning and stub
  // the model + web skills so the whole pipeline is deterministic (no
  // network); the earlier manager already ran its tick under the old config.
  fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify({
    learning: {
      enabled: true,
      mode: 'medium',
      selfReview: { enabled: true },
      external: { enabled: true, intervalMs: 0, maxTopics: 1, maxSources: 1, maxCharsPerSource: 500, recentMessages: 12 },
      report: false,
      autoGoals: { enabled: false },
      autoUpdate: { enabled: false },
      skillCreation: { enabled: false },
      approval: { enabled: false }
    },
    backgroundWorker: { enabled: false }
  }));
  const extMemory = new MemoryManager();
  extMemory.add('ext-session', { role: 'user', content: 'Please research the best way to verify memory retrieval regressions.', timestamp: Date.now() - 5000 });
  const extModel = {
    id: 'ext-stub',
    name: 'Ext Stub',
    generate: async (prompt: string) => {
      if (prompt.includes('Extract up to')) {
        return { content: JSON.stringify({ topics: [{ query: 'memory retrieval regression verification', reason: 'learn', priority: 'normal' }] }) };
      }
      if (prompt.includes('Create a short learning note')) {
        return { content: JSON.stringify({ title: 'Verify retrieval regressions', summary: ['Always add a regression assertion.'], improvements: [], recommendations: [] }) };
      }
      return { content: '{}' };
    }
  } as any;
  const searchStub = { execute: async () => ({ results: [{ title: 'Retrieval regression testing', url: 'https://example.com/retrieval' }] }) } as any;
  const fetchStub = { execute: async () => ({ text: 'Run a regression assertion after scoring changes.' }) } as any;
  const extManager = new LearningManager(() => extModel, extMemory, undefined, taskEngine, searchStub, fetchStub);
  extManager.recordActivity('ext-session');
  await extManager.tick();
  const researchTask = taskEngine.list().find(t => t.metadata?.source === 'external-learning');
  assert(researchTask, 'external research ran inside a canonical Task');
  assert.strictEqual(researchTask!.kind, 'background', 'research Task is kind background');
  assert.strictEqual(researchTask!.metadata?.topicQuery, 'memory retrieval regression verification', 'research Task carries its topic');
  assert.strictEqual(researchTask!.status, 'COMPLETED', 'research Task completed through the canonical lifecycle');
  const researchResult: any = researchTask!.outcome?.result;
  assert(String(researchResult?.summary || '').includes('Verify retrieval regressions'),
    'research entry title recorded as the Task summary evidence');
  assert(String(researchResult?.finalOutput || '').includes('Always add a regression assertion'),
    'research entry content recorded as the Task evidence');

  const smokeResult = {
    success: true,
    tempDir,
    learningGoals: goals.length,
    learnedSkills: records.length,
    promptInjected: true,
    versioning: true,
    rollback: true,
    pendingReviewPersistence: true,
    canonicalSkillCreation: true,
    canonicalExternalResearch: true
  };
  fs.writeFileSync(path.join(tempDir, 'smoke-result.json'), JSON.stringify(smokeResult, null, 2));
  console.log(JSON.stringify(smokeResult, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
