import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitu-learning-loop-'));
  process.chdir(tempDir);
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

  const smokeResult = {
    success: true,
    tempDir,
    learningGoals: goals.length,
    learnedSkills: records.length,
    promptInjected: true,
    versioning: true,
    rollback: true,
    pendingReviewPersistence: true
  };
  fs.writeFileSync(path.join(tempDir, 'smoke-result.json'), JSON.stringify(smokeResult, null, 2));
  console.log(JSON.stringify(smokeResult, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
