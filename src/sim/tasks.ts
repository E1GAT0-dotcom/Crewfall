// Task lists. Pure TypeScript.
// Each crew member gets: the game's common task(s) (same for everyone), plus their own long and
// short tasks drawn at random. Impostors get a fake list built the same way (SPEC 4.1).

import type { GameMap, TaskSpot } from './map';
import type { Rng } from './rng';

export type TaskKind = 'common' | 'long' | 'short';

/** Task types by kind (SPEC 7.1). fix_wiring is multi-stage: three panels in three rooms. */
export const TASK_TYPES: Record<TaskKind, readonly string[]> = {
  common: ['fix_wiring', 'swipe_card'],
  long: ['upload_data', 'fuel_engines'],
  short: ['clear_asteroids', 'empty_chute', 'align_dish', 'calibrate_power'],
};

export const VISUAL_TASKS: ReadonlySet<string> = new Set(['clear_asteroids', 'empty_chute']);

export const TASK_LABELS: Record<string, string> = {
  fix_wiring: 'Fix Wiring',
  swipe_card: 'Swipe Card',
  upload_data: 'Upload Data',
  fuel_engines: 'Fuel Engines',
  clear_asteroids: 'Clear Asteroids',
  empty_chute: 'Empty Chute',
  align_dish: 'Align Dish',
  calibrate_power: 'Calibrate Power',
};

export interface TaskStage {
  readonly spotId: string;
  done: boolean;
}

export interface Task {
  readonly id: string;
  readonly type: string;
  readonly kind: TaskKind;
  /** Stages in the order they must be done. Single-stage tasks have one. */
  readonly stages: TaskStage[];
}

export interface TaskCounts {
  common: number;
  long: number;
  short: number;
}

/** Chooses which common task type(s) the whole crew shares this game. */
export function chooseCommonTypes(rng: Rng, count: number): string[] {
  return rng.shuffle(TASK_TYPES.common).slice(0, Math.min(count, TASK_TYPES.common.length));
}

/**
 * Builds one unit's task list. `commonTypes` is shared by everyone; long and short types are drawn
 * per unit. If more tasks are asked for than there are types, types repeat at different spots.
 */
export function buildTaskList(map: GameMap, rng: Rng, commonTypes: readonly string[], counts: TaskCounts, unitId: number): Task[] {
  const tasks: Task[] = [];
  const usedSpots = new Set<string>();
  let n = 0;
  const add = (type: string, kind: TaskKind) => {
    const stages = stagesFor(map, rng, type, usedSpots);
    if (stages.length === 0) return;
    for (const s of stages) usedSpots.add(s.spotId);
    tasks.push({ id: `u${unitId}-t${n++}`, type, kind, stages });
  };
  for (const type of commonTypes) add(type, 'common');
  for (const type of drawTypes(rng, TASK_TYPES.long, counts.long)) add(type, 'long');
  for (const type of drawTypes(rng, TASK_TYPES.short, counts.short)) add(type, 'short');
  return tasks;
}

/** Draws `count` types: all distinct while possible, then repeats. */
function drawTypes(rng: Rng, types: readonly string[], count: number): string[] {
  const out: string[] = [];
  while (out.length < count && types.length > 0) {
    const remaining = count - out.length;
    const batch = rng.shuffle(types).slice(0, Math.min(remaining, types.length));
    out.push(...batch);
  }
  return out;
}

function stagesFor(map: GameMap, rng: Rng, type: string, usedSpots: ReadonlySet<string>): TaskStage[] {
  const spots = map.tasks.filter((t) => t.task === type);
  const fresh = (list: TaskSpot[]) => {
    const unused = list.filter((s) => !usedSpots.has(s.id));
    return unused.length > 0 ? unused : list;
  };
  if (type === 'fix_wiring') {
    // Three panels, three different rooms, in a random order.
    const byRoom = new Map<string, TaskSpot[]>();
    for (const s of spots) byRoom.set(s.room, [...(byRoom.get(s.room) ?? []), s]);
    const rooms = rng.shuffle([...byRoom.keys()]).slice(0, 3);
    return rooms.map((room) => ({ spotId: rng.pick(byRoom.get(room) as TaskSpot[]).id, done: false }));
  }
  const stage1 = spots.filter((s) => s.stage === 1);
  const stage2 = spots.filter((s) => s.stage === 2);
  if (stage1.length > 0 && stage2.length > 0) {
    return [
      { spotId: rng.pick(fresh(stage1)).id, done: false },
      { spotId: rng.pick(fresh(stage2)).id, done: false },
    ];
  }
  if (spots.length === 0) return [];
  return [{ spotId: rng.pick(fresh(spots)).id, done: false }];
}

export function taskComplete(task: Task): boolean {
  return task.stages.every((s) => s.done);
}

/** The next stage to do, or null when the task is finished. */
export function nextStage(task: Task): TaskStage | null {
  return task.stages.find((s) => !s.done) ?? null;
}

export function countStages(tasks: readonly Task[]): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const t of tasks) {
    for (const s of t.stages) {
      total++;
      if (s.done) done++;
    }
  }
  return { done, total };
}
