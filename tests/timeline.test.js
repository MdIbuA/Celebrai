import { describe, it, assert } from './runner.js';
import {
  generateTimeline, annotateTasks, setTaskStatus, timelineProgress,
  rescheduleTimeline, upcomingDeadlines, SHORT_NOTICE_THRESHOLD_DAYS,
} from '../js/timeline-engine.js';
import { validateEvent, parseISODate, daysBetween } from '../js/validation.js';

const TODAY = new Date(Date.UTC(2026, 9, 20)); // 2026-10-20

function eventOn(dateISO, category = 'wedding') {
  return { category, date: dateISO, name: 'Test', location: 'Coimbatore', guestCount: 100, budget: 500000 };
}

describe('date validation', () => {
  it('rejects impossible calendar dates', () => {
    assert.equal(parseISODate('2026-02-30'), null);
    assert.equal(parseISODate('2026-13-01'), null);
    assert.equal(parseISODate('20-10-2026'), null);
    assert.ok(parseISODate('2026-02-28') instanceof Date);
  });

  it('accepts a leap day in a leap year and rejects it otherwise', () => {
    assert.ok(parseISODate('2028-02-29'));
    assert.equal(parseISODate('2026-02-29'), null);
  });

  it('flags an event scheduled in the past as a warning, not a hard failure', () => {
    const res = validateEvent(
      { ...eventOn('2026-01-01'), reservePercent: 10 },
      { today: TODAY },
    );
    assert.ok(res.ok, 'past dates are allowed but warned about');
    assert.ok(res.warnings.some((w) => w.code === 'past-date'));
  });

  it('flags short-notice events', () => {
    const res = validateEvent({ ...eventOn('2026-10-27') }, { today: TODAY });
    assert.ok(res.warnings.some((w) => w.code === 'short-notice'));
  });

  it('rejects a negative guest count and a zero budget', () => {
    const res = validateEvent({ ...eventOn('2026-12-01'), guestCount: -3, budget: 0 }, { today: TODAY });
    assert.ok(!res.ok);
    assert.ok(res.errors.guestCount);
    assert.ok(res.errors.budget);
  });

  it('warns on zero guests rather than blocking', () => {
    const res = validateEvent({ ...eventOn('2026-12-01'), guestCount: 0 }, { today: TODAY });
    assert.ok(res.ok);
    assert.ok(res.warnings.some((w) => w.code === 'zero-guests'));
  });
});

describe('timeline generation', () => {
  it('places every task on or before the event date', () => {
    const { tasks, mode } = generateTimeline(eventOn('2027-06-12'), { today: TODAY });
    assert.equal(mode, 'standard');
    assert.ok(tasks.length > 8, `expected a real timeline, got ${tasks.length}`);
    for (const t of tasks) {
      assert.ok(t.deadline <= '2027-06-12', `${t.title} must not be after the event`);
      assert.ok(t.id && t.title && t.priority && t.status, 'task shape complete');
    }
  });

  it('includes category-specific tasks', () => {
    const college = generateTimeline(eventOn('2027-03-01', 'college'), { today: TODAY });
    assert.ok(college.tasks.some((t) => t.templateKey === 'permissions'));
    const wedding = generateTimeline(eventOn('2027-03-01', 'wedding'), { today: TODAY });
    assert.ok(wedding.tasks.some((t) => t.templateKey === 'rituals'));
  });

  it('compresses lead times in short-notice mode', () => {
    const soon = generateTimeline(eventOn('2026-10-30'), { today: TODAY });
    assert.equal(soon.mode, 'short-notice');
    const daysAvailable = daysBetween(TODAY, parseISODate('2026-10-30'));
    assert.ok(daysAvailable <= SHORT_NOTICE_THRESHOLD_DAYS);
    for (const t of soon.tasks) {
      assert.ok(t.daysBefore <= daysAvailable, `${t.title} compressed into the available window`);
      assert.ok(t.deadline >= '2026-10-20', 'no deadline before today');
    }
    assert.ok(soon.notes.some((n) => n.includes('Short-notice')));
  });

  it('marks a past event and still produces tasks', () => {
    const past = generateTimeline(eventOn('2026-09-01'), { today: TODAY });
    assert.equal(past.mode, 'past');
    const annotated = annotateTasks(past.tasks, { today: TODAY });
    assert.ok(annotated.every((t) => t.overdue), 'every task on a past event is overdue');
  });

  it('returns an empty timeline for an invalid date instead of throwing', () => {
    const bad = generateTimeline(eventOn('not-a-date'), { today: TODAY });
    assert.equal(bad.mode, 'invalid');
    assert.equal(bad.tasks.length, 0);
  });

  it('appends validated AI-suggested tasks with a distinct source', () => {
    const { tasks } = generateTimeline(eventOn('2027-06-12'), {
      today: TODAY,
      extraTasks: [{ title: 'Book mehendi artist', daysBefore: 30, priority: 'medium', budgetCategory: 'decor' }],
    });
    const ai = tasks.find((t) => t.source === 'ai-suggested');
    assert.ok(ai, 'AI task present');
    assert.equal(ai.title, 'Book mehendi artist');
  });
});

