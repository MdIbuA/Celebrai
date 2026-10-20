/**
 * timeline-engine.js — deterministic task generation and status rules.
 *
 * Tasks are defined as *offsets before the event date*, never as absolute
 * dates, so regenerating after a date change is a pure recomputation.
 */

import { daysBetween, parseISODate, toISODate } from './validation.js';

export const TASK_STATUSES = ['pending', 'in-progress', 'completed', 'blocked'];
export const TASK_PRIORITIES = ['high', 'medium', 'low'];

/** Below this many days to the event, we switch to short-notice mode. */
export const SHORT_NOTICE_THRESHOLD_DAYS = 21;

/**
 * Base templates. `daysBefore` is the lead time an experienced planner would
 * want; short-notice mode compresses these proportionally.
 */
const BASE_TEMPLATES = {
  common: [
    { key: 'lock-date', title: 'Confirm date and headcount', daysBefore: 120, priority: 'high', category: null },
    { key: 'book-venue', title: 'Shortlist and book venue', daysBefore: 105, priority: 'high', category: 'venue', dependsOn: ['lock-date'] },
    { key: 'book-catering', title: 'Finalise caterer and menu', daysBefore: 75, priority: 'high', category: 'catering', dependsOn: ['book-venue'] },
    { key: 'book-decor', title: 'Confirm decor and theme execution', daysBefore: 55, priority: 'medium', category: 'decor', dependsOn: ['book-venue'] },
    { key: 'invitations', title: 'Design and send invitations', daysBefore: 45, priority: 'medium', category: 'invitations', dependsOn: ['lock-date'] },
    { key: 'rsvp-close', title: 'Close RSVPs and confirm final headcount', daysBefore: 14, priority: 'high', category: null, dependsOn: ['invitations'] },
    { key: 'final-payments', title: 'Settle vendor advance payments', daysBefore: 7, priority: 'high', category: null, dependsOn: ['book-catering', 'book-venue'] },
    { key: 'run-sheet', title: 'Circulate run-sheet to vendors and family', daysBefore: 3, priority: 'medium', category: null, dependsOn: ['final-payments'] },
    { key: 'day-before-check', title: 'Walkthrough and day-before checks', daysBefore: 1, priority: 'high', category: null, dependsOn: ['run-sheet'] },
  ],
  wedding: [
    { key: 'guest-list', title: 'Build and segment the guest list', daysBefore: 115, priority: 'high', category: null },
    { key: 'photographer', title: 'Book photographer and videographer', daysBefore: 90, priority: 'high', category: 'photography', dependsOn: ['lock-date'] },
    { key: 'attire', title: 'Order attire and schedule fittings', daysBefore: 70, priority: 'medium', category: 'attire' },
    { key: 'rituals', title: 'Confirm ritual schedule with officiant/elders', daysBefore: 60, priority: 'high', category: null },
    { key: 'transport', title: 'Arrange guest transport and accommodation', daysBefore: 35, priority: 'medium', category: 'transport', dependsOn: ['rsvp-close'] },
    { key: 'sangeet', title: 'Plan pre-event functions', daysBefore: 30, priority: 'low', category: 'music' },
  ],
  birthday: [
    { key: 'cake', title: 'Order cake and confirm dietary variants', daysBefore: 20, priority: 'high', category: 'catering' },
    { key: 'entertainment', title: 'Book entertainment or activity host', daysBefore: 35, priority: 'medium', category: 'entertainment', dependsOn: ['book-venue'] },
    { key: 'favours', title: 'Arrange return gifts/favours', daysBefore: 14, priority: 'low', category: 'invitations' },
  ],
  engagement: [
    { key: 'photographer', title: 'Book photographer', daysBefore: 60, priority: 'high', category: 'photography', dependsOn: ['lock-date'] },
    { key: 'ring-attire', title: 'Confirm rings and attire', daysBefore: 40, priority: 'high', category: 'attire' },
    { key: 'families', title: 'Align both families on ritual order', daysBefore: 30, priority: 'high', category: null },
  ],
  college: [
    { key: 'permissions', title: 'Obtain college permissions and venue booking', daysBefore: 60, priority: 'high', category: 'venue' },
    { key: 'sponsors', title: 'Approach sponsors and confirm commitments', daysBefore: 50, priority: 'high', category: null },
    { key: 'speakers', title: 'Confirm speakers / performers', daysBefore: 40, priority: 'high', category: 'speakers', dependsOn: ['permissions'] },
    { key: 'publicity', title: 'Launch publicity and registrations', daysBefore: 25, priority: 'medium', category: 'marketing', dependsOn: ['speakers'] },
    { key: 'tech-check', title: 'Stage, audio and projector technical check', daysBefore: 2, priority: 'high', category: 'music', dependsOn: ['permissions'] },
  ],
  community: [
    { key: 'permits', title: 'Apply for civic permits and police intimation', daysBefore: 50, priority: 'high', category: 'venue' },
    { key: 'volunteers', title: 'Recruit and brief volunteers', daysBefore: 30, priority: 'high', category: 'volunteers' },
    { key: 'safety', title: 'Arrange first-aid, water and crowd safety plan', daysBefore: 14, priority: 'high', category: 'volunteers', dependsOn: ['volunteers'] },
    { key: 'waste', title: 'Plan waste management and clean-up crew', daysBefore: 10, priority: 'medium', category: null },
  ],
};

