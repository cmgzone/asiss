import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';

/**
 * Phase 14 Moves 1-4 — unified memory model + catalog + consolidation +
 * MemorySkill retrieve. Exercises the canonical MemoryRecord shape and
 * UnifiedMemoryCatalog over the three real source stores (conversation /
 * learning / task), plus retrieval ranking, budget cap, dedupe, access
 * tracking, event-driven episodic capture (Move 2), the consolidation/
 * lifecycle layer (Move 3: dedupe by canonical id, near-duplicate merge,
 * candidate->active promotion from access and success feedback, expiry by
 * TTL, durable overlays, retrieval excluding archived/expired), and the
 * MemorySkill surface (Move 4: canonical retrieve with scoreBreakdown and
 * source/types/minScore/taskId filters, search/semantic_search delegates
 * over the unified path, legacy fallback without a unified layer), and the
 * learning loop (Move 5: terminal Task -> TaskLessonBridge -> self-review ->
 * lesson -> approval -> applied rule, with the restart-recall acceptance
 * gate: fresh instances over the same data root retrieve the episode AND the
 * learned lesson without the old process alive).
 */
async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitu-memory-unified-'));
  process.chdir(tempDir);
  // Isolate the canonical Task store (and other data-root stores) from the
  // real shared store — the smoke must not write into the user's Gitu Data.
  process.env.GITU_DATA_ROOT = tempDir;

  const { MemoryManager } = await import('../src/core/memory');
  const { LearningManager } = await import('../src/core/learning-manager');
  const { taskEngine, taskEventBus } = await import('../src/core/task');
  const { TaskMemory } = await import('../src/core/task/task-memory');
  const { createUnifiedMemory, relevanceOf } = await import('../src/core/memory-unified/memory-catalog');
  const { memoryRecordId } = await import('../src/core/memory-unified/memory-record');
  const { EpisodicCapture } = await import('../src/core/memory-unified/episodic-capture');

  // --- seed the source stores -------------------------------------------
  const memory = new MemoryManager();
  memory.add('s1', { role: 'user', content: 'I ran the typecheck and it passed.', timestamp: Date.now() - 60000 });
  memory.add('s1', { role: 'assistant', content: 'Good. The repository now builds cleanly.', timestamp: Date.now() - 30000 });
  memory.add('s2', { role: 'user', content: 'How do I deploy the mailcow stack?', timestamp: Date.now() - 120000 });

  // Proven procedural rules, seeded like LearningManager would persist them.
  // rule-2 is a near-duplicate of rule-1 with lower confidence — the Move 3
  // consolidation merge test keeps the stronger rule and archives the weaker.
  fs.mkdirSync(path.join(tempDir, 'learning'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'learning', 'pending_lessons.json'), JSON.stringify([{
    id: 'rule-1',
    type: 'auto_update',
    status: 'applied',
    sessionId: 's1',
    entryId: 'e1',
    entryTitle: 'Typecheck discipline',
    summary: 'Always verify before finishing.',
    action: 'Always run the typecheck after editing source files.',
    createdAt: Date.now() - 3600000,
    appliedAt: Date.now() - 3500000,
    timesUsed: 3,
    successCount: 3,
    failureCount: 0,
    confidence: 0.8,
    feedback: [],
    target: 'AGENTS.md',
    sectionTitle: 'Rules',
    lines: ['Always run the typecheck after editing source files.']
  }, {
    id: 'rule-2',
    type: 'auto_update',
    status: 'pending',
    sessionId: 's1',
    entryId: 'e2',
    entryTitle: 'Typecheck discipline (draft)',
    summary: 'Verify before finishing.',
    action: 'Always run the typecheck after editing source files.',
    createdAt: Date.now() - 1000,
    timesUsed: 0,
    successCount: 0,
    failureCount: 0,
    confidence: 0.5,
    feedback: [],
    target: 'AGENTS.md',
    sectionTitle: 'Rules',
    lines: ['Always run the typecheck after editing source files.']
  }]));

  const learning = new LearningManager(
    () => ({ id: 'stub', name: 'Stub', generate: async () => ({ content: '{}' }) }) as any,
    memory
  );

  // A completed task with outcome evidence + a current tracking task.
  const current = await taskEngine.create({
    goal: 'Fix the memory retrieval regression',
    kind: 'delegation',
    sessionId: 's1'
  });
  const done = await taskEngine.create({
    goal: 'Unify memory retrieval scoring',
    kind: 'delegation',
    sessionId: 's1'
  });

  // Move 2: episodic capture subscribes to terminal TaskEvents BEFORE the
  // tasks finish, so completion/failure events become episodes.
  const capture = new EpisodicCapture(taskEngine, { bus: taskEventBus });

  await taskEngine.analyze(done.id);
  await taskEngine.plan(done.id);
  await taskEngine.complete(done.id, {
    status: 'SUCCESS',
    summary: 'Retrieval now ranks by relevance, recency and importance.',
    result: { summary: 'Retrieval now ranks by relevance, recency and importance.', status: 'completed', finalOutput: 'Scoring landed.' }
  });

  // A failed task — the most valuable experience.
  const failed = await taskEngine.create({
    goal: 'Diagnose flaky integration tests',
    kind: 'delegation',
    sessionId: 's1'
  });
  await taskEngine.analyze(failed.id);
  await taskEngine.plan(failed.id);
  await taskEngine.start(failed.id);
  await taskEngine.failTask(failed.id, 'Timeout after 3 attempts');

  const taskMemory = new TaskMemory({ engine: taskEngine });
  await taskMemory.start('Fix the memory retrieval regression', 's1', ['retrieval scoring']);

  // --- the catalog --------------------------------------------------------
  const catalog = createUnifiedMemory({ memory, learning, taskEngine, taskMemory, capture });

  // 1) Model shape + adapter coverage across all three stores.
  const all = catalog.records({ sessionId: 's1' });
  assert(all.length >= 4, `expected records from all stores, got ${all.length}`);
  const first = all[0];
  for (const key of ['id', 'type', 'content', 'source', 'scope', 'importance', 'confidence', 'lifecycle', 'createdAt', 'updatedAt', 'accessCount', 'relations']) {
    assert(key in first, `MemoryRecord has field ${key}`);
  }
  assert(all.some(r => r.source === 'conversation'), 'conversation records present for s1');
  for (let i = 1; i < all.length; i += 1) {
    assert(all[i - 1].updatedAt >= all[i].updatedAt, 'records sorted newest-first');
  }

  const episodic = catalog.records({ sessionId: 's1', types: ['episodic'] });
  assert(episodic.some(r => r.content.includes('typecheck')), 'conversation message projected as episodic');
  const procedural = catalog.records({ sessionId: 's1', types: ['procedural'] });
  assert.strictEqual(procedural.length, 2, 'two procedural rules from learning store');
  assert.strictEqual(procedural.find(r => r.id === memoryRecordId('learning', 'rule-1'))?.confidence, 0.8, 'rule confidence carried through');
  assert.strictEqual(procedural.find(r => r.id === memoryRecordId('learning', 'rule-1'))?.id, memoryRecordId('learning', 'rule-1'), 'stable canonical id');
  assert(procedural.some(r => r.id === memoryRecordId('learning', 'rule-2')), 'near-duplicate rule seeded');
  const taskRecords = catalog.records({ sessionId: 's1', source: 'task' });
  assert(taskRecords.some(r => r.metadata?.taskId === done.id), 'completed task projected from TaskEngine');
  assert(taskRecords.some(r => r.type === 'working' && r.importance === 5), 'current tracking task is working memory');

  // 2) Retrieval ranking + budget + dedupe.
  const hits = catalog.retrieve('typecheck', { sessionId: 's1', limit: 3 });
  assert(hits.length <= 3, 'budget cap respected');
  assert(hits.length >= 1, 'typecheck query has hits');
  assert(hits.some(r => r.id === memoryRecordId('learning', 'rule-1')), 'procedural rule retrieved');
  assert(hits.some(r => r.content.includes('typecheck')), 'conversation typecheck message retrieved');
  const ids = hits.map(r => r.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'no duplicate ids across providers');
  for (const hit of hits) {
    assert(typeof hit.score === 'number' && hit.score > 0, 'hits carry a positive score');
    assert(typeof hit.scoreBreakdown.relevance === 'number', 'hits carry a relevance breakdown');
  }

  // The rule (importance 4 + confidence 0.8) should outrank the plain message.
  const ranked = catalog.retrieve('typecheck', { sessionId: 's1', limit: 10 });
  const ruleRank = ranked.findIndex(r => r.id === memoryRecordId('learning', 'rule-1'));
  const msgRank = ranked.findIndex(r => r.source === 'conversation' && r.content.includes('typecheck'));
  assert(ruleRank >= 0 && msgRank >= 0 && ruleRank < msgRank, 'procedural rule ranks above the raw message');

  // 3) Move 2: event-driven episodic capture.
  const episodes = capture.recent('s1');
  const capturedDone = episodes.find(e => e.metadata?.taskId === done.id);
  assert(capturedDone, 'TaskCompleted event captured as an episode');
  assert.strictEqual(capturedDone!.type, 'episodic', 'captured episode is episodic');
  assert(capturedDone!.content.includes('Retrieval now ranks'), 'episode carries the outcome summary');

  const capturedFailed = episodes.find(e => e.metadata?.taskId === failed.id);
  assert(capturedFailed, 'TaskFailed event captured as an episode');
  assert.strictEqual(capturedFailed!.importance, 4, 'failed episodes rank importance 4');
  assert(capturedFailed!.content.includes('failed'), 'episode names the failure');

  // Restart resilience: a fresh capture (no bus) seeds from the durable
  // TaskEngine store — a restarted process recalls recent episodes.
  const restarted = new EpisodicCapture(taskEngine);
  const seeded = restarted.recent('s1');
  assert(seeded.some(e => e.metadata?.taskId === done.id), 'restart-safe: episode seeded from the durable engine');
  assert(seeded.some(e => e.metadata?.taskId === failed.id), 'restart-safe: failed episode seeded too');

  // The catalog's task records now come from the capture feed (wired).
  const capturedInCatalog = catalog.records({ sessionId: 's1', source: 'task' })
    .filter(r => r.type === 'episodic' && (r.metadata?.taskId === done.id || r.metadata?.taskId === failed.id));
  assert.strictEqual(capturedInCatalog.length, 2, 'catalog exposes both captured episodes');

  // 4) Access tracking.
  const ruleId = memoryRecordId('learning', 'rule-1');
  catalog.recordAccess(ruleId);
  catalog.recordAccess(ruleId);
  const afterAccess = catalog.get(ruleId);
  assert.strictEqual(afterAccess?.accessCount, 2, 'accessCount bumped');
  assert(typeof afterAccess?.lastAccessedAt === 'number', 'lastAccessedAt stamped');

  // 5) Scorer sanity.
  assert.strictEqual(relevanceOf('typecheck source', 'run the typecheck on every source edit'), 1, 'token overlap 2/2');
  assert.strictEqual(relevanceOf('zzz-no-match', 'unrelated content'), 0, 'no overlap');

  // 6) Move 3: consolidation + lifecycle. A mutable clock makes expiry
  //    deterministic; the overlay persists to GITU_DATA_ROOT/memory (the smoke
  //    runs isolated in a temp dir, so the real store is untouched).
  const { MemoryConsolidation } = await import('../src/core/memory-unified/memory-consolidation');
  let fakeNow = Date.now();
  const consolidation = new MemoryConsolidation(catalog, { now: () => fakeNow });
  const rule1Id = memoryRecordId('learning', 'rule-1');
  const rule2Id = memoryRecordId('learning', 'rule-2');

  // Dedupe by canonical id + near-duplicate merge: rule-2 is a weaker copy of
  // rule-1, so consolidation keeps the stronger rule and archives the weaker.
  const consolidated = consolidation.consolidate('s1');
  const consolidatedIds = consolidated.map(r => r.id);
  assert.strictEqual(new Set(consolidatedIds).size, consolidatedIds.length, 'consolidate dedupes by canonical id');
  const survivor = consolidated.find(r => r.id === rule1Id);
  assert(survivor, 'stronger rule survives the merge');
  assert((survivor!.mergedFrom || []).includes(rule2Id), 'survivor records the merged-from id');
  assert(!consolidated.some(r => r.id === rule2Id), 'archived duplicate not emitted in consolidated view');
  const archivedOverlay = consolidation.overlay(rule2Id);
  assert(archivedOverlay && archivedOverlay.lifecycle === 'archived', 'weaker duplicate archived');
  assert.strictEqual(archivedOverlay.supersededBy, rule1Id, 'archived record points at its superseder');

  // Lifecycle: fresh low-importance records start candidate; repeated access
  // promotes candidate -> active (threshold 3).
  const msg1 = consolidated.find(r => r.source === 'conversation' && r.content.includes('typecheck'));
  assert(msg1 && msg1.lifecycle === 'candidate', 'fresh low-importance message starts candidate');
  consolidation.recordAccess(msg1!.id);
  consolidation.recordAccess(msg1!.id);
  consolidation.recordAccess(msg1!.id);
  const promoted = consolidation.consolidate('s1').find(r => r.id === msg1!.id);
  assert.strictEqual(promoted?.lifecycle, 'active', 'access promotes candidate to active');
  assert.strictEqual(consolidation.overlay(msg1!.id)?.accessCount, 3, 'durable access count tracked');

  // Importance promotion from success feedback: a candidate gets importance +1
  // and is promoted; confidence rises too.
  const msg2 = consolidation.consolidate('s1').find(r => r.source === 'conversation' && r.content.includes('builds cleanly'));
  assert(msg2 && msg2.lifecycle === 'candidate', 'second message starts candidate');
  consolidation.recordFeedback(msg2!.id, 'success');
  const fb = consolidation.overlay(msg2!.id);
  assert.strictEqual(fb?.importance, 2, 'success feedback raises importance by 1');
  assert.strictEqual(fb?.lifecycle, 'active', 'success feedback promotes candidate');
  assert.strictEqual(fb?.successFeedback, 1, 'success feedback counted');
  const viaFeedback = consolidation.consolidate('s1').find(r => r.id === msg2!.id);
  assert.strictEqual(viaFeedback?.importance, 2, 'promoted importance visible in consolidated view');

  // Expiry: advance the clock past the TTL — stale records (with overlays)
  // expire instead of staying active forever.
  fakeNow += 400 * 24 * 60 * 60 * 1000;
  const expired = consolidation.consolidate('s1').find(r => r.id === msg1!.id);
  assert.strictEqual(expired?.lifecycle, 'expired', 'stale record expires after TTL');

  // Persistence: the overlay survives save + reload (same data root).
  consolidation.save();
  const reloaded = new MemoryConsolidation(catalog, { now: () => fakeNow });
  assert.strictEqual(reloaded.overlay(rule2Id)?.lifecycle, 'archived', 'merge result survives save/load');
  assert.strictEqual(reloaded.overlay(msg1!.id)?.accessCount, 3, 'access count survives save/load');
  assert.strictEqual(reloaded.overlay(msg2!.id)?.importance, 2, 'feedback promotion survives save/load');

  // Retrieval through the consolidation layer excludes archived/expired.
  const retrieved = consolidation.retrieve('typecheck', { sessionId: 's1', limit: 10 });
  assert(retrieved.some(r => r.id === rule1Id), 'active rule retrieved through consolidation');
  assert(!retrieved.some(r => r.id === rule2Id), 'archived duplicate excluded from retrieval');
  assert(!retrieved.some(r => r.id === msg1!.id), 'expired record excluded from retrieval');

  // 7) Move 4: MemorySkill — canonical retrieve + delegated search paths.
  const { MemorySkill } = await import('../src/skills/memory');
  const skill = new MemorySkill(memory, { catalog, consolidation });

  // Canonical retrieve: unified records + score breakdown + filters.
  const rv = await skill.execute({ action: 'retrieve', query: 'typecheck', sessionId: 's1', limit: 10 });
  assert.strictEqual(rv.mode, 'unified', 'retrieve is the unified mode');
  assert.strictEqual(rv.filters.sessionId, 's1', 'retrieve echoes its filters');
  assert(rv.results.some((r: any) => r.id === rule1Id), 'proven rule retrieved through the skill');
  assert(rv.results.every((r: any) => r.lifecycle !== 'archived' && r.lifecycle !== 'expired'),
    'skill retrieval excludes archived/expired (consolidation applied)');
  for (const r of rv.results) {
    assert(typeof r.score === 'number' && r.score > 0, 'skill results carry a positive score');
    for (const key of ['relevance', 'semantic', 'lexical', 'recency', 'importance', 'confidence', 'access']) {
      assert(key in r.scoreBreakdown, `scoreBreakdown exposes ${key}`);
    }
    assert(typeof r.id === 'string' && typeof r.type === 'string' && typeof r.source === 'string',
      'skill results carry the unified record fields');
  }
  const rvSemantic = rv.results.find((r: any) => r.id === rule1Id).scoreBreakdown.semantic;
  assert(rvSemantic === undefined && typeof rv.results[0].scoreBreakdown.lexical === 'number',
    'lexical relevance used when the source store has no semantic score');

  // Filters: source / types / minScore / taskId.
  const bySource = await skill.execute({ action: 'retrieve', query: 'typecheck', source: 'learning', limit: 10 });
  assert(bySource.results.length >= 1 && bySource.results.every((r: any) => r.source === 'learning'),
    'source filter restricts results');
  const byType = await skill.execute({ action: 'retrieve', query: 'relevance', sessionId: 's1', types: ['procedural'], limit: 10 });
  assert(byType.results.length >= 1 && byType.results.every((r: any) => r.type === 'procedural'),
    'types filter restricts results');
  const byScore = await skill.execute({ action: 'retrieve', query: 'typecheck', sessionId: 's1', minScore: 0.9, limit: 10 });
  assert(byScore.results.every((r: any) => r.score >= 0.9), 'minScore filter applied');
  const byTask = await skill.execute({ action: 'retrieve', query: 'relevance', sessionId: 's1', taskId: done.id, limit: 10 });
  assert(byTask.results.length >= 1 && byTask.results.every((r: any) => r.metadata?.taskId === done.id),
    'taskId filter restricts results to one canonical task');

  // search delegates to the unified path, legacy row shape preserved.
  const kw = await skill.execute({ action: 'search', query: 'typecheck', sessionId: 's1' });
  assert.strictEqual(kw.mode, 'keyword', 'search keeps its keyword mode');
  assert.strictEqual(kw.unified, true, 'search delegates to the unified path');
  assert(kw.results.length >= 1, 'search returns hits');
  assert(kw.results.some((r: any) => String(r.content).includes('typecheck')), 'search rows carry content');
  for (const r of kw.results) {
    assert(typeof r.timestamp === 'string' && !Number.isNaN(Date.parse(r.timestamp)), 'search rows carry a timestamp');
    assert('content' in r && 'role' in r, 'search rows keep the legacy shape');
  }

  // semantic_search is a thin delegate; no embeddings in the smoke -> lexical.
  const sem = await skill.execute({ action: 'semantic_search', query: 'typecheck', sessionId: 's1' });
  assert.strictEqual(sem.mode, 'lexical', 'semantic_search reports lexical mode without embeddings');
  assert(typeof sem.reason === 'string', 'semantic_search explains its mode');
  assert(sem.results.length >= 1 && typeof sem.results[0].score === 'number', 'semantic_search rows carry a score');

  // Standalone fallback: without a unified layer, search uses MemoryManager.
  const bare = new MemorySkill(memory);
  const legacy = await bare.execute({ action: 'search', query: 'typecheck' });
  assert.strictEqual(legacy.mode, 'keyword', 'bare skill keeps the legacy keyword path');
  assert(legacy.results.length >= 1 && legacy.results.some((r: any) => String(r.content).includes('typecheck')),
    'bare skill searches the conversation store');

  // 8) Move 5: terminal Tasks -> self-review -> approval -> restart-recall.
  //    Enable the learning pipeline via config.json in the isolated cwd; the
  //    review stub returns a lesson payload so no real model is needed.
  fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify({
    learning: { enabled: true, selfReview: { enabled: true }, autoUpdate: { enabled: true }, approval: { enabled: true } }
  }));
  fs.writeFileSync(path.join(tempDir, 'USER.md'), '# USER.md\n');

  const { TaskLessonBridge } = await import('../src/core/memory-unified/lesson-capture');
  const reviewStub = () => ({
    id: 'stub-review',
    name: 'Stub-Review',
    generate: async () => ({ content: JSON.stringify({
      issueSummary: 'Retrieval changed without a regression guard',
      improvements: ['Always add a retrieval regression assertion when changing scoring'],
      lesson: 'Verify retrieval changes with a smoke assertion'
    }) })
  }) as any;
  const lessonLearning = new LearningManager(reviewStub, memory);

  // A NEW terminal task fires its event AFTER the bridge subscribes.
  const lessonTask = await taskEngine.create({ goal: 'Add retrieval regression coverage', kind: 'delegation', sessionId: 's1' });
  const lessonBridge = new TaskLessonBridge(taskEngine, lessonLearning, { bus: taskEventBus });
  await taskEngine.analyze(lessonTask.id);
  await taskEngine.plan(lessonTask.id);
  await taskEngine.complete(lessonTask.id, {
    status: 'SUCCESS',
    summary: 'Added a regression assertion for retrieval scoring.',
    result: { summary: 'Added a regression assertion for retrieval scoring.', status: 'completed' }
  });

  // The bridge queued a self-review for the terminal task outcome.
  const queuedReviews = JSON.parse(fs.readFileSync(path.join(tempDir, 'learning', 'pending_reviews.json'), 'utf-8'));
  const taskReview = Array.isArray(queuedReviews) ? queuedReviews.find((r: any) => r.taskId === lessonTask.id) : undefined;
  assert(taskReview, 'terminal task queued a self-review');
  assert.strictEqual(taskReview.origin, 'task', 'review carries the task origin');

  // tick() extracts a lesson through the review pipeline -> pending action.
  await lessonLearning.tick();
  const lessonAction = lessonLearning.listPendingLearningActions('s1')
    .find(a => a.entryTitle.includes('Task self-review'));
  assert(lessonAction, 'review produced a pending lesson');
  assert(String(lessonAction.action).includes('retrieval regression'), 'lesson content from the review');

  // Approval pipeline: approve -> applied -> retrievable memory record.
  const approved = lessonLearning.approvePendingLearningAction(lessonAction.id, 's1');
  assert(approved.success, 'lesson approved through the existing pipeline');
  const appliedAction = lessonLearning.listPendingLearningActions('s1', true).find(a => a.id === lessonAction.id);
  assert.strictEqual(appliedAction?.status, 'applied', 'lesson applied');

  // Live exposure: a catalog over the lesson store sees the applied lesson.
  const liveLessonCatalog = createUnifiedMemory({ memory, learning: lessonLearning, taskEngine, capture });
  const lessonRuleId = memoryRecordId('learning', lessonAction.id);
  const liveRule = liveLessonCatalog.records({ sessionId: 's1', types: ['procedural'] }).find(r => r.id === lessonRuleId);
  assert(liveRule, 'approved lesson projects into the unified catalog');
  assert.strictEqual(liveRule!.importance, 4, 'applied lesson ranks importance 4');

  // 8b) Phase 20 Move 6 — GOAL-level retrospective: when the last linked task
  //     of an auto-completed goal finishes, a review spanning the goal's task
  //     set is queued and its lesson links to the goal id. A FRESH manager
  //     over the same data root processes it (the task review already set the
  //     per-session review rate limit).
  // A distinct session sidesteps the per-session review rate limit the task
  // review's tick already set in the shared learning state.
  const goalLearning = new LearningManager(reviewStub, memory);
  const goalId = 'goal-retro-1';
  const goalSession = 's1-goal';
  const queued = goalLearning.queueGoalReview({
    goalId,
    sessionId: goalSession,
    title: 'Ship the retrieval regression',
    objective: 'Add retrieval regression coverage and verify it.',
    status: 'completed',
    taskOutcomes: [
      { taskId: 't1', outcome: 'FAILURE', summary: 'First attempt missed the assertion.' },
      { taskId: lessonTask.id, outcome: 'SUCCESS', summary: 'Regression assertion added.', turns: 3 }
    ]
  });
  assert(queued, 'goal retrospective queued');
  const goalReview = JSON.parse(fs.readFileSync(path.join(tempDir, 'learning', 'pending_reviews.json'), 'utf-8'))
    .find((r: any) => r.origin === 'goal' && r.goalId === goalId);
  assert(goalReview, 'goal review persisted with the goal origin');
  assert.strictEqual(goalReview.goalTitle, 'Ship the retrieval regression', 'goal review carries the goal title');
  assert.strictEqual(goalReview.taskOutcomes.length, 2, 'goal review spans the full task set');

  await goalLearning.tick();
  const goalAction = goalLearning.listPendingLearningActions(goalSession)
    .find((a: any) => a.entryTitle.includes('Goal retrospective'));
  assert(goalAction, 'goal review produced a pending lesson');
  assert.strictEqual(goalAction.goalId, goalId, 'lesson carries the goal id');
  const goalApproved = goalLearning.approvePendingLearningAction(goalAction.id, goalSession);
  assert(goalApproved.success, 'goal lesson approved through the existing pipeline');
  const goalCatalog = createUnifiedMemory({ memory, learning: goalLearning, taskEngine, capture });
  const goalRuleId = memoryRecordId('learning', goalAction.id);
  const goalRule = goalCatalog.records({ sessionId: goalSession, types: ['procedural'] }).find(r => r.id === goalRuleId);
  assert(goalRule, 'goal lesson projects into the unified catalog');
  assert.strictEqual(goalRule!.metadata?.goalId, goalId, 'unified memory record links to the goal id');

  // RESTART: fresh process instances over the SAME data root — no old objects
  // remain alive. Episodes seed from the durable Task store; the lesson
  // reloads from pending_lessons.json; the overlay reloads from disk.
  const { TaskStore, defaultTaskStorePath } = await import('../src/core/task/task-store');
  const { TaskEngine: FreshTaskEngine } = await import('../src/core/task/task-engine');
  const freshEngine = new FreshTaskEngine({ store: new TaskStore({ filePath: defaultTaskStorePath() }) });
  const freshMemory = new MemoryManager();
  const restartedLearning = new LearningManager(reviewStub, freshMemory);
  const restartedCatalog = createUnifiedMemory({ memory: freshMemory, learning: restartedLearning, taskEngine: freshEngine });
  const restartedConsolidation = new MemoryConsolidation(restartedCatalog, { now: () => fakeNow });

  const restartedEpisodes = restartedCatalog.records({ sessionId: 's1', source: 'task' });
  assert(restartedEpisodes.some(r => r.metadata?.taskId === lessonTask.id),
    'episode recalled after restart (durable Task store)');
  const restartedRule = restartedCatalog.records({ sessionId: 's1', types: ['procedural'] }).find(r => r.id === lessonRuleId);
  assert(restartedRule, 'approved lesson recalled after restart (pending_lessons.json)');
  const restartHits = restartedConsolidation.retrieve('retrieval regression', { sessionId: 's1', limit: 10 });
  assert(restartHits.some(r => r.id === lessonRuleId),
    'restart retrieval finds the learned knowledge without the old process alive');

  // --- Phase 18 Move 4 — project-scoped repository knowledge (G4) -------
  // The 'project' provider registers on the catalog; index facts and
  // caller-captured conventions/failure patterns are durable per workspace
  // root and retrieved through the consolidation layer.
  const { ProjectMemoryBridge } = await import('../src/core/memory-unified/project-memory');
  const { buildPersistentIndex } = await import('../src/core/context/repo-index');
  const projData = path.join(tempDir, 'memory', 'project-memory.json');
  const bridge = new ProjectMemoryBridge({ catalog, dataPath: projData });
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gitu-proj-repo-'));
  let projFactsId = '';
  let projHits: Array<{ metadata?: Record<string, unknown> }> = [];
  let restartedBridge: any;
  try {
    fs.mkdirSync(path.join(repoRoot, 'src', 'auth'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src/auth/auth.ts'), 'export function authenticate() { return true; }\n');
    fs.writeFileSync(path.join(repoRoot, 'src/auth/auth.test.ts'), 'test("auth works", () => {});\n');
    fs.writeFileSync(path.join(repoRoot, 'tsconfig.json'), '{}\n');
    const index = buildPersistentIndex(repoRoot);
    const facts = bridge.captureIndexFacts(index);
    assert(facts, 'index facts captured');
    projFactsId = facts!.id;
    assert(facts!.content.includes('Languages:'), 'facts carry the language breakdown');
    assert(facts!.content.includes('1 test file'), 'facts carry test counts');

    const failure = bridge.capture({
      workspaceRoot: repoRoot,
      kind: 'failure',
      title: 'Known failure: flaky auth test',
      content: 'The auth test flakes under load; rerun before blaming the fix.',
      origin: 'lesson',
      importance: 4,
      confidence: 0.8
    });

    // The 'project' provider is live on the unified catalog.
    const projectRecords = catalog.records({ source: 'project' });
    assert(projectRecords.some(r => r.id === `project:${projFactsId}`), 'index facts reach the catalog');
    assert(projectRecords.some(r => r.id === `project:${failure.id}`), 'captured knowledge reaches the catalog');

    // Retrieval through the consolidation layer, scoped to the workspace
    // root. A fresh clock (not the smoke's advanced fakeNow) so the just-
    // captured records are not TTL-expired on first retrieval.
    const projectConsolidation = new MemoryConsolidation(catalog);
    projHits = bridge.retrieve(repoRoot, 'auth test flakes', { layer: projectConsolidation });
    assert(projHits.some(r => r.metadata?.title === 'Known failure: flaky auth test'), 'retrieval finds the failure pattern');
    assert(projHits.some(r => r.metadata?.title === 'Repository facts'), 'retrieval finds the architecture facts');

    // Idempotent index capture: a refresh never grows the store.
    const before = bridge.store.list(repoRoot).length;
    bridge.captureIndexFacts(index);
    assert.strictEqual(bridge.store.list(repoRoot).length, before, 'index-facts capture is idempotent');

    // Durability: a fresh bridge over the same file recalls the entries.
    restartedBridge = new ProjectMemoryBridge({ dataPath: projData });
    const recalled: Array<{ title: string }> = restartedBridge.store.list(repoRoot);
    assert(recalled.some(e => e.title === 'Repository facts'), 'project facts durable across instances');
    assert(recalled.some(e => e.title === 'Known failure: flaky auth test'), 'captured knowledge durable across instances');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }

  console.log(JSON.stringify({
    success: true,
    tempDir,
    recordCount: all.length,
    procedural: procedural.length,
    taskRecords: taskRecords.length,
    hits: hits.map(r => ({ id: r.id, score: Number(r.score.toFixed(3)) })),
    accessCount: afterAccess?.accessCount,
    topHit: ranked[0]?.id,
    consolidation: {
      mergedFrom: survivor?.mergedFrom,
      archived: archivedOverlay?.lifecycle,
      promotedByAccess: promoted?.lifecycle,
      promotedByFeedback: viaFeedback?.importance,
      expired: expired?.lifecycle,
      persistedArchived: reloaded.overlay(rule2Id)?.lifecycle,
      retrievedExcludesArchived: !retrieved.some(r => r.id === rule2Id)
    },
    skill: {
      retrieveMode: rv.mode,
      retrieveHits: rv.results.length,
      topHit: rv.results[0]?.id,
      searchUnified: kw.unified,
      semanticMode: sem.mode,
      bareSearchHits: legacy.results.length
    },
    lessonLoop: {
      reviewQueued: Boolean(taskReview),
      pendingLesson: lessonAction?.action,
      applied: appliedAction?.status,
      liveExposure: Boolean(liveRule),
      restartEpisode: restartedEpisodes.some(r => r.metadata?.taskId === lessonTask.id),
      restartLesson: Boolean(restartedRule),
      restartRetrieval: restartHits.some(r => r.id === lessonRuleId)
    },
    projectMemory: {
      factsCaptured: Boolean(projFactsId),
      catalogExposed: catalog.records({ source: 'project' }).length >= 2,
      retrievalScoped: projHits.some(r => r.metadata?.title === 'Known failure: flaky auth test'),
      idempotent: bridge.store.list(repoRoot).length >= 2,
      durable: restartedBridge.store.list(repoRoot).length >= 2
    }
  }, null, 2));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