describe('task status and dependencies', () => {
  it('derives blocked status from unmet dependencies', () => {
    const { tasks } = generateTimeline(eventOn('2027-06-12'), { today: TODAY });
    const venue = tasks.find((t) => t.templateKey === 'book-venue');
    const catering = tasks.find((t) => t.templateKey === 'book-catering');
    assert.ok(catering.dependsOn.includes(venue.id), 'catering depends on venue');

    let annotated = annotateTasks(tasks, { today: TODAY });
    assert.equal(annotated.find((t) => t.id === catering.id).effectiveStatus, 'blocked');

    const afterVenue = setTaskStatus(tasks, venue.id, 'completed');
    annotated = annotateTasks(afterVenue, { today: TODAY });
    assert.equal(annotated.find((t) => t.id === catering.id).effectiveStatus, 'pending', 'unblocks automatically');
  });

  it('rejects unknown statuses', () => {
    const { tasks } = generateTimeline(eventOn('2027-06-12'), { today: TODAY });
    assert.throws(() => setTaskStatus(tasks, tasks[0].id, 'almost-done'));
  });

  it('a completed task is never reported overdue', () => {
    const { tasks } = generateTimeline(eventOn('2026-09-01'), { today: TODAY });
    const done = setTaskStatus(tasks, tasks[0].id, 'completed');
    const annotated = annotateTasks(done, { today: TODAY });
    assert.equal(annotated.find((t) => t.id === tasks[0].id).overdue, false);
  });

  it('computes progress counts', () => {
    const { tasks } = generateTimeline(eventOn('2027-06-12'), { today: TODAY });
    const updated = setTaskStatus(tasks, tasks[0].id, 'completed');
    const p = timelineProgress(updated);
    assert.equal(p.total, tasks.length);
    assert.equal(p.completed, 1);
    assert.equal(p.percentComplete, Math.round((1 / tasks.length) * 100));
  });

  it('surfaces overdue items first in upcoming deadlines', () => {
    const { tasks } = generateTimeline(eventOn('2026-11-15'), { today: TODAY });
    const upcoming = upcomingDeadlines(tasks, { today: TODAY, limit: 5 });
    assert.ok(upcoming.length > 0);
    const firstOverdueIndex = upcoming.findIndex((t) => t.overdue);
    const lastOverdueIndex = upcoming.map((t) => t.overdue).lastIndexOf(true);
    if (firstOverdueIndex !== -1) {
      assert.equal(firstOverdueIndex, 0, 'overdue sorted to the top');
      assert.ok(lastOverdueIndex < upcoming.findIndex((t) => !t.overdue) || upcoming.every((t) => t.overdue));
    }
  });

  it('reschedules deadlines when the event date moves, keeping statuses', () => {
    const { tasks } = generateTimeline(eventOn('2027-06-12'), { today: TODAY });
    const marked = setTaskStatus(tasks, tasks[0].id, 'in-progress');
    const { tasks: moved } = rescheduleTimeline(marked, { newEventDate: '2027-08-12', today: TODAY });
    assert.equal(moved.find((t) => t.id === tasks[0].id).status, 'in-progress', 'status preserved');
    for (const t of moved) assert.ok(t.deadline <= '2027-08-12');
    // Every deadline must shift by exactly the same number of days as the event.
    const shift = daysBetween(parseISODate('2027-06-12'), parseISODate('2027-08-12'));
    for (const before of marked) {
      const after = moved.find((t) => t.id === before.id);
      assert.equal(
        daysBetween(parseISODate(before.deadline), parseISODate(after.deadline)),
        shift,
        `${before.title} must shift by ${shift} days`,
      );
    }
  });

  it('rejects an invalid reschedule date', () => {
    const { tasks } = generateTimeline(eventOn('2027-06-12'), { today: TODAY });
    assert.throws(() => rescheduleTimeline(tasks, { newEventDate: '2027-02-31', today: TODAY }));
  });
});