let idCounter = 0;
export function makeTaskId(prefix = 'task') {
  idCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${rand}`;
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Generate the task list for an event.
 *
 * @param {{category:string, date:string}} event
 * @param {{today?: Date, extraTasks?: Array}} opts
 *   extraTasks: validated AI suggestions ({title, description, daysBefore, priority, budgetCategory})
 */
export function generateTimeline(event, opts = {}) {
  const today = opts.today ? new Date(opts.today) : new Date();
  const eventDate = parseISODate(event.date);
  if (!eventDate) {
    return { tasks: [], mode: 'invalid', daysUntilEvent: null, notes: ['Event date is invalid; no timeline generated.'] };
  }

  const daysUntilEvent = daysBetween(today, eventDate);
  const notes = [];

  const templates = [
    ...BASE_TEMPLATES.common,
    ...(BASE_TEMPLATES[event.category] ?? []),
  ];

  let mode = 'standard';
  let compress = 1;
  if (daysUntilEvent < 0) {
    mode = 'past';
    notes.push(`The event date is ${Math.abs(daysUntilEvent)} day(s) in the past. Every task is shown as overdue — change the date if this was a typo.`);
  } else if (daysUntilEvent <= SHORT_NOTICE_THRESHOLD_DAYS) {
    mode = 'short-notice';
    // Compress lead times into the window we actually have, keeping order.
    const longest = Math.max(...templates.map((t) => t.daysBefore), 1);
    compress = Math.max(daysUntilEvent, 1) / longest;
    notes.push(`Short-notice mode: ${daysUntilEvent} day(s) available, so lead times are compressed. Expect reduced vendor choice and premium pricing.`);
  }

  const keyToId = new Map();
  const tasks = templates.map((t) => {
    const effectiveDaysBefore = mode === 'short-notice'
      ? Math.min(daysUntilEvent, Math.max(0, Math.round(t.daysBefore * compress)))
      : t.daysBefore;
    const deadline = addDays(eventDate, -effectiveDaysBefore);
    const id = makeTaskId(t.key);
    keyToId.set(t.key, id);
    return {
      id,
      templateKey: t.key,
      title: t.title,
      description: t.description ?? '',
      deadline: toISODate(deadline),
      daysBefore: effectiveDaysBefore,
      priority: t.priority,
      status: 'pending',
      dependsOn: t.dependsOn ?? [],
      budgetCategory: t.category,
      source: 'template',
    };
  });

  // Resolve dependency template keys -> real ids.
  for (const task of tasks) {
    task.dependsOn = task.dependsOn.map((k) => keyToId.get(k)).filter(Boolean);
  }

  // Append validated AI suggestions, clearly marked.
  for (const extra of opts.extraTasks ?? []) {
    const daysBefore = mode === 'short-notice'
      ? Math.min(daysUntilEvent, Math.max(0, Math.round(extra.daysBefore * compress)))
      : extra.daysBefore;
    tasks.push({
      id: makeTaskId('ai'),
      templateKey: null,
      title: extra.title,
      description: extra.description ?? '',
      deadline: toISODate(addDays(eventDate, -daysBefore)),
      daysBefore,
      priority: TASK_PRIORITIES.includes(extra.priority) ? extra.priority : 'medium',
      status: 'pending',
      dependsOn: [],
      budgetCategory: extra.budgetCategory ?? null,
      source: 'ai-suggested',
    });
  }

  tasks.sort((a, b) => a.deadline.localeCompare(b.deadline) || a.title.localeCompare(b.title));
  return { tasks, mode, daysUntilEvent, notes };
}

/** Recompute deadlines when the event date moves, preserving statuses. */
export function rescheduleTimeline(tasks, { newEventDate, today = new Date() }) {
  const eventDate = parseISODate(newEventDate);
  if (!eventDate) throw new RangeError('New event date is invalid.');
  const daysUntilEvent = daysBetween(new Date(today), eventDate);

  const updated = tasks.map((t) => {
    const daysBefore = daysUntilEvent >= 0 ? Math.min(t.daysBefore, Math.max(daysUntilEvent, 0)) : t.daysBefore;
    return { ...t, daysBefore, deadline: toISODate(addDays(eventDate, -daysBefore)) };
  });
  updated.sort((a, b) => a.deadline.localeCompare(b.deadline));
  return { tasks: updated, daysUntilEvent };
}

/**
 * Derive live status for each task.
 * A task is *blocked* when any dependency is not completed. Blocking is
 * derived, not stored, so completing a dependency unblocks automatically.
 */
export function annotateTasks(tasks, { today = new Date() } = {}) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const now = new Date(today);

  return tasks.map((t) => {
    const deadline = parseISODate(t.deadline);
    const daysRemaining = deadline ? daysBetween(now, deadline) : null;
    const unmetDependencies = (t.dependsOn ?? [])
      .map((id) => byId.get(id))
      .filter((dep) => dep && dep.status !== 'completed');

    let effectiveStatus = t.status;
    if (t.status !== 'completed' && unmetDependencies.length > 0) {
      effectiveStatus = 'blocked';
    }

    const overdue = t.status !== 'completed' && daysRemaining !== null && daysRemaining < 0;

    return {
      ...t,
      effectiveStatus,
      overdue,
      daysRemaining,
      unmetDependencies: unmetDependencies.map((d) => ({ id: d.id, title: d.title })),
    };
  });
}

export function timelineProgress(tasks) {
  const total = tasks.length;
  if (total === 0) {
    return { total: 0, completed: 0, overdue: 0, blocked: 0, percentComplete: 0 };
  }
  const annotated = annotateTasks(tasks);
  const completed = annotated.filter((t) => t.status === 'completed').length;
  const overdue = annotated.filter((t) => t.overdue).length;
  const blocked = annotated.filter((t) => t.effectiveStatus === 'blocked').length;
  return {
    total,
    completed,
    overdue,
    blocked,
    percentComplete: Math.round((completed / total) * 100),
  };
}

export function setTaskStatus(tasks, taskId, status) {
  if (!TASK_STATUSES.includes(status)) {
    throw new RangeError(`Unknown task status: ${status}`);
  }
  return tasks.map((t) => (t.id === taskId ? { ...t, status } : t));
}

export function upcomingDeadlines(tasks, { today = new Date(), limit = 5 } = {}) {
  return annotateTasks(tasks, { today })
    .filter((t) => t.status !== 'completed')
    .sort((a, b) => {
      // Overdue first, then nearest deadline.
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      return (a.daysRemaining ?? 0) - (b.daysRemaining ?? 0);
    })
    .slice(0, limit);
}
